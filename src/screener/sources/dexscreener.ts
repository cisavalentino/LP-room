import { chunk, fetchJson } from "../../lib/http";
import type { PoolMarket, TokenMarket, TokenMeta } from "../types";
import type { MarketSource } from "./index";

interface DsPair {
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  pairCreatedAt?: number;
  txns?: { h24?: { buys: number; sells: number } };
  priceChange?: { h1?: number; h24?: number };
  liquidity?: { usd?: number };
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

export function mapDsPair(p: DsPair): PoolMarket {
  const t = p.txns?.h24;
  return {
    pairCreatedAt: p.pairCreatedAt,
    txns24h: t ? (t.buys ?? 0) + (t.sells ?? 0) : undefined,
    priceChange1hPct: p.priceChange?.h1,
    priceChange24hPct: p.priceChange?.h24,
    websites: p.info?.websites?.map((w) => w.url),
    socials: p.info?.socials,
    imageUrl: p.info?.imageUrl,
  };
}

export class DexScreenerSource implements MarketSource {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async pools(addresses: string[]): Promise<Map<string, PoolMarket>> {
    const out = new Map<string, PoolMarket>();
    for (const batch of chunk(addresses, 30)) {
      const data = await fetchJson<{ pairs?: DsPair[] | null }>(
        `${this.baseUrl}/latest/dex/pairs/solana/${batch.join(",")}`,
        { timeoutMs: this.timeoutMs },
      );
      for (const p of data.pairs ?? []) out.set(p.pairAddress, mapDsPair(p));
    }
    return out;
  }

  async tokens(mints: string[]): Promise<Map<string, TokenMarket & { meta?: TokenMeta }>> {
    const out = new Map<string, TokenMarket & { meta?: TokenMeta }>();
    for (const batch of chunk(mints, 30)) {
      const pairs = await fetchJson<DsPair[]>(`${this.baseUrl}/tokens/v1/solana/${batch.join(",")}`, {
        timeoutMs: this.timeoutMs,
      });
      for (const p of Array.isArray(pairs) ? pairs : []) {
        for (const side of [p.baseToken, p.quoteToken]) {
          if (!batch.includes(side.address)) continue;
          const cur = out.get(side.address) ?? { liquidityUsd: 0 };
          cur.liquidityUsd = (cur.liquidityUsd ?? 0) + (p.liquidity?.usd ?? 0);
          if (p.pairCreatedAt && (!cur.firstPairCreatedAt || p.pairCreatedAt < cur.firstPairCreatedAt)) {
            cur.firstPairCreatedAt = p.pairCreatedAt;
          }
          cur.meta ??= { mint: side.address, symbol: side.symbol, name: side.name };
          out.set(side.address, cur);
        }
      }
    }
    return out;
  }
}
