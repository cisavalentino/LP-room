import { fetchJson, HttpError } from "../../lib/http";
import type { RugCheckLike, RugReport } from "./index";

/** RugCheck summary report. Secondary signal only — never the sole reason a token passes. */
export class RugCheckSource implements RugCheckLike {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async report(mint: string): Promise<RugReport | null> {
    try {
      const r = await fetchJson<{ score?: number; risks?: { name: string; level: string }[] }>(
        `${this.baseUrl}/v1/tokens/${mint}/report/summary`,
        { timeoutMs: this.timeoutMs, retries: 1 },
      );
      return { score: Number(r.score ?? 0), risks: r.risks ?? [] };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }
}
