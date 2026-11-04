import type { ChainReader, HolderFact, MintFacts } from "../src/chain/reader";
import { SOL_MINT, USDC_MINT } from "../src/config/load";
import type { JupiterLike, MarketSource, PoolSource, Quote, RugCheckLike, RugReport } from "../src/screener/sources/index";
import type { PoolMarket, RawPool, TokenMarket, TokenMeta } from "../src/screener/types";
import { DAY } from "../src/types";

export const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

export function cleanMint(mint: string, over: Partial<MintFacts> = {}): MintFacts {
  return {
    mint, program: "spl", decimals: 6, supply: 1_000_000_000n * 10n ** 6n, mintAuthority: null, freezeAuthority: null,
    extensions: [], transferFeeBps: 0, transferHookProgram: null, permanentDelegate: null,
    defaultAccountStateFrozen: false, pausable: false, ...over,
  };
}

/** 20 holders with ~2% each = 40%... use 1.2% each for a healthy distribution. */
export function spreadHolders(mint: string, supply = 1_000_000_000n * 10n ** 6n, pctEach = 1.2, n = 20): HolderFact[] {
  return Array.from({ length: n }, (_, i) => ({
    tokenAccount: `${mint}-ta${i}`,
    owner: `${mint}-owner${i}`,
    amount: (supply * BigInt(Math.round(pctEach * 100))) / 10_000n,
    ownerProgram: null,
  }));
}

export class FakeChain implements ChainReader {
  facts = new Map<string, MintFacts>();
  holders = new Map<string, HolderFact[]>();
  meta = new Map<string, TokenMeta>();
  funders = new Map<string, string>();
  failMints = new Set<string>();
  async getMintFacts(mint: string) {
    if (this.failMints.has(mint)) throw new Error("rpc down");
    return this.facts.get(mint) ?? cleanMint(mint);
  }
  async getLargestHolders(mint: string) {
    return this.holders.get(mint) ?? spreadHolders(mint);
  }
  async getAssetMeta(mint: string) {
    return this.meta.get(mint) ?? null;
  }
  async fundingSource(wallet: string) {
    return this.funders.get(wallet) ?? null;
  }
}

export class FakeJupiter implements JupiterLike {
  verified = new Set<string>([SOL_MINT, USDC_MINT]);
  /** mint → round-trip loss % (default 0.5%). null = no sell route. */
  roundtrip = new Map<string, number | null>();
  noBuy = new Set<string>();
  prices = new Map<string, number>([[SOL_MINT, 150], [USDC_MINT, 1]]);
  async verifiedMints() {
    return this.verified;
  }
  async quote(input: string, output: string, amount: bigint): Promise<Quote | null> {
    const base = input === USDC_MINT || input === SOL_MINT;
    const token = base ? output : input;
    if (base) {
      if (this.noBuy.has(token)) return null;
      return { inAmount: amount, outAmount: amount * 1000n, priceImpactPct: 0.1, programIds: [] };
    }
    const loss = this.roundtrip.has(token) ? this.roundtrip.get(token)! : 0.5;
    if (loss === null) return null;
    const back = (amount / 1000n) * BigInt(Math.round((100 - loss) * 100)) / 10_000n;
    return { inAmount: amount, outAmount: back, priceImpactPct: 0.1, programIds: [] };
  }
  async pricesUsd(mints: string[]) {
    return new Map(mints.filter((m) => this.prices.has(m)).map((m) => [m, this.prices.get(m)!]));
  }
}

export class FakeRug implements RugCheckLike {
  reports = new Map<string, RugReport>();
  async report(mint: string) {
    return this.reports.get(mint) ?? { score: 100, risks: [] };
  }
}

export class FakeMarket implements MarketSource {
  pool = new Map<string, PoolMarket>();
  token = new Map<string, TokenMarket & { meta?: TokenMeta }>();
  async pools(addresses: string[]) {
    return new Map(
      addresses.map((a) => [a, this.pool.get(a) ?? { pairCreatedAt: NOW - 30 * DAY, txns24h: 5000, uniqueTraders24h: 900, priceChange24hPct: 4 }]),
    );
  }
  async tokens(mints: string[]) {
    return new Map(mints.map((m) => [m, this.token.get(m) ?? { firstPairCreatedAt: NOW - 60 * DAY, liquidityUsd: 1e6 }]));
  }
}

export class FakePools implements PoolSource {
  readonly dex = "meteora_dlmm" as const;
  constructor(public pools: RawPool[]) {}
  async fetchPools() {
    return this.pools;
  }
}

let n = 0;
export function pool(token: TokenMeta, over: Partial<RawPool> = {}, base: "SOL" | "USDC" = "SOL"): RawPool {
  n++;
  const b: TokenMeta = base === "SOL" ? { mint: SOL_MINT, symbol: "SOL", name: "Wrapped SOL" } : { mint: USDC_MINT, symbol: "USDC", name: "USD Coin" };
  return {
    address: over.address ?? `pool-${token.symbol}-${n}`,
    dex: "meteora_dlmm",
    tokenX: token,
    tokenY: b,
    binStep: 20,
    feeBps: 20,
    tvlUsd: 500_000,
    volume24hUsd: 1_500_000,
    fees24hUsd: 3_000,
    price: 0.001,
    ...over,
  };
}

export const tok = (mint: string, symbol: string, name = symbol): TokenMeta => ({ mint, symbol, name });
