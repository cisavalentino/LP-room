import type { KnownAsset } from "../config/schema";
import type { TokenMeta } from "./types";

/**
 * Stage 3 — token identity. Tokens are identified by mint only; symbols and names are
 * untrusted strings that we normalise purely to detect impersonation.
 */

const ZERO_WIDTH_CLASS = "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\u00AD\\u034F\\u180E]";
const ZERO_WIDTH = new RegExp(ZERO_WIDTH_CLASS, "g");
const HAS_ZERO_WIDTH = new RegExp(ZERO_WIDTH_CLASS);

/** Confusable characters → Latin. Covers Cyrillic, Greek, and common digit/symbol swaps. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "с": "c", "е": "e", "ё": "e", "һ": "h", "і": "i", "ї": "i", "ј": "j", "к": "k",
  "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԝ": "w",
  "ь": "b", "п": "n", "г": "r", "д": "a", "л": "n", "з": "e", "ч": "a",
  // Greek
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x", "ω": "w", "μ": "u", "ς": "s", "σ": "o", "δ": "d", "ζ": "z",
  // digits / symbols
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g",
  "$": "s", "@": "a", "|": "l", "!": "l", "€": "e", "£": "l", "¢": "c", "¥": "y",
  // i/l/I collapse to one glyph class
  "i": "l",
};

/** NFKC + strip zero-width + lower-case. Display normalisation. */
export function normalize(s: string): string {
  return s.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase().trim();
}

/**
 * Visual "skeleton": two strings with the same skeleton look alike.
 * `USDC.`, `U$DC`, `ＵＳＤＣ`, `US​DC`, `ՍЅDС` → "usdc"; `B0NK` → "bonk"; `WlF` / `WIF` → "wlf".
 */
export function skeleton(s: string): string {
  let out = normalize(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, ""); // strip accents (é → e)
  out = Array.from(out, (ch) => CONFUSABLES[ch] ?? ch).join("");
  out = out.replace(/rn/g, "m").replace(/vv/g, "w");
  // Drop everything that is not a latin letter or digit (punctuation, spaces, emoji, other scripts' marks).
  return out.replace(/[^a-z0-9]/g, "");
}

export interface KnownAssetIndex {
  byMint: Map<string, KnownAsset>;
  bySkeleton: Map<string, KnownAsset>;
}

export function indexKnownAssets(assets: KnownAsset[]): KnownAssetIndex {
  const byMint = new Map<string, KnownAsset>();
  const bySkeleton = new Map<string, KnownAsset>();
  for (const a of assets) {
    byMint.set(a.mint, a);
    bySkeleton.set(skeleton(a.symbol), a);
    bySkeleton.set(skeleton(a.name), a);
  }
  return { byMint, bySkeleton };
}

/** Known-asset protection + lookalike detection. Returns the impersonated asset, if any. */
export function impersonatedAsset(token: TokenMeta, idx: KnownAssetIndex): KnownAsset | undefined {
  if (idx.byMint.has(token.mint)) return undefined;
  for (const s of [token.symbol, token.name]) {
    const sk = skeleton(s);
    if (!sk) continue;
    const hit = idx.bySkeleton.get(sk);
    if (hit) return hit;
  }
  return undefined;
}

/** True when the string contains characters outside printable ASCII after NFKC (mixed scripts etc). */
export function hasSuspiciousChars(s: string): boolean {
  const n = s.normalize("NFKC");
  return HAS_ZERO_WIDTH.test(s) || /[^\x20-\x7E]/.test(n.replace(/\p{Extended_Pictographic}/gu, ""));
}

/** Metadata red flags: scam words, URLs in name/symbol. */
export function metadataRedFlags(token: TokenMeta, patterns: string[]): string[] {
  const flags: string[] = [];
  const text = normalize(`${token.symbol} ${token.name}`);
  for (const p of patterns) {
    const pat = p.toLowerCase();
    const isWord = /^[a-z]+$/.test(pat);
    const hit = isWord ? new RegExp(`\\b${pat}\\b`).test(text) : text.includes(pat);
    if (hit) flags.push(`METADATA_RED_FLAG:${p}`);
  }
  if (/https?:\/\/|[a-z0-9-]+\.(com|io|xyz|net|org|app|fun|gg)\b/.test(text) && !flags.some((f) => f.includes("http"))) {
    flags.push("METADATA_URL_IN_NAME");
  }
  return [...new Set(flags)];
}

export interface CanonicalInput {
  mint: string;
  symbol: string;
  liquidityUsd: number;
  /** Earliest known creation time; undefined = unknown. */
  createdAt?: number;
}

/**
 * Canonical token resolution. Groups tokens by symbol skeleton. Within a group of >1 mints the
 * canonical mint is (a) the one on Jupiter's verified/strict list, else (b) the one that has both
 * the largest liquidity and the oldest age. If no mint satisfies (b) the whole group is ambiguous.
 *
 * Returns mint → verdict for every mint in a duplicated group. Mints in singleton groups are omitted.
 */
export function resolveCanonical(
  tokens: CanonicalInput[],
  verified: ReadonlySet<string>,
  known: KnownAssetIndex,
): Map<string, "CANONICAL" | "IMPERSONATOR" | "AMBIGUOUS"> {
  const groups = new Map<string, CanonicalInput[]>();
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t.mint)) continue;
    seen.add(t.mint);
    const key = skeleton(t.symbol);
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(t);
    groups.set(key, g);
  }
  const out = new Map<string, "CANONICAL" | "IMPERSONATOR" | "AMBIGUOUS">();
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    // A known asset always owns its symbol.
    const knownHit = known.bySkeleton.get(key);
    let canonical: string | undefined = knownHit && g.some((t) => t.mint === knownHit.mint) ? knownHit.mint : undefined;
    if (!canonical) {
      const v = g.filter((t) => verified.has(t.mint));
      if (v.length === 1) canonical = v[0]!.mint;
      else if (v.length > 1) {
        // Several verified mints share a symbol: pick by liquidity among verified ones.
        canonical = [...v].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]!.mint;
      }
    }
    if (!canonical && !knownHit) {
      const byLiq = [...g].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]!;
      const dated = g.filter((t) => t.createdAt !== undefined);
      const oldest = [...dated].sort((a, b) => a.createdAt! - b.createdAt!)[0];
      if (oldest && oldest.mint === byLiq.mint) canonical = byLiq.mint;
    }
    for (const t of g) {
      if (canonical) out.set(t.mint, t.mint === canonical ? "CANONICAL" : "IMPERSONATOR");
      else out.set(t.mint, knownHit ? "IMPERSONATOR" : "AMBIGUOUS");
    }
  }
  return out;
}
