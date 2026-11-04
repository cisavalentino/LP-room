import type { Config } from "../config/schema";
import { SOL_MINT, USDC_MINT } from "../config/load";
import { DEX_PROGRAM, PROGRAMS } from "../chain/programs";
import { json } from "../db/db";
import type { Store } from "../db/store";
import { logger } from "../lib/log";
import { computePortfolio, recordPortfolioSnapshot, type PortfolioState } from "../portfolio";
import type { PoolStateSource, PriceSource } from "../positions/market";
import { proposeEmergencyExit, transition } from "../proposals/lifecycle";
import type { JupiterLike } from "../screener/sources/index";
import type { Mode, Proposal } from "../types";
import { DAY, MINUTE } from "../types";
import { evaluate, type RiskDecision, type RiskInputs } from "./rules";

const log = logger("risk");

export interface RiskDeps {
  prices: PriceSource;
  jupiter: JupiterLike;
  pools: PoolStateSource;
}

/**
 * Risk Officer (code only). Every proposal goes through it: approve, reject or resize, with
 * every decision logged against the rules that fired. Also runs portfolio guards (daily loss
 * limit, kill switch).
 */
export class RiskOfficer {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly deps: RiskDeps,
    private readonly mode: Mode = cfg.app.mode,
  ) {}

  /** Portfolio guards. Returns the portfolio state used. */
  async guard(portfolio?: PortfolioState): Promise<PortfolioState> {
    const pf = portfolio ?? (await computePortfolio(this.store, this.cfg, this.deps.prices));
    recordPortfolioSnapshot(this.store, pf);
    const p = this.cfg.risk.portfolio;

    if (pf.drawdownPct >= p.kill_switch_drawdown_pct && !this.store.isKillSwitchActive()) {
      this.store.db.tx(() => {
        this.store.setKillSwitch(true);
        this.store.setPaused(true);
        const ev = this.store.createEvent({
          type: "KILL_SWITCH",
          severity: "critical",
          details: { drawdown_pct: pf.drawdownPct, peak_usd: pf.peakValueUsd, value_usd: pf.valueUsd },
        });
        const ids = this.store
          .openPositions()
          .map((pos) => proposeEmergencyExit(this.store, pos.id, "kill_switch", `Kill switch: drawdown ${pf.drawdownPct.toFixed(2)}% from peak`, ev).id);
        this.store.setEventStatus(ev, "HANDLED");
        this.store.addReport(
          "alert",
          `KILL SWITCH: drawdown ${pf.drawdownPct.toFixed(2)}% from peak $${pf.peakValueUsd.toFixed(0)}. ` +
            `Exiting everything (proposals ${ids.map((i) => "#" + i).join(", ") || "none"}). Desk stopped; /resume to restart.`,
        );
      });
      log.error("kill switch triggered", { drawdown: pf.drawdownPct });
    }

    if (pf.dailyPnlPct <= -p.daily_loss_limit_pct) {
      const dayStart = Math.floor(pf.ts / DAY) * DAY;
      const already = this.store.db.get("SELECT 1 FROM events WHERE type = 'DAILY_LOSS_LIMIT' AND created_at >= ?", [dayStart]);
      if (!already) {
        this.store.createEvent({ type: "DAILY_LOSS_LIMIT", severity: "warning", details: { daily_pnl_pct: pf.dailyPnlPct } });
        this.store.addReport("alert", `Daily loss limit hit (${pf.dailyPnlPct.toFixed(2)}%). New entries blocked for today; exits only.`);
      }
    }
    return pf;
  }

  /**
   * Reviews every proposal waiting for Risk: MANAGER_APPROVED, plus emergency proposals in
   * PROPOSED (they skip the Manager). Emergencies are handled first.
   */
  async processPending(): Promise<{ proposal: Proposal; decision: RiskDecision }[]> {
    this.expireHumanApprovals();
    const pending = this.store
      .proposalsInState("PROPOSED", "MANAGER_APPROVED")
      .filter((p) => p.state === "MANAGER_APPROVED" || p.emergency);
    if (!pending.length) return [];
    const pf = await this.guard();
    const out: { proposal: Proposal; decision: RiskDecision }[] = [];
    for (const p of pending) {
      // Kill switch may have just superseded it.
      const fresh = this.store.getProposal(p.id)!;
      if (fresh.state !== p.state) continue;
      const decision = await this.review(fresh, pf);
      out.push({ proposal: this.store.getProposal(p.id)!, decision });
    }
    return out;
  }

  async review(p: Proposal, pf: PortfolioState): Promise<RiskDecision> {
    const inputs = await this.gather(p, pf);
    const decision = evaluate(inputs, this.cfg.risk);
    const now = this.store.now();
    this.store.db.tx(() => {
      this.store.db.run(
        "INSERT INTO risk_decisions (proposal_id, outcome, original_size_usd, approved_size_usd, checks_json, ts) VALUES (?, ?, ?, ?, ?, ?)",
        [p.id, decision.outcome, decision.originalSizeUsd, decision.approvedSizeUsd, json.str(decision.checks), now],
      );
      if (decision.outcome === "REJECT") {
        const why = decision.checks.filter((c) => c.result === "FAIL").map((c) => `${c.rule}: ${c.detail}`).join("; ");
        transition(this.store, p.id, "REJECTED", { actor: "risk", note: why });
        this.store.addReport("cycle", `Risk rejected #${p.id} ${p.action}: ${why}`);
      } else {
        const note = decision.outcome === "RESIZE"
          ? `resized $${decision.originalSizeUsd} → $${decision.approvedSizeUsd}`
          : "approved";
        const ttl = decision.needsHuman ? this.cfg.risk.modes.human_approval_ttl_min : this.cfg.risk.executor.proposal_ttl_min;
        transition(this.store, p.id, "RISK_APPROVED", {
          actor: "risk",
          note,
          params: decision.params,
          refPrice: inputs.pool?.price ?? null,
          expiresAt: now + ttl * MINUTE,
        });
        if (decision.needsHuman) this.store.setState(`awaiting_human:${p.id}`, "1");
      }
    });
    log.info(`#${p.id} ${p.action} → ${decision.outcome}`);
    return decision;
  }

  private async gather(p: Proposal, pf: PortfolioState): Promise<RiskInputs> {
    const now = this.store.now();
    const position = p.position_id ? this.store.getPosition(p.position_id) : undefined;
    const poolAddr = p.pool ?? position?.pool ?? null;
    let pool = poolAddr ? this.store.getPool(poolAddr) : undefined;
    // Refresh the reference price from the live pool (used by the Executor's freshness check).
    if (pool) {
      try {
        const live = await this.deps.pools.getPoolState(pool.address);
        pool = { ...pool, price: live.price, tvl_usd: live.tvlUsd };
      } catch (e) {
        log.warn(`live pool state unavailable for ${pool.address}: ${(e as Error).message}`);
      }
    }
    const tokenMint = position?.token_mint ?? (pool ? nonBase(pool.mint_x, pool.mint_y) : undefined);
    const token = tokenMint ? this.store.getToken(tokenMint) : undefined;
    const baseMint = pool ? (tokenMint === pool.mint_x ? pool.mint_y : pool.mint_x) : SOL_MINT;
    const majors = new Set(this.cfg.knownAssets.map((a) => a.mint));

    let entrySwapImpactPct: number | null | undefined;
    if (p.action === "ENTER" && tokenMint && p.params.size_usd) {
      entrySwapImpactPct = await this.entryImpact(baseMint, tokenMint, p.params.size_usd / 2, pf.solPriceUsd);
    }

    const rebalances = position
      ? this.store.db.get<{ n: number; last: number | null }>(
          `SELECT COUNT(*) n, MAX(updated_at) last FROM proposals
           WHERE position_id = ? AND action IN ('REBALANCE','WIDEN_RANGE') AND state = 'DONE' AND updated_at >= ?`,
          [position.id, now - DAY],
        )
      : undefined;

    return {
      proposal: p,
      portfolio: pf,
      mode: this.mode,
      paused: this.store.isPaused(),
      killSwitch: this.store.isKillSwitchActive(),
      pool,
      token,
      position,
      tokenIsMajor: tokenMint ? majors.has(tokenMint) : false,
      lastClosedInPool: poolAddr ? this.store.lastClosedPosition(poolAddr) : undefined,
      rebalancesLast24h: rebalances?.n ?? 0,
      lastRebalanceAt: position?.last_rebalance_at ?? rebalances?.last ?? null,
      entrySwapImpactPct,
      programs: this.programsFor(p, pool?.dex, token?.program),
      now,
    };
  }

  private async entryImpact(baseMint: string, tokenMint: string, usd: number, solUsd: number): Promise<number | null> {
    const decimals = baseMint === USDC_MINT ? 6 : 9;
    const basePx = baseMint === USDC_MINT ? 1 : solUsd;
    const raw = BigInt(Math.max(1, Math.round((usd / basePx) * 10 ** decimals)));
    try {
      const q = await this.deps.jupiter.quote(baseMint, tokenMint, raw, this.cfg.risk.trade.max_slippage_bps_other);
      return q ? q.priceImpactPct : null;
    } catch (e) {
      log.warn(`entry quote failed: ${(e as Error).message}`);
      return null;
    }
  }

  private programsFor(p: Proposal, dex: keyof typeof DEX_PROGRAM | undefined, tokenProgram?: string): string[] {
    const progs: string[] = [PROGRAMS.COMPUTE_BUDGET, PROGRAMS.TOKEN, PROGRAMS.ATA];
    if (tokenProgram === "token2022") progs.push(PROGRAMS.TOKEN_2022);
    if (dex && p.action !== "SWAP_TO_BASE") progs.push(DEX_PROGRAM[dex]);
    if (p.action === "ENTER" || p.action === "SWAP_TO_BASE" || p.action === "REBALANCE") progs.push(PROGRAMS.JUPITER_V6, PROGRAMS.SYSTEM);
    return progs;
  }

  private expireHumanApprovals(): void {
    const now = this.store.now();
    for (const p of this.store.proposalsInState("RISK_APPROVED")) {
      if (this.store.getState(`awaiting_human:${p.id}`) === "1" && p.expires_at && p.expires_at < now) {
        transition(this.store, p.id, "EXPIRED", { actor: "risk", note: "human approval window passed" });
      }
    }
  }
}

function nonBase(x: string, y: string): string {
  const base = new Set([SOL_MINT, USDC_MINT]);
  if (base.has(x) && base.has(y)) return x === SOL_MINT ? x : y;
  return base.has(x) ? y : x;
}
