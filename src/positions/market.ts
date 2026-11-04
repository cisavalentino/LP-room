import { SOL_MINT, USDC_MINT } from "../config/load";
import type { JupiterLike } from "../screener/sources/index";
import type { MeteoraDlmmSource } from "../screener/sources/meteora";

/** Live state of a pool, as the monitor needs it. */
export interface PoolState {
  address: string;
  mintX: string;
  mintY: string;
  /** X in Y, UI units */
  price: number;
  binStep: number;
  tvlUsd: number;
  volume24hUsd: number;
  fees24hUsd: number;
}

export interface PoolStateSource {
  getPoolState(address: string): Promise<PoolState>;
}

export interface PriceSource {
  /** USD prices by mint. Missing mints are omitted. */
  pricesUsd(mints: string[]): Promise<Map<string, number>>;
}

export class MeteoraPoolState implements PoolStateSource {
  constructor(private readonly meteora: MeteoraDlmmSource) {}
  async getPoolState(address: string): Promise<PoolState> {
    const p = await this.meteora.fetchPool(address);
    if (!p || !p.binStep) throw new Error(`pool ${address} not found`);
    return {
      address,
      mintX: p.tokenX.mint,
      mintY: p.tokenY.mint,
      price: p.price,
      binStep: p.binStep,
      tvlUsd: p.tvlUsd,
      volume24hUsd: p.volume24hUsd,
      fees24hUsd: p.fees24hUsd,
    };
  }
}

/** Jupiter prices, with USDC pinned to $1 if Jupiter omits it. */
export class JupiterPrices implements PriceSource {
  constructor(private readonly jup: JupiterLike) {}
  async pricesUsd(mints: string[]): Promise<Map<string, number>> {
    const m = await this.jup.pricesUsd([...new Set([...mints, SOL_MINT])]);
    if (!m.has(USDC_MINT)) m.set(USDC_MINT, 1);
    return m;
  }
}
