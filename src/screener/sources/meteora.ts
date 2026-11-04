import { fetchJson } from "../../lib/http";
import type { RawPool } from "../types";
import type { PoolSource } from "./index";

/** Shape of a pair from the Meteora DLMM API (`GET /pair/all`). Untrusted input. */
export interface MeteoraPair {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x?: string;
  reserve_y?: string;
  bin_step: number;
  base_fee_percentage: string | number;
  liquidity: string | number;
  trade_volume_24h: number | string;
  fees_24h: number | string;
  current_price: number | string;
  hide?: boolean;
  is_blacklisted?: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export function mapMeteoraPair(p: MeteoraPair): RawPool | null {
  if (!p?.address || !p.mint_x || !p.mint_y) return null;
  const [symX = "", symY = ""] = String(p.name ?? "").split("-");
  return {
    address: p.address,
    dex: "meteora_dlmm",
    tokenX: { mint: p.mint_x, symbol: symX.trim(), name: symX.trim() },
    tokenY: { mint: p.mint_y, symbol: symY.trim(), name: symY.trim() },
    binStep: num(p.bin_step) || null,
    feeBps: num(p.base_fee_percentage) * 100,
    tvlUsd: num(p.liquidity),
    volume24hUsd: num(p.trade_volume_24h),
    fees24hUsd: num(p.fees_24h),
    price: num(p.current_price),
    reserves: [p.reserve_x, p.reserve_y].filter((x): x is string => !!x),
    hidden: !!p.hide || !!p.is_blacklisted,
  };
}

export class MeteoraDlmmSource implements PoolSource {
  readonly dex = "meteora_dlmm" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async fetchPools(): Promise<RawPool[]> {
    const data = await fetchJson<MeteoraPair[]>(`${this.baseUrl}/pair/all`, { timeoutMs: this.timeoutMs });
    if (!Array.isArray(data)) throw new Error("Meteora /pair/all: unexpected response");
    return data.map(mapMeteoraPair).filter((p): p is RawPool => p !== null);
  }

  async fetchPool(address: string): Promise<RawPool | null> {
    const p = await fetchJson<MeteoraPair>(`${this.baseUrl}/pair/${address}`, { timeoutMs: this.timeoutMs });
    return mapMeteoraPair(p);
  }
}
