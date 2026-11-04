import type { PoolMarket, RawPool, TokenMarket, TokenMeta } from "../types";

/** Stage 1 — pool lists. One implementation per DEX. */
export interface PoolSource {
  readonly dex: RawPool["dex"];
  fetchPools(): Promise<RawPool[]>;
}

/** DexScreener / Birdeye: pair age, txns, traders, socials. */
export interface MarketSource {
  pools(addresses: string[]): Promise<Map<string, PoolMarket>>;
  tokens(mints: string[]): Promise<Map<string, TokenMarket & { meta?: TokenMeta }>>;
}

export interface Quote {
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  programIds: string[];
}

/** Jupiter: verified list, quotes, prices. */
export interface JupiterLike {
  verifiedMints(): Promise<Set<string>>;
  /** null = no route. */
  quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote | null>;
  pricesUsd(mints: string[]): Promise<Map<string, number>>;
}

export interface RugReport {
  score: number;
  risks: { name: string; level: string }[];
}

export interface RugCheckLike {
  report(mint: string): Promise<RugReport | null>;
}
