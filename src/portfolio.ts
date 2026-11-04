import type { Config } from "./config/schema";
import { SOL_MINT } from "./config/load";
import type { Store } from "./db/store";
import type { PriceSource } from "./positions/market";
import { DAY } from "./types";

export interface PositionExposure {
  id: number;
  pool: string;
  token_mint: string;
  valueUsd: number;
}

export interface PortfolioState {
  ts: number;
  valueUsd: number;
  /** Wallet (undeployed) value. */
  freeUsd: number;
  deployedUsd: number;
  solBalance: number;
  solPriceUsd: number;
  positions: PositionExposure[];
  /** USD exposure per non-base token (whole position value + wallet holdings). */
  tokenExposureUsd: Map<string, number>;
  nonMajorUsd: number;
  dayStartValueUsd: number;
  peakValueUsd: number;
  dailyPnlPct: number;
  drawdownPct: number;
}

/**
 * Values the desk: wallet balances (simulated in paper) + open positions (latest snapshot
 * value + unclaimed fees, or deposit value if never snapshotted).
 */
export async function computePortfolio(store: Store, cfg: Config, prices: PriceSource): Promise<PortfolioState> {
  const ts = store.now();
  const balances = store.getBalances();
  const majors = new Set(cfg.knownAssets.map((a) => a.mint));
  const base = new Set(cfg.knownAssets.filter((a) => a.base).map((a) => a.mint));
  const px = await prices.pricesUsd([...balances.keys(), SOL_MINT]);
  const solPriceUsd = px.get(SOL_MINT);
  if (!solPriceUsd) throw new Error("SOL price unavailable");

  const tokenExposureUsd = new Map<string, number>();
  let nonMajorUsd = 0;
  let freeUsd = 0;
  for (const [mint, amount] of balances) {
    const p = px.get(mint);
    if (p === undefined) {
      if (amount > 0) throw new Error(`price unavailable for held mint ${mint}`);
      continue;
    }
    const usd = amount * p;
    freeUsd += usd;
    if (!base.has(mint)) tokenExposureUsd.set(mint, (tokenExposureUsd.get(mint) ?? 0) + usd);
    if (!majors.has(mint)) nonMajorUsd += usd;
  }

  const positions: PositionExposure[] = store.openPositions().map((p) => {
    const snap = store.latestSnapshot(p.id);
    const valueUsd = snap ? snap.value_usd + snap.fees_unclaimed_usd : p.deposit_usd;
    return { id: p.id, pool: p.pool, token_mint: p.token_mint, valueUsd };
  });
  let deployedUsd = 0;
  for (const p of positions) {
    deployedUsd += p.valueUsd;
    if (!base.has(p.token_mint)) tokenExposureUsd.set(p.token_mint, (tokenExposureUsd.get(p.token_mint) ?? 0) + p.valueUsd);
    if (!majors.has(p.token_mint)) nonMajorUsd += p.valueUsd;
  }

  const valueUsd = freeUsd + deployedUsd;
  const dayStart = Math.floor(ts / DAY) * DAY;
  const first = store.db.get<{ value_usd: number }>(
    "SELECT value_usd FROM portfolio_snapshots WHERE ts >= ? ORDER BY ts LIMIT 1",
    [dayStart],
  );
  const peak = store.db.get<{ v: number | null }>("SELECT MAX(value_usd) v FROM portfolio_snapshots")?.v ?? null;
  const dayStartValueUsd = first?.value_usd ?? valueUsd;
  const peakValueUsd = Math.max(peak ?? valueUsd, valueUsd);
  return {
    ts,
    valueUsd,
    freeUsd,
    deployedUsd,
    solBalance: balances.get(SOL_MINT) ?? 0,
    solPriceUsd,
    positions,
    tokenExposureUsd,
    nonMajorUsd,
    dayStartValueUsd,
    peakValueUsd,
    dailyPnlPct: dayStartValueUsd > 0 ? ((valueUsd - dayStartValueUsd) / dayStartValueUsd) * 100 : 0,
    drawdownPct: peakValueUsd > 0 ? ((peakValueUsd - valueUsd) / peakValueUsd) * 100 : 0,
  };
}

export function recordPortfolioSnapshot(store: Store, p: PortfolioState): void {
  store.db.run(
    "INSERT OR REPLACE INTO portfolio_snapshots (ts, value_usd, free_usd, deployed_usd, sol_price_usd) VALUES (?, ?, ?, ?, ?)",
    [p.ts, p.valueUsd, p.freeUsd, p.deployedUsd, p.solPriceUsd],
  );
}

/** Seeds simulated paper balances on first start. */
export function seedPaperBalances(store: Store, cfg: Config): boolean {
  if (store.getState("paper_seeded") === "1") return false;
  const bySymbol = new Map(cfg.knownAssets.map((a) => [a.symbol, a.mint]));
  store.db.tx(() => {
    for (const [sym, amount] of Object.entries(cfg.app.paper.starting_balances)) {
      const mint = bySymbol.get(sym) ?? sym;
      store.adjustBalance(mint, amount);
    }
    store.setState("paper_seeded", "1");
  });
  return true;
}
