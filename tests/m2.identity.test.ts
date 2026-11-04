import { describe, expect, it } from "vitest";
import {
  hasSuspiciousChars,
  impersonatedAsset,
  indexKnownAssets,
  metadataRedFlags,
  resolveCanonical,
  skeleton,
} from "../src/screener/identity";
import { config } from "./helpers";

const cfg = config();
const idx = indexKnownAssets(cfg.knownAssets);
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("skeleton / lookalikes", () => {
  it.each([
    ["USDC.", "usdc"],
    ["U$DC", "usdc"],
    ["ＵＳＤＣ", "usdc"], // full-width (NFKC)
    ["US​DC", "usdc"], // zero-width space
    ["USDС", "usdc"], // Cyrillic С
    ["ВОNK", "bonk"], // Cyrillic В and О
    ["B0NK", "bonk"],
    ["b o n k", "bonk"],
    ["WlF", "wlf"],
    ["WIF", "wlf"],
    ["W1F", "wlf"],
    ["JUР", "jup"], // Cyrillic Р
  ])("%s → %s", (input, out) => {
    expect(skeleton(input)).toBe(out);
  });

  it("flags zero-width / non-ASCII names", () => {
    expect(hasSuspiciousChars("US​DC")).toBe(true);
    expect(hasSuspiciousChars("USDС")).toBe(true);
    expect(hasSuspiciousChars("Normal Token")).toBe(false);
  });
});

describe("known-asset protection", () => {
  it.each(["USDC.", "U$DC", "B0NK", "WlF", "ВОNK", "jup", "Bonk"])("rejects fake %s", (sym) => {
    expect(impersonatedAsset({ mint: "FakeMint1111", symbol: sym, name: "whatever" }, idx)).toBeDefined();
  });

  it("matches on name too", () => {
    expect(impersonatedAsset({ mint: "FakeMint", symbol: "XYZ", name: "dogwifhat" }, idx)?.symbol).toBe("WIF");
  });

  it("does not flag the real mint or unrelated tokens", () => {
    expect(impersonatedAsset({ mint: BONK, symbol: "Bonk", name: "Bonk" }, idx)).toBeUndefined();
    expect(impersonatedAsset({ mint: "X", symbol: "MOODENG", name: "Moo Deng" }, idx)).toBeUndefined();
    expect(impersonatedAsset({ mint: "X", symbol: "BONKERS", name: "Bonkers" }, idx)).toBeUndefined();
  });
});

describe("metadata red flags", () => {
  const flags = cfg.screener.metadata_red_flags;
  it("catches airdrop / claim / URLs", () => {
    expect(metadataRedFlags({ mint: "a", symbol: "FREE", name: "Claim your AIRDROP" }, flags).length).toBeGreaterThan(0);
    expect(metadataRedFlags({ mint: "a", symbol: "X", name: "visit jup-rewards.io" }, flags).length).toBeGreaterThan(0);
    expect(metadataRedFlags({ mint: "a", symbol: "X", name: "https://t.me/scam" }, flags).length).toBeGreaterThan(0);
  });
  it("uses word boundaries for words", () => {
    expect(metadataRedFlags({ mint: "a", symbol: "FRDM", name: "Freedom Coin" }, flags)).toEqual([]);
    expect(metadataRedFlags({ mint: "a", symbol: "CLAIMS", name: "Disclaimer" }, flags)).toEqual([]);
  });
});

describe("canonical token resolution", () => {
  it("verified mint wins among duplicates", () => {
    const r = resolveCanonical(
      [
        { mint: "A", symbol: "MOODENG", liquidityUsd: 10, createdAt: 5 },
        { mint: "B", symbol: "MOODENG", liquidityUsd: 1e6, createdAt: 1 },
      ],
      new Set(["A"]),
      idx,
    );
    expect(r.get("A")).toBe("CANONICAL");
    expect(r.get("B")).toBe("IMPERSONATOR");
  });

  it("else largest liquidity AND oldest", () => {
    const r = resolveCanonical(
      [
        { mint: "A", symbol: "POPX", liquidityUsd: 1e6, createdAt: 1 },
        { mint: "B", symbol: "P0PX", liquidityUsd: 1e3, createdAt: 9 },
      ],
      new Set(),
      idx,
    );
    expect(r.get("A")).toBe("CANONICAL");
    expect(r.get("B")).toBe("IMPERSONATOR");
  });

  it("ambiguous when the richest is not the oldest", () => {
    const r = resolveCanonical(
      [
        { mint: "A", symbol: "NEWX", liquidityUsd: 1e6, createdAt: 9 },
        { mint: "B", symbol: "NEWX", liquidityUsd: 1e3, createdAt: 1 },
      ],
      new Set(),
      idx,
    );
    expect(r.get("A")).toBe("AMBIGUOUS");
    expect(r.get("B")).toBe("AMBIGUOUS");
  });

  it("known asset always owns its symbol; all other BONKs are impersonators", () => {
    const r = resolveCanonical(
      [
        { mint: "FAKE1", symbol: "BONK", liquidityUsd: 1e9, createdAt: 0 },
        { mint: BONK, symbol: "Bonk", liquidityUsd: 1e3, createdAt: 9 },
        { mint: "FAKE2", symbol: "B0NK", liquidityUsd: 1e3 },
      ],
      new Set(["FAKE1"]), // even if a fake somehow got a verified tag
      idx,
    );
    expect(r.get(BONK)).toBe("CANONICAL");
    expect(r.get("FAKE1")).toBe("IMPERSONATOR");
    expect(r.get("FAKE2")).toBe("IMPERSONATOR");
  });
});
