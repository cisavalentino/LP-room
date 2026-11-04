import type { Config } from "../config/schema";

import type { ChainReader } from "../chain/reader";
import { json } from "../db/db";
import type { Store } from "../db/store";
import { mapLimit } from "../lib/http";
import { logger } from "../lib/log";
import { DAY, HOUR } from "../types";
import {
  impersonatedAsset,
  indexKnownAssets,
  metadataRedFlags,
  resolveCanonical,

  type CanonicalInput,
  type KnownAssetIndex,
} from "./identity";
import { checkTokenSafety, type SafetyResult } from "./safety";
import type { JupiterLike, MarketSource, PoolSource, RugCheckLike } from "./sources/index";
import {
  collect,
  hardFiltersCheap,
  hardFiltersMarket,
  partition,
  poolQuality,
  scoreCandidate,
  type PoolHistoryLookup,
  type Scored,
} from "./stages";
import type { PoolCandidate, Rejection, TokenMeta } from "./types";

export interface ScreenerDeps {
  pools: PoolSource[];
  market: MarketSource;
  jupiter: JupiterLike;
  rugcheck: RugCheckLike;
  chain: ChainReader;
}

export interface ScreenRunResult {
  runId: number;
  stats: Record<string, number>;
  shortlist: Scored[];
  rejected: Rejection[];
}

const log = logger("screener");

/**
 * Screener stages 1–6 (code). Stage 7 (agent review of the top 20) is milestone 6; until then
 * candidates are written with `agent_verdict_json = NULL`.
 *
 * Stages run in PRD order logically, but cheap checks run before ones that need network calls:
 * collect → cheap hard filters → enrich → identity → market hard filters → pool quality → on-chain safety → score.
 */
export class Screener {
  private readonly known: KnownAssetIndex;

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly deps: ScreenerDeps,
  ) {
    this.known = indexKnownAssets(cfg.knownAssets);
  }

  async run(): Promise<ScreenRunResult> {
    const now = this.store.now();
    const runId = this.store.db.run("INSERT INTO screen_runs (started_at) VALUES (?)", [now]).lastInsertRowid;
    const rejected: Rejection[] = [];
    const stats: Record<string, number> = {};

    // Stage 1 — collect
    const raw = (
      await Promise.all(
        this.deps.pools.map((s) =>
          s.fetchPools().catch((e) => {
            log.warn(`pool source ${s.dex} failed: ${(e as Error).message}`);
            return [];
          }),
        ),
      )
    ).flat();
    if (!raw.length) throw new Error("No pools collected from any source");
    const collected = collect(raw);
    rejected.push(...collected.rejected);
    stats.collected = collected.passed.length;
    for (const c of collected.passed) this.persistPool(c);

    // Liquidity per mint across ALL collected pools, for canonical resolution.
    const liquidityByMint = new Map<string, number>();
    for (const c of collected.passed) {
      liquidityByMint.set(c.token.mint, (liquidityByMint.get(c.token.mint) ?? 0) + c.pool.tvlUsd);
    }

    // Stage 2a — cheap hard filters
    const cheap = hardFiltersCheap(collected.passed, this.cfg.screener);
    rejected.push(...cheap.rejected);
    stats.after_cheap_filters = cheap.passed.length;

    // Enrich survivors with market data (age, txns, socials, token age)
    await this.enrich(cheap.passed);

    // Stage 3 — identity (canonical across everything collected)
    const verified = await this.deps.jupiter.verifiedMints().catch((e) => {
      log.warn(`jupiter verified list unavailable: ${(e as Error).message}`);
      return new Set<string>();
    });
    const canonicalInputs: CanonicalInput[] = collected.passed.map((c) => ({
      mint: c.token.mint,
      symbol: c.token.symbol,
      liquidityUsd: liquidityByMint.get(c.token.mint) ?? 0,
      createdAt: c.tokenMarket.firstPairCreatedAt,
    }));
    // Survivors' enriched symbols too (DexScreener names are better than the pool label).
    for (const c of cheap.passed) canonicalInputs.unshift({
      mint: c.token.mint, symbol: c.token.symbol, liquidityUsd: liquidityByMint.get(c.token.mint) ?? 0,
      createdAt: c.tokenMarket.firstPairCreatedAt,
    });
    const canonical = resolveCanonical(canonicalInputs, verified, this.known);
    const brandImages = this.brandImages(cheap.passed, verified);
    const ident = partition(cheap.passed, "identity", (c) => this.identityReasons(c.token, canonical, brandImages, c.market.imageUrl));
    rejected.push(...ident.rejected);
    stats.after_identity = ident.passed.length;

    // Stage 2b — hard filters needing market data
    const market = hardFiltersMarket(ident.passed, this.cfg.screener, now);
    rejected.push(...market.rejected);
    stats.after_market_filters = market.passed.length;

    // Stage 5 — pool quality
    const quality = poolQuality(market.passed, this.cfg.screener, this.historyLookup(now));
    rejected.push(...quality.rejected);
    stats.after_pool_quality = quality.passed.length;

    // Stage 4 — on-chain token safety (one check per mint)
    const poolReserves = new Set(raw.flatMap((p) => p.reserves ?? []));
    const mints = [...new Set(quality.passed.map((c) => c.token.mint))];
    const safety = new Map<string, SafetyResult>();
    await mapLimit(mints, 4, async (mint) => {
      safety.set(mint, await this.checkToken(mint, canonical, brandImages, poolReserves));
    });
    const safe = partition(quality.passed, "safety", (c) => {
      const s = safety.get(c.token.mint)!;
      c.flags.push(...s.flags);
      c.metrics.top10_pct = s.top10Pct;
      c.metrics.max_holder_pct = s.maxHolderPct;
      return s.reasons;
    });
    rejected.push(...safe.rejected);
    stats.after_safety = safe.passed.length;

    // Stage 6 — score, keep top N
    const scored = safe.passed
      .map((c) => scoreCandidate(c, this.cfg.screener, safety.get(c.token.mint)?.score ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.screener.score.keep_top);
    stats.shortlisted = scored.length;

    this.persistRun(runId, scored, rejected, stats);
    log.info("screen run complete", stats);
    return { runId, stats, shortlist: scored, rejected };
  }

  /** On-demand re-check of tokens already held (identity + on-chain safety). Updates `tokens`. */
  async recheckTokens(mints: string[]): Promise<SafetyResult[]> {
    const verified = await this.deps.jupiter.verifiedMints().catch(() => new Set<string>());
    const results: SafetyResult[] = [];
    for (const mint of mints) {
      if (this.known.byMint.has(mint)) continue;
      const tok = this.store.getToken(mint);
      const canonical = resolveCanonical([], verified, this.known);
      const r = await this.checkToken(mint, canonical, new Map(), new Set(), tok ?? undefined);
      results.push(r);
    }
    return results;
  }

  // ------------------------------------------------------------------ internals

  private identityReasons(
    token: TokenMeta,
    canonical: Map<string, "CANONICAL" | "IMPERSONATOR" | "AMBIGUOUS">,
    brandImages: Map<string, string>,
    image?: string,
  ): string[] {
    if (this.known.byMint.has(token.mint)) return [];
    const r: string[] = [];
    const imp = impersonatedAsset(token, this.known);
    if (imp) r.push(`IMPERSONATOR:${imp.symbol}`);
    const v = canonical.get(token.mint);
    if (v === "IMPERSONATOR" && !imp) r.push(`IMPERSONATOR:DUPLICATE_SYMBOL:${token.symbol}`);
    if (v === "AMBIGUOUS") r.push(`AMBIGUOUS_SYMBOL:${token.symbol}`);
    r.push(...metadataRedFlags(token, this.cfg.screener.metadata_red_flags));
    for (const img of [image, token.image, token.uri]) {
      const owner = img ? brandImages.get(img) : undefined;
      if (owner && owner !== token.mint) r.push("COPIED_BRANDING");
    }
    return [...new Set(r)];
  }

  /** image/uri → mint, for known & verified tokens (to catch copied logos). */
  private brandImages(cands: PoolCandidate[], verified: ReadonlySet<string>): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of cands) {
      if (!this.known.byMint.has(c.token.mint) && !verified.has(c.token.mint)) continue;
      for (const img of [c.market.imageUrl, c.token.image, c.token.uri]) if (img) m.set(img, c.token.mint);
    }
    return m;
  }

  private async checkToken(
    mint: string,
    canonical: Map<string, "CANONICAL" | "IMPERSONATOR" | "AMBIGUOUS">,
    brandImages: Map<string, string>,
    poolReserves: Set<string>,
    fallbackMeta?: TokenMeta,
  ): Promise<SafetyResult> {
    if (this.known.byMint.has(mint)) {
      // Allowlisted majors (incl. USDC/USDT, which legitimately keep a freeze authority).
      const a = this.known.byMint.get(mint)!;
      this.store.upsertToken({ mint, symbol: a.symbol, name: a.name, decimals: this.store.getToken(mint)?.decimals ?? 0, program: "unknown", is_major: true });
      this.store.setTokenVerdict(mint, "PASS", ["KNOWN_MAJOR"], 1);
      return { mint, pass: true, reasons: [], flags: ["KNOWN_MAJOR"], score: 1, top10Pct: null, maxHolderPct: null };
    }
    const result = await checkTokenSafety(mint, this.deps, this.cfg.screener, { poolReserves });
    // On-chain metadata is the final word on name/symbol: re-run identity on it.
    const meta = await this.deps.chain.getAssetMeta(mint).catch(() => null);
    if (meta && (meta.symbol || meta.name)) {
      const extra = this.identityReasons(meta, canonical, brandImages);
      result.reasons.push(...extra.filter((x) => !result.reasons.includes(x)));
      if (result.reasons.length) {
        result.pass = false;
        result.score = 0;
      }
    }
    const m = meta ?? fallbackMeta ?? this.store.getToken(mint);
    this.store.upsertToken({
      mint,
      symbol: m?.symbol ?? "",
      name: m?.name ?? "",
      decimals: result.facts?.decimals ?? m?.decimals ?? 0,
      program: result.facts?.program === "token2022" ? "token2022" : result.facts?.program === "spl" ? "spl" : "unknown",
      is_major: false,
    });
    this.store.setTokenVerdict(mint, result.pass ? "PASS" : "REJECT", [...result.reasons, ...result.flags], result.score);
    return result;
  }

  private async enrich(cands: PoolCandidate[]): Promise<void> {
    if (!cands.length) return;
    try {
      const pools = await this.deps.market.pools(cands.map((c) => c.pool.address));
      for (const c of cands) c.market = pools.get(c.pool.address) ?? {};
    } catch (e) {
      log.warn(`market pools enrichment failed: ${(e as Error).message}`);
    }
    try {
      const tokens = await this.deps.market.tokens([...new Set(cands.map((c) => c.token.mint))]);
      for (const c of cands) {
        const t = tokens.get(c.token.mint);
        if (!t) continue;
        c.tokenMarket = { firstPairCreatedAt: t.firstPairCreatedAt, liquidityUsd: t.liquidityUsd };
        if (t.meta) c.token = { ...c.token, symbol: t.meta.symbol || c.token.symbol, name: t.meta.name || c.token.name };
      }
    } catch (e) {
      log.warn(`market tokens enrichment failed: ${(e as Error).message}`);
    }
  }

  private historyLookup(now: number): PoolHistoryLookup {
    const store = this.store;
    return {
      tvl24hAgo(pool) {
        const rows = store.db.all<{ tvl_usd: number | null }>(
          "SELECT tvl_usd FROM pool_history WHERE pool = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 1",
          [pool, now - 26 * HOUR, now - 22 * HOUR],
        );
        return rows[0]?.tvl_usd ?? undefined;
      },
      priceRange7d(pool) {
        const r = store.db.get<{ mn: number | null; mx: number | null; n: number; span: number | null }>(
          "SELECT MIN(price) mn, MAX(price) mx, COUNT(*) n, MAX(ts) - MIN(ts) span FROM pool_history WHERE pool = ? AND ts >= ? AND price > 0",
          [pool, now - 7 * DAY],
        );
        if (!r || r.n < 2 || r.mn === null || r.mx === null || (r.span ?? 0) < 12 * HOUR) return undefined;
        return { min: r.mn, max: r.mx };
      },
    };
  }

  private persistPool(c: PoolCandidate): void {
    const p = c.pool;
    this.store.upsertPool({
      address: p.address,
      dex: p.dex,
      mint_x: p.tokenX.mint,
      mint_y: p.tokenY.mint,
      bin_step: p.binStep,
      fee_bps: p.feeBps,
      tvl_usd: p.tvlUsd,
      volume_24h_usd: p.volume24hUsd,
      fees_24h_usd: p.fees24hUsd,
      fee_apr: p.tvlUsd > 0 ? (p.fees24hUsd / p.tvlUsd) * 365 * 100 : 0,
      price: p.price,
      created_at: c.market.pairCreatedAt ?? null,
    });
  }

  private persistRun(runId: number, scored: Scored[], rejected: Rejection[], stats: Record<string, number>): void {
    const now = this.store.now();
    this.store.db.tx(() => {
      scored.forEach((s, i) => {
        const c = s.cand;
        if (c.market.pairCreatedAt) {
          this.store.db.run("UPDATE pools SET created_at = ? WHERE address = ?", [c.market.pairCreatedAt, c.pool.address]);
        }
        this.store.db.run(
          `INSERT INTO candidates (run_id, pool, token_mint, base_mint, score, rank, reasons_json, metrics_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId, c.pool.address, c.token.mint, c.base.mint, s.score, i + 1,
            json.str({ flags: c.flags, components: s.components }),
            json.str({ ...c.metrics, tvl_usd: c.pool.tvlUsd, volume_24h_usd: c.pool.volume24hUsd, fees_24h_usd: c.pool.fees24hUsd, symbol: c.token.symbol, base_symbol: c.base.symbol, websites: c.market.websites ?? [], socials: c.market.socials ?? [] }),
            now,
          ],
        );
      });
      for (const r of rejected) {
        // Skip logging the bulk "too small" rejections to keep the table useful.
        if (r.stage === "hard_filter" && r.reasons.every((x) => x.startsWith("TVL_TOO_LOW") || x.startsWith("VOLUME_TOO_LOW"))) continue;
        this.store.db.run(
          "INSERT INTO screen_rejections (run_id, pool, token_mint, stage, reasons_json) VALUES (?, ?, ?, ?, ?)",
          [runId, r.pool, r.token_mint, r.stage, json.str(r.reasons)],
        );
      }
      this.store.db.run("UPDATE screen_runs SET finished_at = ?, stats_json = ? WHERE id = ?", [now, json.str(stats), runId]);
    });
  }
}

