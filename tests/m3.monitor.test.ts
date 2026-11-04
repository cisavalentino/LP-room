import { describe, expect, it } from "vitest";
import { SOL_MINT } from "../src/config/load";
import {
  binIdFromPrice,
  binPrice,
  binsForRangePct,
  composition,
  createPosition,
  removeLiquidity,
  valueInY,
} from "../src/positions/dlmmModel";
import type { PoolState, PoolStateSource, PriceSource } from "../src/positions/market";
import { PositionMonitor } from "../src/positions/monitor";
import { HOUR, MINUTE } from "../src/types";
import { config, makeStore, testClock } from "./helpers";

const TOKEN = "TokenMint111";
const POOL = "PoolAddr111";

describe("DLMM paper model", () => {
  it("bin price ↔ id round trip with decimals", () => {
    const id = binIdFromPrice(0.0025, 20, 6, 9);
    const p = binPrice(id, 20, 6, 9);
    expect(p).toBeLessThanOrEqual(0.0025 * (1 + 1e-9));
    expect(binPrice(id + 1, 20, 6, 9)).toBeGreaterThan(0.0025);
  });

  it("range pct → bins", () => {
    expect(binsForRangePct(10, 100)).toBe(10); // 1.01^10 ≈ 1.105
    expect(binsForRangePct(1, 100)).toBe(1);
  });

  it("spot position starts ~50/50, goes all-Y when price falls below, all-X above", () => {
    const bs = 20;
    const active = 0;
    const { model, depositX, depositY } = createPosition({
      valueY: 1000, activeBin: active, lowerBin: -10, upperBin: 10, binStep: bs, decimalsX: 6, decimalsY: 6, strategy: "spot", now: 0,
    });
    const p0 = binPrice(active, bs, 6, 6);
    expect(depositX * p0 + depositY).toBeCloseTo(1000, 0);
    expect(depositY / 1000).toBeCloseTo(0.5, 1);
    expect(composition(model, 20).x).toBeCloseTo(0); // price above range → sold all X
    expect(composition(model, -20).y).toBeCloseTo(0); // price below range → all X
    // Price falls out of range: value < hodl (impermanent loss)
    const pLow = binPrice(-20, bs, 6, 6);
    const hodl = depositX * pLow + depositY;
    expect(valueInY(model, -20, pLow)).toBeLessThan(hodl);
  });

  it("curve concentrates, bid-ask spreads", () => {
    const base = { valueY: 1000, activeBin: 0, lowerBin: -10, upperBin: 10, binStep: 20, decimalsX: 6, decimalsY: 6, now: 0 };
    const curve = createPosition({ ...base, strategy: "curve" }).model;
    const bidAsk = createPosition({ ...base, strategy: "bid_ask" }).model;
    const mid = (m: typeof curve) => m.bins.find((b) => b.id === 0)!.liq;
    expect(mid(curve)).toBeGreaterThan(mid(bidAsk));
  });

  it("partial removal", () => {
    const { model } = createPosition({ valueY: 1000, activeBin: 0, lowerBin: -5, upperBin: 5, binStep: 20, decimalsX: 6, decimalsY: 6, strategy: "spot", now: 0 });
    const r = removeLiquidity(model, 0, 0.5);
    expect(valueInY(r.model, 0, binPrice(0, 20, 6, 6))).toBeCloseTo(500, 0);
    expect(r.x + r.y).toBeGreaterThan(0);
  });
});

class FakePoolState implements PoolStateSource {
  state: PoolState = { address: POOL, mintX: TOKEN, mintY: SOL_MINT, price: 0.001, binStep: 20, tvlUsd: 1_000_000, volume24hUsd: 2_000_000, fees24hUsd: 5_000 };
  async getPoolState() {
    return { ...this.state };
  }
}
class FakePrices implements PriceSource {
  sol = 150;
  async pricesUsd() {
    return new Map([[SOL_MINT, this.sol]]);
  }
}

function setup() {
  const clock = testClock();
  const { store } = makeStore(clock);
  const cfg = config();
  const pools = new FakePoolState();
  const prices = new FakePrices();
  store.upsertPool({ address: POOL, dex: "meteora_dlmm", mint_x: TOKEN, mint_y: SOL_MINT, bin_step: 20, fee_bps: 20, tvl_usd: 1e6, volume_24h_usd: 2e6, fees_24h_usd: 5000, fee_apr: 182, price: 0.001, created_at: null });
  store.upsertToken({ mint: TOKEN, symbol: "TKN", name: "Token", decimals: 6, program: "spl", is_major: false, status: "PASS", flags: [], last_checked: clock() });
  // $1500 position (10 SOL) around price 0.001 SOL, ±5%
  const active = binIdFromPrice(0.001, 20, 6, 9);
  const half = binsForRangePct(5, 20);
  const { model, depositX, depositY } = createPosition({
    valueY: 10, activeBin: active, lowerBin: active - half, upperBin: active + half, binStep: 20, decimalsX: 6, decimalsY: 9, strategy: "spot", now: clock(),
  });
  const id = store.insertPosition({
    address: "paper-1", pool: POOL, dex: "meteora_dlmm", paper: true, token_mint: TOKEN, base_mint: SOL_MINT, strategy: "spot",
    lower_bin: active - half, upper_bin: active + half, deposit_x: depositX, deposit_y: depositY, deposit_usd: 1500,
    entry_price: 0.001, model, opened_at: clock(),
  });
  const monitor = new PositionMonitor(store, cfg, { pools, prices });
  return { store, clock, pools, prices, monitor, id, cfg };
}

async function tick(s: ReturnType<typeof setup>, minutes = 2) {
  s.clock.advance(minutes * MINUTE);
  return s.monitor.runOnce();
}

const openTypes = (s: ReturnType<typeof setup>) => s.store.db.all<{ type: string; status: string; severity: string }>("SELECT type, status, severity FROM events ORDER BY id");

describe("Position monitor", () => {
  it("records snapshots with value, fees, IL and PnL", async () => {
    const s = setup();
    await tick(s);
    await tick(s, 10);
    const snap = s.store.latestSnapshot(s.id)!;
    expect(snap.in_range).toBe(1);
    expect(snap.value_usd).toBeCloseTo(1500, -1);
    expect(snap.value_sol).toBeCloseTo(10, 0);
    expect(snap.fees_unclaimed_usd).toBeGreaterThan(0);
    // 2 + 10 min of fees at share 1500/1e6 of $5000/day
    expect(snap.fees_unclaimed_usd).toBeCloseTo(5000 * (12 / 1440) * (snap.value_usd / 1e6), 3);
    expect(Math.abs(snap.il_pct)).toBeLessThan(0.5);
    expect(snap.pnl_usd).toBeCloseTo(snap.value_usd + snap.fees_total_usd - 1500, 6);
  });

  it("OUT_OF_RANGE after 30 min and resolves when back in range", async () => {
    const s = setup();
    await tick(s);
    s.pools.state.price = 0.0012; // +20% → above range
    await tick(s);
    expect(openTypes(s).map((e) => e.type)).not.toContain("OUT_OF_RANGE");
    for (let i = 0; i < 16; i++) await tick(s);
    expect(openTypes(s).filter((e) => e.type === "OUT_OF_RANGE")).toHaveLength(1);
    s.pools.state.price = 0.001;
    await tick(s);
    expect(openTypes(s).find((e) => e.type === "OUT_OF_RANGE")!.status).toBe("RESOLVED");
  });

  it("STOP_LOSS → emergency FULL_EXIT proposal (once)", async () => {
    const s = setup();
    await tick(s);
    s.pools.state.price = 0.0007; // -30%, below range: all token
    await tick(s);
    await tick(s);
    const ev = openTypes(s).filter((e) => e.type === "STOP_LOSS");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.status).toBe("HANDLED");
    const props = s.store.proposalsInState("PROPOSED");
    expect(props).toHaveLength(1);
    expect(props[0]!.action).toBe("FULL_EXIT");
    expect(props[0]!.emergency).toBe(true);
    expect(s.store.unsentReports().some((r) => r.body.includes("STOP_LOSS"))).toBe(true);
  });

  it("TVL_DROP: warning at -30%, critical emergency at -50% within 1h", async () => {
    const s = setup();
    await tick(s);
    for (let i = 0; i < 30; i++) await tick(s);
    s.pools.state.tvlUsd = 600_000;
    await tick(s);
    expect(openTypes(s).find((e) => e.type === "TVL_DROP")?.severity).toBe("warning");
    expect(s.store.proposalsInState("PROPOSED")).toHaveLength(0);
    s.pools.state.tvlUsd = 300_000;
    await tick(s);
    expect(openTypes(s).some((e) => e.type === "TVL_DROP" && e.severity === "critical" && e.status === "HANDLED")).toBe(true);
    expect(s.store.proposalsInState("PROPOSED")[0]?.action).toBe("FULL_EXIT");
  });

  it("PRICE_CRASH when token -25% in 1h", async () => {
    const s = setup();
    await tick(s);
    for (let i = 0; i < 30; i++) await tick(s);
    s.prices.sol = 150;
    s.pools.state.price = 0.00072;
    await tick(s);
    expect(openTypes(s).map((e) => e.type)).toContain("PRICE_CRASH");
  });

  it("TOKEN_FLAGGED when the Screener re-check rejects the token", async () => {
    const s = setup();
    await tick(s);
    s.store.setTokenVerdict(TOKEN, "REJECT", ["FREEZE_AUTHORITY_NOT_REVOKED"], 0);
    await tick(s);
    expect(openTypes(s).find((e) => e.type === "TOKEN_FLAGGED")?.status).toBe("HANDLED");
    expect(s.store.proposalsInState("PROPOSED")[0]?.emergency).toBe(true);
  });

  it("CLAIM_DUE creates a CLAIM_FEES proposal; FEES_DRIED_UP after 6h of low APR", async () => {
    const s = setup();
    s.pools.state.fees24hUsd = 2_000_000; // huge fees → claim due quickly
    await tick(s);
    await tick(s, 15);
    expect(openTypes(s).map((e) => e.type)).toContain("CLAIM_DUE");
    expect(s.store.proposalsInState("PROPOSED").map((p) => p.action)).toContain("CLAIM_FEES");

    const s2 = setup();
    s2.pools.state.fees24hUsd = 10; // ~0.4% APR
    await tick(s2);
    for (let i = 0; i < 6 * 30 + 5; i++) await tick(s2);
    expect(openTypes(s2).map((e) => e.type)).toContain("FEES_DRIED_UP");
  });

  it("IL_HIGH when IL > 5% and fees don't cover it", async () => {
    const s = setup();
    await tick(s);
    s.pools.state.price = 0.00125; // above range, all SOL, IL vs HODL
    await tick(s);
    const snap = s.store.latestSnapshot(s.id)!;
    expect(snap.il_pct).toBeGreaterThan(5);
    expect(openTypes(s).map((e) => e.type)).toContain("IL_HIGH");
  });

  it("skips positions when prices are unavailable instead of writing bad data", async () => {
    const s = setup();
    s.prices.pricesUsd = async () => new Map();
    const r = await tick(s);
    expect(r.snapshots).toBe(0);
    expect(r.errors[0]).toMatch(/price/);
    void HOUR;
  });
});
