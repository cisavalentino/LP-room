import type { ScreenerConfig } from "../config/schema";
import { BASE_MINTS, USDC_MINT } from "../config/load";
import { DAY, HOUR } from "../types";
import type { PoolCandidate, RawPool, Rejection, StageResult } from "./types";

// ---------------------------------------------------------------- Stage 1 — Collect

/** Keep only pools where one side is SOL or USDC, oriented as (token, base). */
export function collect(pools: RawPool[]): StageResult<PoolCandidate> {
  const passed: PoolCandidate[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    if (seen.has(pool.address)) continue;
    seen.add(pool.address);
    const xBase = BASE_MINTS.has(pool.tokenX.mint);
    const yBase = BASE_MINTS.has(pool.tokenY.mint);
    if (!xBase && !yBase) continue; // not our universe; not worth logging
    if (pool.hidden) {
      rejected.push({ pool: pool.address, token_mint: null, stage: "collect", reasons: ["HIDDEN_OR_BLACKLISTED_BY_DEX"] });
      continue;
    }
    // SOL/USDC: treat SOL as the "token" and USDC as base.
    const tokenIsX = xBase && yBase ? pool.tokenY.mint === USDC_MINT : !xBase;
    passed.push({
      pool,
      token: tokenIsX ? pool.tokenX : pool.tokenY,
      base: tokenIsX ? pool.tokenY : pool.tokenX,
      tokenIsX,
      market: {},
      tokenMarket: {},
      flags: [],
      metrics: {},
    });
  }
  return { passed, rejected };
}

// ---------------------------------------------------------------- Stage 2 — Hard filters

/** Cheap filters on DEX API numbers only (run before any enrichment calls). */
export function hardFiltersCheap(cands: PoolCandidate[], cfg: ScreenerConfig): StageResult<PoolCandidate> {
  const f = cfg.hard_filters;
  return partition(cands, "hard_filter", (c) => {
    const r: string[] = [];
    if (!(c.pool.tvlUsd >= f.min_tvl)) r.push(`TVL_TOO_LOW:${Math.round(c.pool.tvlUsd)}`);
    if (!(c.pool.volume24hUsd >= f.min_volume_24h)) r.push(`VOLUME_TOO_LOW:${Math.round(c.pool.volume24hUsd)}`);
    return r;
  });
}

/** Filters that need market data (pool age, token age, txns, traders). Unknown age/txns = reject. */
export function hardFiltersMarket(cands: PoolCandidate[], cfg: ScreenerConfig, now: number): StageResult<PoolCandidate> {
  const f = cfg.hard_filters;
  return partition(cands, "hard_filter", (c) => {
    const r: string[] = [];
    const poolAgeH = c.market.pairCreatedAt ? (now - c.market.pairCreatedAt) / HOUR : undefined;
    const tokenCreated = c.tokenMarket.firstPairCreatedAt ?? c.market.pairCreatedAt;
    const tokenAgeD = tokenCreated ? (now - tokenCreated) / DAY : undefined;
    c.metrics.pool_age_hours = poolAgeH ?? null;
    c.metrics.token_age_days = tokenAgeD ?? null;
    c.metrics.txns_24h = c.market.txns24h ?? null;
    c.metrics.unique_traders_24h = c.market.uniqueTraders24h ?? null;
    if (poolAgeH === undefined) r.push("POOL_AGE_UNKNOWN");
    else if (poolAgeH < f.min_pool_age_hours) r.push(`POOL_TOO_NEW:${poolAgeH.toFixed(1)}h`);
    if (tokenAgeD === undefined) r.push("TOKEN_AGE_UNKNOWN");
    else if (tokenAgeD < f.min_token_age_days) r.push(`TOKEN_TOO_NEW:${tokenAgeD.toFixed(1)}d`);
    if (c.market.txns24h === undefined) r.push("TXNS_UNKNOWN");
    else if (c.market.txns24h < f.min_txns_24h) r.push(`TOO_FEW_TXNS:${c.market.txns24h}`);
    if (c.market.uniqueTraders24h === undefined) c.flags.push("UNIQUE_TRADERS_UNKNOWN");
    else if (c.market.uniqueTraders24h < f.min_unique_traders_24h) r.push(`TOO_FEW_TRADERS:${c.market.uniqueTraders24h}`);
    return r;
  });
}

// ---------------------------------------------------------------- Stage 5 — Pool quality

export interface PoolHistoryLookup {
  /** TVL roughly 24h ago (oldest sample within [now-26h, now-22h]); undefined when unknown. */
  tvl24hAgo(pool: string): number | undefined;
  /** Min/max price over the last 7 days; undefined when unknown. */
  priceRange7d(pool: string): { min: number; max: number } | undefined;
}

export function poolQuality(cands: PoolCandidate[], cfg: ScreenerConfig, history: PoolHistoryLookup): StageResult<PoolCandidate> {
  const q = cfg.pool_quality;
  return partition(cands, "pool_quality", (c) => {
    const r: string[] = [];
    const tvl = c.pool.tvlUsd;
    const volTvl = tvl > 0 ? c.pool.volume24hUsd / tvl : Infinity;
    c.metrics.volume_tvl_ratio = volTvl;
    if (volTvl > q.max_volume_tvl_ratio) r.push(`WASH_TRADING_VOLUME_TVL:${volTvl.toFixed(1)}x`);

    const txns = c.market.txns24h;
    const traders = c.market.uniqueTraders24h;
    if (txns && traders !== undefined) {
      const ratio = traders / txns;
      c.metrics.unique_trader_ratio = ratio;
      if (ratio < q.min_unique_trader_txn_ratio) c.flags.push(`WASH_TRADING_FEW_TRADERS:${ratio.toFixed(3)}`);
    }

    const past = history.tvl24hAgo(c.pool.address);
    if (past !== undefined && past > 0) {
      const drop = ((past - tvl) / past) * 100;
      c.metrics.tvl_change_24h_pct = -drop;
      if (drop > q.max_tvl_drop_24h_pct) r.push(`TVL_DROP_24H:${drop.toFixed(0)}%`);
    } else {
      c.flags.push("TVL_HISTORY_UNKNOWN");
    }

    // Real fee APR from fees, not the advertised APR.
    c.metrics.fee_apr = tvl > 0 ? (c.pool.fees24hUsd / tvl) * 365 * 100 : 0;

    const range = history.priceRange7d(c.pool.address);
    const vol24 = Math.abs(c.market.priceChange24hPct ?? 0);
    const vol7d = range && range.min > 0 ? ((range.max - range.min) / range.min) * 100 : 0;
    c.metrics.volatility_24h_pct = c.market.priceChange24hPct === undefined ? null : vol24;
    c.metrics.volatility_7d_pct = range ? vol7d : null;
    return r;
  });
}

// ---------------------------------------------------------------- Stage 6 — Score

export interface Scored {
  cand: PoolCandidate;
  score: number;
  components: Record<string, number>;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export function scoreCandidate(c: PoolCandidate, cfg: ScreenerConfig, tokenSafety: number): Scored {
  const s = cfg.score;
  const w = s.weights;
  const feeApr = c.metrics.fee_apr ?? 0;
  const volTvl = c.metrics.volume_tvl_ratio ?? 0;
  // Healthy turnover is ~0.5–10x/day; beyond 20x it is increasingly suspicious.
  let volumeQuality = volTvl < 0.5 ? volTvl / 0.5 : volTvl <= 10 ? 1 : volTvl <= 20 ? 1 - (volTvl - 10) / 20 : 0.5 * clamp01(1 - (volTvl - 20) / 30);
  const utr = c.metrics.unique_trader_ratio;
  if (utr !== undefined && utr !== null) volumeQuality *= clamp01(utr / 0.1);
  else volumeQuality *= 0.7; // unknown trader count: partial credit
  if (c.flags.some((f) => f.startsWith("WASH_TRADING"))) volumeQuality *= 0.25; // heavy penalty

  const components = {
    fee_apr_adj: clamp01(Math.min(feeApr, s.fee_apr_cap) / s.fee_apr_cap),
    volume_quality: clamp01(volumeQuality),
    liquidity_depth: clamp01(Math.log10(Math.max(1, c.pool.tvlUsd)) / Math.log10(s.tvl_full_credit)),
    token_safety: clamp01(tokenSafety),
    age: clamp01((c.metrics.pool_age_hours ?? 0) / 24 / s.age_full_credit_days),
    volatility_penalty: clamp01(Math.max(c.metrics.volatility_24h_pct ?? 0, (c.metrics.volatility_7d_pct ?? 0) / 2) / 50),
  };
  const score =
    100 *
    (w.fee_apr_adj * components.fee_apr_adj +
      w.volume_quality * components.volume_quality +
      w.liquidity_depth * components.liquidity_depth +
      w.token_safety * components.token_safety +
      w.age * components.age -
      w.volatility_penalty * components.volatility_penalty);
  return { cand: c, score, components };
}

// ----------------------------------------------------------------

export function partition(
  cands: PoolCandidate[],
  stage: Rejection["stage"],
  check: (c: PoolCandidate) => string[],
): StageResult<PoolCandidate> {
  const passed: PoolCandidate[] = [];
  const rejected: Rejection[] = [];
  for (const c of cands) {
    const reasons = check(c);
    if (reasons.length) rejected.push({ pool: c.pool.address, token_mint: c.token.mint, stage, reasons });
    else passed.push(c);
  }
  return { passed, rejected };
}
