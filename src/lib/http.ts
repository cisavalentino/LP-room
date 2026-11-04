export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchJsonOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
}

/** GET/POST JSON with timeout and simple exponential-backoff retry on 429/5xx/network errors. */
export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { timeoutMs = 15_000, retries = 2, headers = {}, method = "GET", body } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      const err = new HttpError(res.status, `${method} ${redact(url)} → HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}

/** Strip query strings (API keys live there for Helius etc.). */
export function redact(url: string): string {
  return url.replace(/\?.*$/, "?…");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
