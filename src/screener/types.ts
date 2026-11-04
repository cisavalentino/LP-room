import type { Dex } from "../types";

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals?: number;
  /** Metadata URI / image URL, used to catch copied branding. */
  uri?: string;
  image?: string;
}

/** Stage 1 output: a pool as reported by the DEX API. Untrusted. */
export interface RawPool {
  address: string;
  dex: Dex;
  tokenX: TokenMeta;
  tokenY: TokenMeta;
  binStep: number | null;
  feeBps: number | null;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
  /** Price of X in Y (UI units). */
  price: number;
  /** Pool vault token accounts (excluded from holder concentration). */
  reserves?: string[];
  hidden?: boolean;
}

/** Market data from DexScreener / Birdeye. Every field may be unknown. */
export interface PoolMarket {
  pairCreatedAt?: number;
  txns24h?: number;
  uniqueTraders24h?: number;
  priceChange1hPct?: number;
  priceChange24hPct?: number;
  websites?: string[];
  socials?: { type: string; url: string }[];
  imageUrl?: string;
}

export interface TokenMarket {
  /** Earliest pair creation across all DEXes ≈ token age. */
  firstPairCreatedAt?: number;
  /** Sum of liquidity across all pairs. */
  liquidityUsd?: number;
}

/** A pool after stage 1, oriented as (token, base). */
export interface PoolCandidate {
  pool: RawPool;
  token: TokenMeta;
  base: TokenMeta;
  /** true when the non-base token is tokenX. */
  tokenIsX: boolean;
  market: PoolMarket;
  tokenMarket: TokenMarket;
  flags: string[];
  metrics: Record<string, number | null>;
}

export interface Rejection {
  pool: string;
  token_mint: string | null;
  stage: "collect" | "hard_filter" | "identity" | "safety" | "pool_quality";
  reasons: string[];
}

export interface StageResult<T> {
  passed: T[];
  rejected: Rejection[];
}
