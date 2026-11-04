import { chunk, fetchJson, HttpError } from "../../lib/http";
import type { JupiterLike, Quote } from "./index";

interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { ammKey?: string; label?: string } }[];
}

/** Jupiter lite API (tokens v2, swap v1 quote, price v3). Read-only: quotes, never swaps. */
export class JupiterSource implements JupiterLike {
  private verifiedCache: { at: number; mints: Set<string> } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async verifiedMints(): Promise<Set<string>> {
    if (this.verifiedCache && Date.now() - this.verifiedCache.at < 6 * 3600_000) return this.verifiedCache.mints;
    const list = await fetchJson<{ id: string }[]>(`${this.baseUrl}/tokens/v2/tag?query=verified`, {
      timeoutMs: this.timeoutMs,
    });
    const mints = new Set(list.map((t) => t.id));
    this.verifiedCache = { at: Date.now(), mints };
    return mints;
  }

  async quote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<Quote | null> {
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
    });
    try {
      const r = await fetchJson<JupQuote & { error?: string }>(`${this.baseUrl}/swap/v1/quote?${q}`, {
        timeoutMs: this.timeoutMs,
      });
      if (r.error || !r.outAmount) return null;
      return {
        inAmount: BigInt(r.inAmount),
        outAmount: BigInt(r.outAmount),
        priceImpactPct: Number(r.priceImpactPct) * 100,
        // Jupiter v6 program is always involved; DEX programs are not exposed in the quote.
        programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      };
    } catch (e) {
      // 400 = no route (e.g. COULD_NOT_FIND_ANY_ROUTE / TOKEN_NOT_TRADABLE)
      if (e instanceof HttpError && e.status === 400) return null;
      throw e;
    }
  }

  async pricesUsd(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const batch of chunk(mints, 50)) {
      const r = await fetchJson<Record<string, { usdPrice?: number }>>(
        `${this.baseUrl}/price/v3?ids=${batch.join(",")}`,
        { timeoutMs: this.timeoutMs },
      );
      for (const [mint, v] of Object.entries(r ?? {})) if (v?.usdPrice) out.set(mint, v.usdPrice);
    }
    return out;
  }
}
