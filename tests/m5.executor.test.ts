import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "../src/config/load";
import { PROGRAMS } from "../src/chain/programs";
import { PaperExecutor } from "../src/executor/paperExecutor";
import { inspectPlan, type TxPlan } from "../src/executor/plan";
import type { PoolState } from "../src/positions/market";
import { PositionMonitor } from "../src/positions/monitor";
import { seedPaperBalances } from "../src/portfolio";
import { createProposal, proposeEmergencyExit, transition } from "../src/proposals/lifecycle";
import { RiskOfficer } from "../src/risk/officer";
import type { JupiterLike, Quote } from "../src/screener/sources/index";
import type { ProposalParams } from "../src/types";
import { MINUTE } from "../src/types";
import { config, makeStore, testClock } from "./helpers";

const cfg = config();
const TOKEN = "TokenMint111";
const POOL = "PoolAddr111";
const DEC: Record<string, number> = { [SOL_MINT]: 9, [USDC_MINT]: 6, [TOKEN]: 6 };

class Prices {
  usd = new Map<string, number>([[SOL_MINT, 150], [USDC_MINT, 1], [TOKEN, 0.15]]);
  async pricesUsd(mints: string[]) {
    return new Map(mints.filter((m) => this.usd.has(m)).map((m) => [m, this.usd.get(m)!]));
  }
}

/** Quotes consistent with USD prices, minus a configurable loss. */
class PricedJupiter implements JupiterLike {
  lossPct = 0.3;
  noRoute = new Set<string>(); // "in>out"
  constructor(private readonly prices: Prices) {}
  async verifiedMints() {
    return new Set<string>();
  }
  async quote(input: string, output: string, amount: bigint): Promise<Quote | null> {
    if (this.noRoute.has(`${input}>${output}`)) return null;
    const ui = Number(amount) / 10 ** DEC[input]!;
    const outUi = ((ui * this.prices.usd.get(input)!) / this.prices.usd.get(output)!) * (1 - this.lossPct / 100);
    return { inAmount: amount, outAmount: BigInt(Math.floor(outUi * 10 ** DEC[output]!)), priceImpactPct: 0.1, programIds: [PROGRAMS.JUPITER_V6] };
  }
  async pricesUsd(m: string[]) {
    return this.prices.pricesUsd(m);
  }
}

class Pools {
  state: PoolState = { address: POOL, mintX: TOKEN, mintY: SOL_MINT, price: 0.001, binStep: 20, tvlUsd: 1e6, volume24hUsd: 2e6, fees24hUsd: 5000 };
  constructor(private readonly prices: Prices) {}
  async getPoolState() {
    return { ...this.state };
  }
  setPrice(p: number) {
    this.state.price = p;
    this.prices.usd.set(TOKEN, p * this.prices.usd.get(SOL_MINT)!);
  }
}

function setup() {
  const clock = testClock();
  const { store } = makeStore(clock);
  seedPaperBalances(store, cfg); // 20 SOL, 2000 USDC
  const prices = new Prices();
  const jupiter = new PricedJupiter(prices);
  const pools = new Pools(prices);
  store.upsertPool({ address: POOL, dex: "meteora_dlmm", mint_x: TOKEN, mint_y: SOL_MINT, bin_step: 20, fee_bps: 20, tvl_usd: 1e6, volume_24h_usd: 2e6, fees_24h_usd: 5000, fee_apr: 182, price: 0.001, created_at: null });
  store.upsertToken({ mint: TOKEN, symbol: "TKN", name: "Token", decimals: 6, program: "spl", is_major: false, status: "PASS", flags: [], last_checked: clock() });
  const deps = { prices, jupiter, pools };
  const executor = new PaperExecutor(store, cfg, deps);
  const risk = new RiskOfficer(store, cfg, deps);
  const monitor = new PositionMonitor(store, cfg, deps);
  return { store, clock, prices, jupiter, pools, executor, risk, monitor };
}
type S = ReturnType<typeof setup>;

/** Puts a proposal straight into RISK_APPROVED as Risk would. */
function approved(s: S, action: Parameters<typeof createProposal>[1]["action"], params: ProposalParams, extra: { position_id?: number; emergency?: boolean } = {}) {
  const p = createProposal(s.store, { action, source: "test", pool: POOL, params: { slippage_bps: 200, priority_fee_lamports: 10_000, ...params }, ...extra });
  if (!extra.emergency) transition(s.store, p.id, "MANAGER_APPROVED", { actor: "test" });
  return transition(s.store, p.id, "RISK_APPROVED", { actor: "test", refPrice: s.pools.state.price, expiresAt: s.clock() + 30 * MINUTE });
}

async function enter(s: S, size = 300) {
  const p = approved(s, "ENTER", { size_usd: size, range_pct: 5, strategy: "spot" });
  const r = await s.executor.execute(p.id);
  expect(r.status).toBe("DONE");
  return { proposal: s.store.getProposal(p.id)!, position: s.store.openPositions()[0]! };
}

describe("PaperExecutor — entries", () => {
  it("simulates an entry: swap + deposit, records a paper fill, opens a position", async () => {
    const s = setup();
    const solBefore = s.store.getBalance(SOL_MINT);
    const { proposal, position } = await enter(s, 300);
    expect(proposal.state).toBe("DONE");
    expect(proposal.position_id).toBe(position.id);
    expect(position.paper).toBe(true);
    expect(position.address).toMatch(/^paper-/);
    expect(position.deposit_usd).toBeGreaterThan(295);
    expect(position.deposit_usd).toBeLessThanOrEqual(300);
    // ~2 SOL spent + network fees
    expect(solBefore - s.store.getBalance(SOL_MINT)).toBeCloseTo(2, 1);
    const ex = s.store.db.get<{ simulated: number; status: string; signature: string; plan_json: string; slippage_bps: number }>("SELECT * FROM executions WHERE proposal_id = ?", [proposal.id])!;
    expect(ex.simulated).toBe(1);
    expect(ex.status).toBe("DONE");
    expect(ex.signature).toMatch(/^paper-/);
    const plan = JSON.parse(ex.plan_json) as TxPlan;
    expect(plan.instructions.map((i) => i.kind)).toEqual(["setComputeUnitPrice", "jupiter.route", "dlmm.initializePosition", "dlmm.addLiquidityByStrategy:spot"]);
    expect(ex.slippage_bps).toBeCloseTo(30, 0);
  });

  it("is idempotent: a proposal is executed at most once", async () => {
    const s = setup();
    const { proposal } = await enter(s);
    expect((await s.executor.execute(proposal.id)).status).toBe("SKIPPED");
    expect(s.store.db.all("SELECT * FROM executions")).toHaveLength(1);
    expect(s.store.openPositions()).toHaveLength(1);
  });

  it("sends stale proposals back to Risk (price moved / expired)", async () => {
    const s = setup();
    const p = approved(s, "ENTER", { size_usd: 300 });
    s.pools.setPrice(0.00106); // +6%
    const r = await s.executor.execute(p.id);
    expect(r.status).toBe("SENT_BACK");
    expect(s.store.getProposal(p.id)!.state).toBe("MANAGER_APPROVED");

    const e = approved(s, "FULL_EXIT", {}, { emergency: true, position_id: undefined });
    s.clock.advance(31 * MINUTE);
    expect((await s.executor.execute(e.id)).status).toBe("SENT_BACK");
    expect(s.store.getProposal(e.id)!.state).toBe("PROPOSED"); // emergencies go back to Risk directly
  });

  it("aborts when the swap slippage exceeds the cap; nothing moves", async () => {
    const s = setup();
    s.jupiter.lossPct = 5;
    const before = [...s.store.getBalances()];
    const p = approved(s, "ENTER", { size_usd: 300 });
    const r = await s.executor.execute(p.id);
    expect(r.status).toBe("ABORTED");
    expect(s.store.getProposal(p.id)!.state).toBe("FAILED");
    expect([...s.store.getBalances()]).toEqual(before);
    expect(s.store.openEvents().map((e) => e.type)).toContain("EXECUTION_FAILED");
    expect(s.store.unsentReports().some((x) => x.kind === "alert")).toBe(true);
  });

  it("aborts when funds are insufficient or the SOL reserve would be breached", async () => {
    const s = setup();
    const p = approved(s, "ENTER", { size_usd: 2_950 }); // 20 SOL = $3000, reserve 0.5 SOL
    const r = await s.executor.execute(p.id);
    expect(r.status).toBe("ABORTED");
    expect((r as { reason: string }).reason).toMatch(/reserve|insufficient/);
  });

  it("skips entries while paused", async () => {
    const s = setup();
    s.store.setPaused(true);
    const p = approved(s, "ENTER", { size_usd: 300 });
    expect((await s.executor.execute(p.id)).status).toBe("SKIPPED");
  });
});

describe("PaperExecutor — exits and position actions", () => {
  it("FULL_EXIT removes liquidity, claims fees, swaps to base, closes the position with PnL", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    await s.monitor.runOnce();
    s.clock.advance(10 * MINUTE);
    await s.monitor.runOnce();
    const ex = approved(s, "FULL_EXIT", { fraction: 1 }, { position_id: position.id });
    const r = await s.executor.execute(ex.id);
    expect(r.status).toBe("DONE");
    const closed = s.store.getPosition(position.id)!;
    expect(closed.status).toBe("CLOSED");
    expect(closed.close_pnl_usd).toBeLessThan(0); // round-trip swap costs > 10 min of fees
    expect(closed.close_pnl_usd).toBeGreaterThan(-10);
    expect(s.store.getBalance(TOKEN)).toBeCloseTo(0, 6);
    expect(s.store.openEvents().filter((e) => e.position_id === position.id)).toHaveLength(0);
  });

  it("an exit is never blocked by a bad swap: the token is kept and flagged", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    s.jupiter.noRoute.add(`${TOKEN}>${SOL_MINT}`); // honeypot after entry
    const ex = approved(s, "FULL_EXIT", {}, { position_id: position.id, emergency: true });
    const r = await s.executor.execute(ex.id);
    expect(r.status).toBe("DONE");
    expect(s.store.getPosition(position.id)!.status).toBe("CLOSED");
    expect(s.store.getBalance(TOKEN)).toBeGreaterThan(0);
    const err = s.store.db.get<{ error: string }>("SELECT error FROM executions WHERE proposal_id = ?", [ex.id])!;
    expect(err.error).toMatch(/token kept/);
  });

  it("emergency exits run even while paused / kill switch", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    s.store.setPaused(true);
    s.store.setKillSwitch(true);
    const ex = approved(s, "FULL_EXIT", {}, { position_id: position.id, emergency: true });
    expect((await s.executor.execute(ex.id)).status).toBe("DONE");
  });

  it("PARTIAL_EXIT halves the position and its cost basis", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    const ex = approved(s, "PARTIAL_EXIT", { fraction: 0.5 }, { position_id: position.id });
    expect((await s.executor.execute(ex.id)).status).toBe("DONE");
    const after = s.store.getPosition(position.id)!;
    expect(after.status).toBe("OPEN");
    expect(after.deposit_usd).toBeCloseTo(position.deposit_usd / 2, 6);
    expect(s.store.getBalance(TOKEN)).toBeGreaterThan(0); // partial exits don't auto-swap
  });

  it("CLAIM_FEES credits accrued fees", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    s.store.updatePosition(position.id, { model: { ...position.model!, feesUnclaimedUsd: 15 } });
    const sol = s.store.getBalance(SOL_MINT);
    const ex = approved(s, "CLAIM_FEES", {}, { position_id: position.id });
    expect((await s.executor.execute(ex.id)).status).toBe("DONE");
    expect(s.store.getBalance(SOL_MINT) - sol).toBeCloseTo(15 / 150 - 15_000 / 1e9, 6);
    expect(s.store.getPosition(position.id)!.fees_claimed_usd).toBe(15);
  });

  it("REBALANCE recentres on the current price; WIDEN_RANGE widens", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    s.pools.setPrice(0.0012);
    const reb = approved(s, "REBALANCE", {}, { position_id: position.id });
    expect((await s.executor.execute(reb.id)).status).toBe("DONE");
    const p1 = s.store.getPosition(position.id)!;
    expect(p1.lower_bin).toBeGreaterThan(position.upper_bin - 1);
    expect(p1.upper_bin - p1.lower_bin).toBe(position.upper_bin - position.lower_bin);
    expect(p1.rebalance_count).toBe(1);
    const wid = approved(s, "WIDEN_RANGE", { range_pct: 20 }, { position_id: position.id });
    expect((await s.executor.execute(wid.id)).status).toBe("DONE");
    const p2 = s.store.getPosition(position.id)!;
    expect(p2.upper_bin - p2.lower_bin).toBeGreaterThan(p1.upper_bin - p1.lower_bin);
  });

  it("SWAP_TO_BASE converts leftover tokens", async () => {
    const s = setup();
    s.store.adjustBalance(TOKEN, 1000);
    const ex = approved(s, "SWAP_TO_BASE", { input_mint: TOKEN, output_mint: SOL_MINT });
    expect((await s.executor.execute(ex.id)).status).toBe("DONE");
    expect(s.store.getBalance(TOKEN)).toBe(0);
  });

  it("recovers proposals stuck in EXECUTING without double-filling", async () => {
    const s = setup();
    const p = approved(s, "ENTER", { size_usd: 300 });
    transition(s.store, p.id, "EXECUTING", { actor: "crashed-worker" });
    s.clock.advance(11 * MINUTE);
    expect(s.executor.recoverStuck()).toBe(1);
    expect(s.store.getProposal(p.id)!.state).toBe("FAILED");
    expect(s.store.openPositions()).toHaveLength(0);
  });
});

describe("instruction inspection", () => {
  const ctx = { allowlist: new Set(cfg.risk.program_allowlist), pool: POOL, positions: new Set(["paper-1"]), jupiterProgram: PROGRAMS.JUPITER_V6 };
  const base = (over: Partial<TxPlan> = {}): TxPlan => ({ instructions: [], feesSol: 0, priorityFeeLamports: 0, computeUnitLimit: 0, ...over });

  it("rejects programs that are not allowlisted", () => {
    const v = inspectPlan(base({ instructions: [{ programId: "Drainer1111", kind: "x", transfers: [] }] }), ctx);
    expect(v[0]).toMatch(/not allowlisted/);
  });
  it("rejects transfers to foreign accounts", () => {
    const v = inspectPlan(base({
      instructions: [{ programId: PROGRAMS.TOKEN, kind: "transfer", transfers: [{ mint: SOL_MINT, amount: 1, from: `wallet:${SOL_MINT}`, to: "attacker" }] }],
    }), ctx);
    expect(v[0]).toMatch(/foreign account/);
    const other = inspectPlan(base({
      instructions: [{ programId: PROGRAMS.METEORA_DLMM, kind: "add", transfers: [{ mint: SOL_MINT, amount: 1, from: `wallet:${SOL_MINT}`, to: `pool:OtherPool:${SOL_MINT}` }] }],
    }), ctx);
    expect(other[0]).toMatch(/foreign account/);
    const route = inspectPlan(base({
      instructions: [{ programId: PROGRAMS.METEORA_DLMM, kind: "add", transfers: [{ mint: SOL_MINT, amount: 1, from: `wallet:${SOL_MINT}`, to: "route:jupiter" }] }],
    }), ctx);
    expect(route[0]).toMatch(/foreign account/);
  });
  it("accepts own accounts, the pool and Jupiter routes", () => {
    const v = inspectPlan(base({
      instructions: [
        { programId: PROGRAMS.JUPITER_V6, kind: "route", transfers: [{ mint: SOL_MINT, amount: 1, from: `wallet:${SOL_MINT}`, to: "route:jupiter" }, { mint: TOKEN, amount: 5, from: "route:jupiter", to: `wallet:${TOKEN}` }] },
        { programId: PROGRAMS.METEORA_DLMM, kind: "add", transfers: [{ mint: TOKEN, amount: 5, from: `wallet:${TOKEN}`, to: `pool:${POOL}:${TOKEN}` }] },
      ],
    }), ctx);
    expect(v).toEqual([]);
  });
});

describe("end-to-end paper pipeline", () => {
  it("stop loss → emergency exit → Risk → simulated execution", async () => {
    const s = setup();
    const { position } = await enter(s, 300);
    await s.monitor.runOnce();
    s.clock.advance(2 * MINUTE);
    s.pools.setPrice(0.0007); // -30%
    await s.monitor.runOnce();
    const [exit] = s.store.proposalsInState("PROPOSED");
    expect(exit!.emergency).toBe(true);
    await s.risk.processPending();
    expect(s.store.getProposal(exit!.id)!.state).toBe("RISK_APPROVED");
    const results = await s.executor.runOnce();
    expect(results[0]!.outcome.status).toBe("DONE");
    expect(s.store.getPosition(position.id)!.status).toBe("CLOSED");
    expect(s.store.getPosition(position.id)!.close_pnl_usd!).toBeLessThan(-20);
  });

  it("/exitall style emergency exits for every position", async () => {
    const s = setup();
    await enter(s, 200);
    const ids = s.store.openPositions().map((p) => proposeEmergencyExit(s.store, p.id, "human", "exitall").id);
    await s.risk.processPending();
    await s.executor.runOnce();
    expect(ids.every((id) => s.store.getProposal(id)!.state === "DONE")).toBe(true);
    expect(s.store.openPositions()).toHaveLength(0);
  });
});

describe("no real transaction sending", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("source code contains no signing or sending calls", () => {
    const forbidden = /\b(sendTransaction|sendRawTransaction|sendAndConfirm\w*|signTransaction|signAllTransactions|Keypair|secretKey|fromSecretKey|sendEncodedTransaction|sendBundle)\b/;
    const hits = files("src").filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the executor refuses to run outside paper mode", () => {
    const { store } = makeStore();
    const bad = { ...cfg, app: { ...cfg.app, mode: "auto" as unknown as "paper" } };
    expect(() => new PaperExecutor(store, bad, {} as never)).toThrow(/paper/);
  });
});
