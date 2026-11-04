import { randomUUID } from "node:crypto";
import type { Config } from "../config/schema";
import { SOL_MINT, USDC_MINT } from "../config/load";
import { DEX_PROGRAM, PROGRAMS } from "../chain/programs";
import { json } from "../db/db";
import type { Store } from "../db/store";
import { logger } from "../lib/log";
import {
  binIdFromPrice,
  binsForRangePct,
  composition,
  createPosition,
  removeLiquidity,
  type DlmmPositionModel,
} from "../positions/dlmmModel";
import type { PoolState, PoolStateSource, PriceSource } from "../positions/market";
import { IllegalTransitionError, transition } from "../proposals/lifecycle";
import type { JupiterLike } from "../screener/sources/index";
import type { Position, Proposal, Strategy } from "../types";
import { inspectPlan, walletDeltas, type PlannedInstruction, type Transfer, type TxPlan } from "./plan";

const log = logger("executor");

const BASE_FEE_LAMPORTS = 5_000;
const LAMPORTS = 1e9;
const EXIT_ACTIONS = new Set(["FULL_EXIT", "PARTIAL_EXIT", "CLAIM_FEES", "SWAP_TO_BASE"]);

export interface ExecutorDeps {
  pools: PoolStateSource;
  prices: PriceSource;
  jupiter: JupiterLike;
}

export type ExecOutcome =
  | { status: "DONE"; executionId: number; signature: string }
  | { status: "SENT_BACK"; reason: string }
  | { status: "FAILED" | "ABORTED"; reason: string }
  | { status: "SKIPPED"; reason: string };

/** What the build step produced: a plan plus the effects to apply if the simulated fill is recorded. */
interface Built {
  plan: TxPlan;
  /** USD value the proposal says should move (spent for entries, received for exits). */
  expectedUsd: number;
  /** USD value the simulation moves, using live quotes. */
  simulatedUsd: number;
  slippageBps: number | null;
  warnings: string[];
  /** Applies non-balance effects (positions table). Runs inside the recording transaction. */
  apply: (txCostUsd: number) => void;
  /** Risk-adding: SOL reserve must survive. */
  addsRisk: boolean;
}

class AbortError extends Error {}
class TransientError extends Error {}

/**
 * Executor — PAPER MODE ONLY.
 *
 * Does exactly what an approved proposal says: freshness check → build plan → inspect
 * instructions → simulate balance changes → record a simulated fill. It holds no key, has no
 * RPC connection and no code path that signs or sends a transaction.
 */
export class PaperExecutor {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly deps: ExecutorDeps,
  ) {
    if (cfg.app.mode !== "paper") throw new Error("PaperExecutor only runs in paper mode");
  }

  /**
   * A crash between claiming a proposal and recording its fill leaves it EXECUTING. Paper fills
   * are recorded atomically with the DONE transition, so such a proposal never filled: fail it.
   */
  recoverStuck(olderThanMs = 10 * 60_000): number {
    let n = 0;
    for (const p of this.store.proposalsInState("EXECUTING")) {
      if (this.store.now() - p.updated_at < olderThanMs) continue;
      const ex = this.store.db.get<{ id: number; status: string }>("SELECT id, status FROM executions WHERE proposal_id = ?", [p.id]);
      if (ex?.status === "DONE") {
        transition(this.store, p.id, "DONE", { actor: "executor", note: "recovered: fill was recorded" });
      } else {
        if (ex) this.store.db.run("UPDATE executions SET status = 'FAILED', error = 'interrupted' WHERE id = ?", [ex.id]);
        transition(this.store, p.id, "FAILED", { actor: "executor", note: "interrupted before fill; not executed" });
        this.store.addReport("alert", `Execution of #${p.id} ${p.action} was interrupted and marked FAILED (nothing was filled).`);
      }
      n++;
    }
    return n;
  }

  /** Executes every proposal ready for execution, emergencies first. */
  async runOnce(): Promise<{ proposal: number; outcome: ExecOutcome }[]> {
    const ready = this.store
      .proposalsInState("RISK_APPROVED", "HUMAN_APPROVED")
      .filter((p) => p.state === "HUMAN_APPROVED" || this.store.getState(`awaiting_human:${p.id}`) !== "1");
    const out: { proposal: number; outcome: ExecOutcome }[] = [];
    for (const p of ready) out.push({ proposal: p.id, outcome: await this.execute(p.id) });
    return out;
  }

  async execute(proposalId: number): Promise<ExecOutcome> {
    const p = this.store.getProposal(proposalId);
    if (!p) return { status: "SKIPPED", reason: "not found" };
    if (p.state !== "RISK_APPROVED" && p.state !== "HUMAN_APPROVED") return { status: "SKIPPED", reason: `state ${p.state}` };
    if (this.store.isPaused() && !EXIT_ACTIONS.has(p.action)) return { status: "SKIPPED", reason: "desk paused" };

    const idem = `proposal:${p.id}`;
    const prior = this.store.db.get<{ id: number; status: string; signature: string | null }>(
      "SELECT id, status, signature FROM executions WHERE idempotency_key = ?",
      [idem],
    );
    if (prior?.status === "DONE") {
      // Already filled: never execute twice.
      transition(this.store, p.id, "EXECUTING", { actor: "executor", note: "idempotent replay" });
      transition(this.store, p.id, "DONE", { actor: "executor", note: `already executed as ${prior.signature}` });
      return { status: "DONE", executionId: prior.id, signature: prior.signature ?? "" };
    }

    // Step 1 — freshness
    let state: PoolState | null = null;
    const pool = p.pool ?? (p.position_id ? this.store.getPosition(p.position_id)?.pool : null) ?? null;
    if (pool) {
      try {
        state = await this.deps.pools.getPoolState(pool);
      } catch (e) {
        return { status: "SKIPPED", reason: `pool state unavailable: ${(e as Error).message}` };
      }
    }
    const stale = this.staleness(p, state);
    if (stale) {
      const to = p.emergency ? "PROPOSED" : "MANAGER_APPROVED";
      transition(this.store, p.id, to, { actor: "executor", note: `sent back to Risk: ${stale}` });
      return { status: "SENT_BACK", reason: stale };
    }

    // Claim the proposal (compare-and-set) and create the idempotent execution row.
    try {
      transition(this.store, p.id, "EXECUTING", { actor: "executor" });
    } catch (e) {
      if (e instanceof IllegalTransitionError) return { status: "SKIPPED", reason: e.message };
      throw e;
    }
    const now = this.store.now();
    const execId = prior
      ? (this.store.db.run("UPDATE executions SET status = 'PENDING', error = NULL WHERE id = ?", [prior.id]), prior.id)
      : this.store.db.run(
          "INSERT INTO executions (proposal_id, idempotency_key, simulated, status, created_at) VALUES (?, ?, 1, 'PENDING', ?)",
          [p.id, idem, now],
        ).lastInsertRowid;

    let built: Built | null = null;
    let lastErr = "";
    const maxTries = Math.max(1, this.cfg.risk.executor.max_retries);
    for (let attempt = 1; attempt <= maxTries && !built; attempt++) {
      this.store.db.run("UPDATE executions SET attempts = ? WHERE id = ?", [attempt, execId]);
      try {
        // Step 2 — build (with live quotes)
        const fresh = state && pool ? await this.deps.pools.getPoolState(pool) : state;
        built = await this.build(p, fresh);
      } catch (e) {
        lastErr = (e as Error).message;
        if (e instanceof AbortError) return this.fail(p, execId, "ABORTED", lastErr, null);
        if (!(e instanceof TransientError)) return this.fail(p, execId, "FAILED", lastErr, null);
        log.warn(`#${p.id} attempt ${attempt} failed: ${lastErr}`);
      }
    }
    if (!built) return this.fail(p, execId, "FAILED", `retries exhausted: ${lastErr}`, null);

    // Step 3 — inspect instructions
    const violations = inspectPlan(built.plan, {
      allowlist: new Set(this.cfg.risk.program_allowlist),
      pool,
      positions: new Set(this.store.openPositions().map((x) => x.address).concat(p.position_id ? [this.store.getPosition(p.position_id)?.address ?? ""] : [])),
      jupiterProgram: PROGRAMS.JUPITER_V6,
    });
    if (violations.length) return this.fail(p, execId, "ABORTED", `inspection: ${violations.join("; ")}`, built);

    // Step 4 — simulate: balance changes must be possible and match the proposal
    const sim = this.simulate(built);
    if (sim) return this.fail(p, execId, "ABORTED", `simulation: ${sim}`, built);

    // Steps 5–8 — paper: record a simulated fill instead of sending.
    const signature = `paper-${randomUUID()}`;
    const solUsd = (await this.deps.prices.pricesUsd([SOL_MINT])).get(SOL_MINT) ?? 0;
    const txCostUsd = built.plan.feesSol * solUsd;
    this.store.db.tx(() => {
      for (const [mint, d] of walletDeltas(built.plan)) this.store.adjustBalance(mint, d);
      this.store.adjustBalance(SOL_MINT, -built.plan.feesSol);
      built.apply(txCostUsd);
      this.store.db.run(
        `UPDATE executions SET status = 'DONE', signature = ?, plan_json = ?, expected_json = ?, simulated_json = ?,
           fees_usd = ?, slippage_bps = ?, error = ?, finished_at = ? WHERE id = ?`,
        [
          signature,
          json.str(built.plan),
          json.str({ value_usd: built.expectedUsd }),
          json.str({ value_usd: built.simulatedUsd, wallet_deltas: Object.fromEntries(walletDeltas(built.plan)) }),
          txCostUsd,
          built.slippageBps,
          built.warnings.length ? built.warnings.join("; ") : null,
          this.store.now(),
          execId,
        ],
      );
      transition(this.store, p.id, "DONE", { actor: "executor", note: `simulated fill ${signature}` });
      this.store.addReport(
        "cycle",
        `[paper] #${p.id} ${p.action} done: $${built.simulatedUsd.toFixed(2)}${built.slippageBps !== null ? `, slippage ${built.slippageBps.toFixed(0)} bps` : ""}${built.warnings.length ? ` (${built.warnings.join("; ")})` : ""}`,
      );
    });
    log.info(`#${p.id} ${p.action} simulated fill ${signature}`);
    return { status: "DONE", executionId: execId, signature };
  }

  // ------------------------------------------------------------------ steps

  private staleness(p: Proposal, state: PoolState | null): string | null {
    const now = this.store.now();
    if (p.expires_at && p.expires_at < now) return "proposal expired";
    if (state && p.ref_price && p.ref_price > 0) {
      const moved = (Math.abs(state.price - p.ref_price) / p.ref_price) * 100;
      if (moved > this.cfg.risk.executor.price_tolerance_pct) return `price moved ${moved.toFixed(2)}% since approval`;
    }
    return null;
  }

  private simulate(b: Built): string | null {
    const balances = this.store.getBalances();
    const deltas = walletDeltas(b.plan);
    deltas.set(SOL_MINT, (deltas.get(SOL_MINT) ?? 0) - b.plan.feesSol);
    for (const [mint, d] of deltas) {
      const after = (balances.get(mint) ?? 0) + d;
      if (after < -1e-9) return `insufficient ${mint}: have ${balances.get(mint) ?? 0}, need ${-d}`;
    }
    if (b.addsRisk) {
      const solAfter = (balances.get(SOL_MINT) ?? 0) + (deltas.get(SOL_MINT) ?? 0);
      if (solAfter < this.cfg.risk.portfolio.sol_reserve - 1e-9) {
        return `SOL reserve breached: ${solAfter.toFixed(4)} < ${this.cfg.risk.portfolio.sol_reserve}`;
      }
    }
    const tol = this.cfg.risk.executor.balance_tolerance_pct;
    if (b.expectedUsd > 0) {
      const diff = (Math.abs(b.simulatedUsd - b.expectedUsd) / b.expectedUsd) * 100;
      if (diff > tol) return `value mismatch: expected $${b.expectedUsd.toFixed(2)}, simulated $${b.simulatedUsd.toFixed(2)} (${diff.toFixed(2)}% > ${tol}%)`;
    }
    return null;
  }

  private async fail(p: Proposal, execId: number, status: "FAILED" | "ABORTED", reason: string, built: Built | null): Promise<ExecOutcome> {
    this.store.db.tx(() => {
      this.store.db.run(
        "UPDATE executions SET status = ?, error = ?, plan_json = ?, finished_at = ? WHERE id = ?",
        [status, reason, built ? json.str(built.plan) : null, this.store.now(), execId],
      );
      transition(this.store, p.id, "FAILED", { actor: "executor", note: reason });
      this.store.createEvent({
        type: "EXECUTION_FAILED",
        severity: p.emergency ? "critical" : "warning",
        position_id: p.position_id,
        pool: p.pool,
        details: { proposal_id: p.id, action: p.action, status, reason },
      });
      this.store.addReport("alert", `Execution ${status.toLowerCase()} for #${p.id} ${p.action}: ${reason}`);
    });
    log.error(`#${p.id} ${status}: ${reason}`);
    return { status, reason };
  }

  // ------------------------------------------------------------------ builders

  private async build(p: Proposal, state: PoolState | null): Promise<Built> {
    switch (p.action) {
      case "ENTER":
        return this.buildEnter(p, need(state, "pool state"));
      case "FULL_EXIT":
      case "PARTIAL_EXIT":
        return this.buildExit(p, need(state, "pool state"));
      case "CLAIM_FEES":
        return this.buildClaim(p, need(state, "pool state"));
      case "REBALANCE":
      case "WIDEN_RANGE":
        return this.buildRebalance(p, need(state, "pool state"));
      case "SWAP_TO_BASE":
        return this.buildSwapToBase(p);
    }
  }

  private async ctx(state: PoolState, tokenMint: string) {
    const prices = await this.deps.prices.pricesUsd([state.mintX, state.mintY, SOL_MINT]);
    const usdY = prices.get(state.mintY);
    if (!usdY) throw new TransientError(`no USD price for ${state.mintY}`);
    const usdX = state.price * usdY;
    const tokenIsX = state.mintX === tokenMint;
    const decX = this.decimals(state.mintX);
    const decY = this.decimals(state.mintY);
    return {
      usdX, usdY, tokenIsX, decX, decY,
      tokenMint,
      baseMint: tokenIsX ? state.mintY : state.mintX,
      tokenUsd: tokenIsX ? usdX : usdY,
      baseUsd: tokenIsX ? usdY : usdX,
      decToken: tokenIsX ? decX : decY,
      decBase: tokenIsX ? decY : decX,
      activeBin: binIdFromPrice(state.price, state.binStep, decX, decY),
      solUsd: prices.get(SOL_MINT) ?? 0,
    };
  }

  private fees(p: Proposal, txCount: number): Pick<TxPlan, "feesSol" | "priorityFeeLamports" | "computeUnitLimit"> {
    const prio = Math.min(p.params.priority_fee_lamports ?? 0, this.cfg.risk.trade.max_priority_fee_lamports);
    return { feesSol: (txCount * (BASE_FEE_LAMPORTS + prio)) / LAMPORTS, priorityFeeLamports: prio, computeUnitLimit: 400_000 };
  }

  /** Jupiter quote → simulated swap. Returns output in UI units and slippage vs the reference price. */
  private async swap(inMint: string, outMint: string, amountIn: number, decIn: number, decOut: number, refOutPerIn: number, slippageBps: number) {
    const raw = BigInt(Math.max(0, Math.floor(amountIn * 10 ** decIn)));
    if (raw === 0n) return { out: 0, slippageBps: 0, ix: null as PlannedInstruction | null };
    let q;
    try {
      q = await this.deps.jupiter.quote(inMint, outMint, raw, slippageBps);
    } catch (e) {
      throw new TransientError(`quote failed: ${(e as Error).message}`);
    }
    if (!q) return null;
    const out = Number(q.outAmount) / 10 ** decOut;
    const expectedOut = amountIn * refOutPerIn;
    const slip = expectedOut > 0 ? ((expectedOut - out) / expectedOut) * 10_000 : 0;
    const ix: PlannedInstruction = {
      programId: PROGRAMS.JUPITER_V6,
      kind: "jupiter.route",
      transfers: [
        { mint: inMint, amount: amountIn, from: `wallet:${inMint}`, to: "route:jupiter" },
        { mint: outMint, amount: out, from: "route:jupiter", to: `wallet:${outMint}` },
      ],
    };
    return { out, slippageBps: slip, ix };
  }

  private async buildEnter(p: Proposal, state: PoolState): Promise<Built> {
    const pool = need(this.store.getPool(state.address), "pool row");
    const tokenMint = nonBase(state.mintX, state.mintY);
    const c = await this.ctx(state, tokenMint);
    const size = need(p.params.size_usd, "size_usd");
    const strategy: Strategy = p.params.strategy ?? "spot";
    const half = binsForRangePct(p.params.range_pct ?? 10, state.binStep);
    const slippage = need(p.params.slippage_bps, "slippage_bps");

    let { model, depositX, depositY } = createPosition({
      valueY: size / c.usdY, activeBin: c.activeBin, lowerBin: c.activeBin - half, upperBin: c.activeBin + half,
      binStep: state.binStep, decimalsX: c.decX, decimalsY: c.decY, strategy, now: this.store.now(),
    });
    const needToken = c.tokenIsX ? depositX : depositY;
    const baseForSwap = (needToken * c.tokenUsd) / c.baseUsd;
    const sw = await this.swap(c.baseMint, tokenMint, baseForSwap, c.decBase, c.decToken, c.baseUsd / c.tokenUsd, slippage);
    if (!sw) throw new AbortError(`no swap route ${c.baseMint} → ${tokenMint}`);
    if (sw.slippageBps > slippage) throw new AbortError(`entry swap slippage ${sw.slippageBps.toFixed(0)} bps > ${slippage}`);
    // If the swap returned less than needed, scale the whole position down to what we got.
    const scale = needToken > 0 ? Math.min(1, sw.out / needToken) : 1;
    if (scale < 1) {
      model = { ...model, bins: model.bins.map((b) => ({ ...b, liq: b.liq * scale })) };
      depositX *= scale;
      depositY *= scale;
    }
    const depToken = c.tokenIsX ? depositX : depositY;
    const depBase = c.tokenIsX ? depositY : depositX;
    const address = `paper-${randomUUID()}`;
    const ixs: PlannedInstruction[] = [
      { programId: PROGRAMS.COMPUTE_BUDGET, kind: "setComputeUnitPrice", transfers: [] },
      ...(sw.ix ? [sw.ix] : []),
      { programId: DEX_PROGRAM[pool.dex], kind: "dlmm.initializePosition", transfers: [] },
      {
        programId: DEX_PROGRAM[pool.dex],
        kind: `dlmm.addLiquidityByStrategy:${strategy}`,
        transfers: [
          { mint: tokenMint, amount: depToken, from: `wallet:${tokenMint}`, to: `pool:${state.address}:${tokenMint}` },
          { mint: c.baseMint, amount: depBase, from: `wallet:${c.baseMint}`, to: `pool:${state.address}:${c.baseMint}` },
        ],
      },
    ];
    const plan: TxPlan = { instructions: ixs, ...this.fees(p, sw.ix ? 2 : 1) };
    // Value that leaves the wallet, net of any token dust that stays behind.
    const dust = sw.out - depToken;
    const spentUsd = (baseForSwap + depBase) * c.baseUsd - dust * c.tokenUsd;
    return {
      plan,
      expectedUsd: size,
      simulatedUsd: spentUsd,
      slippageBps: sw.slippageBps,
      warnings: scale < 1 ? [`position scaled to ${(scale * 100).toFixed(1)}% (swap shortfall)`] : [],
      addsRisk: true,
      apply: (txCostUsd) => {
        const id = this.store.insertPosition({
          address, pool: state.address, dex: pool.dex, paper: true, token_mint: tokenMint, base_mint: c.baseMint, strategy,
          lower_bin: c.activeBin - half, upper_bin: c.activeBin + half, deposit_x: depositX, deposit_y: depositY,
          deposit_usd: depositX * c.usdX + depositY * c.usdY, entry_price: state.price, model, opened_at: this.store.now(),
          // swap slippage / price impact is a cost of entering
          tx_costs_usd: txCostUsd + Math.max(0, spentUsd - (depositX * c.usdX + depositY * c.usdY)),
        });
        this.store.db.run("UPDATE proposals SET position_id = ? WHERE id = ?", [id, p.id]);
      },
    };
  }

  private async buildExit(p: Proposal, state: PoolState): Promise<Built> {
    const pos = this.openPosition(p);
    const model = need(pos.model, "position model");
    const c = await this.ctx(state, pos.token_mint);
    const full = p.action === "FULL_EXIT" || (p.params.fraction ?? 1) >= 1;
    const fraction = full ? 1 : need(p.params.fraction, "fraction");
    const removed = removeLiquidity(model, c.activeBin, fraction);
    const tokenOut = c.tokenIsX ? removed.x : removed.y;
    const baseOut = c.tokenIsX ? removed.y : removed.x;
    // Paper simplification: accrued fees are credited in the base token.
    const feesUsd = model.feesUnclaimedUsd;
    const feesBase = feesUsd / c.baseUsd;
    const posAcct = `position:${pos.address}`;
    const ixs: PlannedInstruction[] = [
      { programId: PROGRAMS.COMPUTE_BUDGET, kind: "setComputeUnitPrice", transfers: [] },
      {
        programId: DEX_PROGRAM[pos.dex],
        kind: full ? "dlmm.removeAllLiquidityAndClaim" : `dlmm.removeLiquidity:${fraction}`,
        transfers: [
          { mint: pos.token_mint, amount: tokenOut, from: posAcct, to: `wallet:${pos.token_mint}` },
          { mint: c.baseMint, amount: baseOut + feesBase, from: posAcct, to: `wallet:${c.baseMint}` },
        ],
      },
    ];
    if (full) ixs.push({ programId: DEX_PROGRAM[pos.dex], kind: "dlmm.closePosition", transfers: [] });

    const warnings: string[] = [];
    let slippageBps: number | null = null;
    let receivedUsd = tokenOut * c.tokenUsd + (baseOut + feesBase) * c.baseUsd;
    const swapToBase = p.params.output_mint !== undefined || full; // full exits go back to base
    if (swapToBase && tokenOut > 0) {
      const slip = need(p.params.slippage_bps, "slippage_bps");
      const sw = await this.swap(pos.token_mint, c.baseMint, tokenOut, c.decToken, c.decBase, c.tokenUsd / c.baseUsd, slip);
      // An exit must never be blocked by a bad swap: keep the token and flag it instead.
      if (!sw) warnings.push(`no route to swap ${pos.token_mint} to base; token kept in wallet`);
      else if (sw.slippageBps > slip) warnings.push(`swap slippage ${sw.slippageBps.toFixed(0)} bps > ${slip}; token kept in wallet`);
      else if (sw.ix) {
        ixs.push(sw.ix);
        slippageBps = sw.slippageBps;
        receivedUsd = (baseOut + feesBase + sw.out) * c.baseUsd;
      }
    }
    // Exits are never blocked by a value mismatch (swap legs are dropped instead), so there is
    // no expected-vs-simulated comparison here; inspection still applies.
    const expectedUsd = 0;
    const plan: TxPlan = { instructions: ixs, ...this.fees(p, ixs.some((i) => i.programId === PROGRAMS.JUPITER_V6) ? 2 : 1) };
    return {
      plan,
      expectedUsd,
      simulatedUsd: receivedUsd,
      slippageBps,
      warnings,
      addsRisk: false,
      apply: (txCostUsd) => {
        const now = this.store.now();
        if (full) {
          const pnl = receivedUsd + pos.fees_claimed_usd - pos.deposit_usd - pos.tx_costs_usd - txCostUsd;
          this.store.updatePosition(pos.id, {
            status: "CLOSED", closed_at: now, close_pnl_usd: pnl, tx_costs_usd: pos.tx_costs_usd + txCostUsd,
            fees_claimed_usd: pos.fees_claimed_usd + feesUsd,
            model: { ...removed.model, feesUnclaimedUsd: 0, lastAccrualTs: now },
          });
          for (const e of this.store.openEvents().filter((e) => e.position_id === pos.id)) this.store.setEventStatus(e.id, "RESOLVED");
        } else {
          const keep = 1 - fraction;
          this.store.updatePosition(pos.id, {
            model: { ...removed.model, feesUnclaimedUsd: 0, lastAccrualTs: now },
            deposit_x: pos.deposit_x * keep, deposit_y: pos.deposit_y * keep, deposit_usd: pos.deposit_usd * keep,
            fees_claimed_usd: pos.fees_claimed_usd + feesUsd, tx_costs_usd: pos.tx_costs_usd + txCostUsd,
          });
        }
      },
    };
  }

  private async buildClaim(p: Proposal, state: PoolState): Promise<Built> {
    const pos = this.openPosition(p);
    const model = need(pos.model, "position model");
    const c = await this.ctx(state, pos.token_mint);
    const feesUsd = model.feesUnclaimedUsd;
    if (!(feesUsd > 0)) throw new AbortError("nothing to claim");
    const plan: TxPlan = {
      instructions: [
        { programId: PROGRAMS.COMPUTE_BUDGET, kind: "setComputeUnitPrice", transfers: [] },
        {
          programId: DEX_PROGRAM[pos.dex],
          kind: "dlmm.claimFee",
          transfers: [{ mint: c.baseMint, amount: feesUsd / c.baseUsd, from: `position:${pos.address}`, to: `wallet:${c.baseMint}` }],
        },
      ],
      ...this.fees(p, 1),
    };
    return {
      plan, expectedUsd: feesUsd, simulatedUsd: feesUsd, slippageBps: null, warnings: [], addsRisk: false,
      apply: (txCostUsd) =>
        this.store.updatePosition(pos.id, {
          model: { ...model, feesUnclaimedUsd: 0 },
          fees_claimed_usd: pos.fees_claimed_usd + feesUsd,
          tx_costs_usd: pos.tx_costs_usd + txCostUsd,
        }),
    };
  }

  /** REBALANCE (same width, recentred) or WIDEN_RANGE (new range_pct, recentred). */
  private async buildRebalance(p: Proposal, state: PoolState): Promise<Built> {
    const pos = this.openPosition(p);
    const model = need(pos.model, "position model");
    const c = await this.ctx(state, pos.token_mint);
    const slippage = need(p.params.slippage_bps, "slippage_bps");
    const removed = removeLiquidity(model, c.activeBin, 1);
    let token = c.tokenIsX ? removed.x : removed.y;
    let base = c.tokenIsX ? removed.y : removed.x;
    const valueUsd = token * c.tokenUsd + base * c.baseUsd;
    const curHalf = Math.ceil((pos.upper_bin - pos.lower_bin) / 2);
    const half = p.action === "WIDEN_RANGE"
      ? binsForRangePct(need(p.params.range_pct, "range_pct"), state.binStep)
      : curHalf;
    if (p.action === "WIDEN_RANGE" && half <= curHalf) throw new AbortError(`new half-width ${half} bins is not wider than ${curHalf}`);
    const strategy = p.params.strategy ?? pos.strategy;
    const target = createPosition({
      valueY: valueUsd / c.usdY, activeBin: c.activeBin, lowerBin: c.activeBin - half, upperBin: c.activeBin + half,
      binStep: state.binStep, decimalsX: c.decX, decimalsY: c.decY, strategy, now: this.store.now(),
    });
    const needToken = c.tokenIsX ? target.depositX : target.depositY;
    const posAcct = `position:${pos.address}`;
    const ixs: PlannedInstruction[] = [
      { programId: PROGRAMS.COMPUTE_BUDGET, kind: "setComputeUnitPrice", transfers: [] },
      {
        programId: DEX_PROGRAM[pos.dex],
        kind: "dlmm.removeAllLiquidity",
        transfers: [
          { mint: pos.token_mint, amount: token, from: posAcct, to: `wallet:${pos.token_mint}` },
          { mint: c.baseMint, amount: base, from: posAcct, to: `wallet:${c.baseMint}` },
        ],
      },
    ];
    let slippageBps: number | null = null;
    if (Math.abs(needToken - token) * c.tokenUsd > 0.01) {
      const buying = needToken > token;
      const sw = buying
        ? await this.swap(c.baseMint, pos.token_mint, ((needToken - token) * c.tokenUsd) / c.baseUsd, c.decBase, c.decToken, c.baseUsd / c.tokenUsd, slippage)
        : await this.swap(pos.token_mint, c.baseMint, token - needToken, c.decToken, c.decBase, c.tokenUsd / c.baseUsd, slippage);
      if (!sw) throw new AbortError("no swap route for rebalance");
      if (sw.slippageBps > slippage) throw new AbortError(`rebalance swap slippage ${sw.slippageBps.toFixed(0)} bps > ${slippage}`);
      if (sw.ix) {
        ixs.push(sw.ix);
        const [tin, tout] = sw.ix.transfers as [Transfer, Transfer];
        if (buying) { base -= tin.amount; token += tout.amount; } else { token -= tin.amount; base += tout.amount; }
        slippageBps = sw.slippageBps;
      }
    }
    // Scale the target down to what we actually hold.
    const tgtToken = c.tokenIsX ? target.depositX : target.depositY;
    const tgtBase = c.tokenIsX ? target.depositY : target.depositX;
    const scale = Math.min(1, tgtToken > 0 ? token / tgtToken : 1, tgtBase > 0 ? base / tgtBase : 1);
    const newModel: DlmmPositionModel = {
      ...target.model,
      bins: target.model.bins.map((b) => ({ ...b, liq: b.liq * scale })),
      feesUnclaimedUsd: model.feesUnclaimedUsd,
      lastAccrualTs: model.lastAccrualTs,
    };
    const depToken = tgtToken * scale;
    const depBase = tgtBase * scale;
    ixs.push({
      programId: DEX_PROGRAM[pos.dex],
      kind: `dlmm.addLiquidityByStrategy:${strategy}`,
      transfers: [
        { mint: pos.token_mint, amount: depToken, from: `wallet:${pos.token_mint}`, to: `pool:${state.address}:${pos.token_mint}` },
        { mint: c.baseMint, amount: depBase, from: `wallet:${c.baseMint}`, to: `pool:${state.address}:${c.baseMint}` },
      ],
    });
    const comp = composition(newModel, c.activeBin);
    const redeployedUsd = comp.x * c.usdX + comp.y * c.usdY;
    const leftoverUsd = (token - depToken) * c.tokenUsd + (base - depBase) * c.baseUsd;
    return {
      plan: { instructions: ixs, ...this.fees(p, slippageBps === null ? 1 : 2) },
      expectedUsd: valueUsd,
      simulatedUsd: redeployedUsd + leftoverUsd,
      slippageBps,
      warnings: [],
      addsRisk: true,
      apply: (txCostUsd) =>
        this.store.updatePosition(pos.id, {
          model: newModel,
          lower_bin: c.activeBin - half,
          upper_bin: c.activeBin + half,
          strategy,
          rebalance_count: pos.rebalance_count + 1,
          last_rebalance_at: this.store.now(),
          // leftover returns to the wallet (capital withdrawn); swap loss is a cost
          deposit_usd: pos.deposit_usd - leftoverUsd,
          tx_costs_usd: pos.tx_costs_usd + txCostUsd + Math.max(0, valueUsd - redeployedUsd - leftoverUsd),
        }),
    };
  }

  private async buildSwapToBase(p: Proposal): Promise<Built> {
    const pos = p.position_id ? this.store.getPosition(p.position_id) : undefined;
    const input = p.params.input_mint ?? pos?.token_mint;
    const output = p.params.output_mint ?? pos?.base_mint;
    if (!input || !output) throw new AbortError("swap needs input and output mints");
    if (output !== SOL_MINT && output !== USDC_MINT) throw new AbortError(`output ${output} is not a base asset`);
    const amount = p.params.amount ?? this.store.getBalance(input);
    if (!(amount > 0)) throw new AbortError(`nothing to swap (${input} balance ${this.store.getBalance(input)})`);
    const px = await this.deps.prices.pricesUsd([input, output, SOL_MINT]);
    const inUsd = px.get(input);
    const outUsd = px.get(output);
    if (!inUsd || !outUsd) throw new TransientError("missing USD prices for swap");
    const slippage = need(p.params.slippage_bps, "slippage_bps");
    const sw = await this.swap(input, output, amount, this.decimals(input), this.decimals(output), inUsd / outUsd, slippage);
    if (!sw || !sw.ix) throw new AbortError(`no swap route ${input} → ${output}`);
    if (sw.slippageBps > slippage) throw new AbortError(`swap slippage ${sw.slippageBps.toFixed(0)} bps > ${slippage}`);
    return {
      plan: { instructions: [{ programId: PROGRAMS.COMPUTE_BUDGET, kind: "setComputeUnitPrice", transfers: [] }, sw.ix], ...this.fees(p, 1) },
      expectedUsd: amount * inUsd,
      simulatedUsd: sw.out * outUsd,
      slippageBps: sw.slippageBps,
      warnings: [],
      addsRisk: false,
      apply: (txCostUsd) => {
        if (pos) this.store.updatePosition(pos.id, { tx_costs_usd: pos.tx_costs_usd + txCostUsd });
      },
    };
  }

  // ------------------------------------------------------------------ helpers

  private openPosition(p: Proposal): Position {
    const pos = p.position_id ? this.store.getPosition(p.position_id) : undefined;
    if (!pos) throw new AbortError(`position ${p.position_id} not found`);
    if (pos.status !== "OPEN") throw new AbortError(`position ${pos.id} is ${pos.status}`);
    return pos;
  }

  private decimals(mint: string): number {
    if (mint === SOL_MINT) return 9;
    if (mint === USDC_MINT) return 6;
    const t = this.store.getToken(mint);
    if (!t || !t.decimals) throw new AbortError(`unknown decimals for ${mint}`);
    return t.decimals;
  }
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new AbortError(`missing ${what}`);
  return v;
}

function nonBase(x: string, y: string): string {
  if (x === SOL_MINT && y === USDC_MINT) return x;
  return x === SOL_MINT || x === USDC_MINT ? y : x;
}
