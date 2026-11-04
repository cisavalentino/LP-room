import type { ScreenerConfig } from "../config/schema";
import { USDC_MINT } from "../config/load";
import type { ChainReader, HolderFact, MintFacts } from "../chain/reader";
import type { JupiterLike, RugCheckLike, RugReport } from "./sources/index";

/**
 * Stage 4 — token safety, from on-chain reads. Fails closed: if a check cannot be performed the
 * token is rejected (`CHECK_FAILED:*`), except for the secondary RugCheck signal.
 */

export interface HoneypotResult {
  buyOk: boolean;
  sellOk: boolean;
  roundtripLossPct: number | null;
  priceImpactPct: number | null;
}

export interface SafetyInputs {
  facts: MintFacts;
  holders: HolderFact[];
  /** owner → funding wallet, for the holders that were looked up. */
  funders: Map<string, string | null>;
  honeypot: HoneypotResult;
  rug: RugReport | null | "unavailable";
}

export interface SafetyContext {
  /** Pool vault token accounts known from DEX APIs. */
  poolReserves: ReadonlySet<string>;
}

export interface SafetyResult {
  mint: string;
  pass: boolean;
  reasons: string[];
  flags: string[];
  /** 0..1 for scoring; 0 when failed. */
  score: number;
  top10Pct: number | null;
  maxHolderPct: number | null;
  facts?: MintFacts;
}

export function concentration(
  holders: HolderFact[],
  supply: bigint,
  cfg: ScreenerConfig,
  ctx: SafetyContext,
): { counted: { h: HolderFact; pct: number }[]; top10Pct: number; maxPct: number } {
  const s = cfg.safety;
  const excludedOwners = new Set([...s.excluded_holder_owners, ...s.excluded_holder_owners_extra]);
  const excludedPrograms = new Set(s.excluded_owner_programs);
  const counted = holders
    .filter(
      (h) =>
        !ctx.poolReserves.has(h.tokenAccount) &&
        !excludedOwners.has(h.owner) &&
        !(h.ownerProgram && excludedPrograms.has(h.ownerProgram)),
    )
    .map((h) => ({ h, pct: supply > 0n ? Number((h.amount * 1_000_000n) / supply) / 10_000 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  const top10Pct = counted.slice(0, 10).reduce((a, x) => a + x.pct, 0);
  return { counted, top10Pct, maxPct: counted[0]?.pct ?? 0 };
}

export function evaluateSafety(inp: SafetyInputs, cfg: ScreenerConfig, ctx: SafetyContext): SafetyResult {
  const s = cfg.safety;
  const f = inp.facts;
  const reasons: string[] = [];
  const flags: string[] = [];
  let score = 1;

  if (f.program === "not_a_mint") reasons.push("NOT_A_MINT");
  if (f.mintAuthority) reasons.push("MINT_AUTHORITY_NOT_REVOKED");
  if (f.freezeAuthority) reasons.push("FREEZE_AUTHORITY_NOT_REVOKED");

  if (f.program === "token2022") {
    flags.push("TOKEN_2022");
    if (f.permanentDelegate) reasons.push("T22_PERMANENT_DELEGATE");
    if (f.extensions.includes("NonTransferable")) reasons.push("T22_NON_TRANSFERABLE");
    if (f.transferHookProgram && !s.allowed_transfer_hook_programs.includes(f.transferHookProgram)) {
      reasons.push(`T22_TRANSFER_HOOK:${f.transferHookProgram}`);
    }
    if (f.transferFeeBps > s.max_transfer_fee_bps) reasons.push(`T22_TRANSFER_FEE:${f.transferFeeBps}bps`);
    if (f.defaultAccountStateFrozen) reasons.push("T22_DEFAULT_ACCOUNT_FROZEN");
    if (f.pausable) reasons.push("T22_PAUSABLE");
    for (const e of f.extensions) if (e.startsWith("Unknown(")) reasons.push(`T22_UNKNOWN_EXTENSION:${e}`);
  }

  const conc = concentration(inp.holders, f.supply, cfg, ctx);
  if (!inp.holders.length) reasons.push("CHECK_FAILED:HOLDERS");
  else {
    if (conc.top10Pct > s.max_top10_pct) reasons.push(`TOP10_CONCENTRATION:${conc.top10Pct.toFixed(1)}%`);
    if (conc.maxPct > s.max_single_holder_pct) reasons.push(`SINGLE_HOLDER:${conc.maxPct.toFixed(1)}%`);
    score -= 0.3 * Math.min(1, conc.top10Pct / s.max_top10_pct);
  }

  // Insider cluster: holders funded by the same wallet together holding a large share.
  const clusters = new Map<string, { pct: number; n: number }>();
  for (const { h, pct } of conc.counted) {
    const funder = inp.funders.get(h.owner);
    if (!funder) continue;
    const c = clusters.get(funder) ?? { pct: 0, n: 0 };
    c.pct += pct;
    c.n += 1;
    clusters.set(funder, c);
  }
  for (const [funder, c] of clusters) {
    if (c.n >= 2 && c.pct > s.max_insider_cluster_pct) reasons.push(`INSIDER_CLUSTER:${funder}:${c.pct.toFixed(1)}%`);
  }
  if (!inp.funders.size) {
    flags.push("INSIDER_CHECK_SKIPPED");
    score -= 0.05;
  }

  const hp = inp.honeypot;
  if (!hp.buyOk) reasons.push("HONEYPOT:NO_BUY_ROUTE");
  else if (!hp.sellOk) reasons.push("HONEYPOT:NO_SELL_ROUTE");
  else if (hp.roundtripLossPct === null) reasons.push("CHECK_FAILED:HONEYPOT");
  else if (hp.roundtripLossPct > s.max_roundtrip_loss_pct) reasons.push(`HONEYPOT:ROUNDTRIP_LOSS:${hp.roundtripLossPct.toFixed(2)}%`);
  else score -= 0.1 * (hp.roundtripLossPct / Math.max(0.01, s.max_roundtrip_loss_pct));

  if (inp.rug === "unavailable" || inp.rug === null) {
    flags.push("RUGCHECK_UNAVAILABLE");
    score -= 0.05;
  } else {
    if (inp.rug.score > s.rugcheck_danger_score) reasons.push(`RUGCHECK_DANGER:${inp.rug.score}`);
    const dangers = inp.rug.risks.filter((r) => r.level === "danger").map((r) => r.name);
    const warns = inp.rug.risks.filter((r) => r.level === "warn").length;
    for (const d of dangers) flags.push(`RUGCHECK_RISK:${d}`);
    score -= 0.05 * Math.min(4, warns) + 0.1 * Math.min(3, dangers.length);
  }

  const pass = reasons.length === 0;
  return {
    mint: f.mint,
    pass,
    reasons,
    flags,
    score: pass ? Math.max(0, Math.min(1, score)) : 0,
    top10Pct: inp.holders.length ? conc.top10Pct : null,
    maxHolderPct: inp.holders.length ? conc.maxPct : null,
    facts: f,
  };
}

export interface SafetyDeps {
  chain: ChainReader;
  jupiter: JupiterLike;
  rugcheck: RugCheckLike;
}

export async function honeypotTest(jup: JupiterLike, mint: string, usd: number): Promise<HoneypotResult> {
  const inRaw = BigInt(Math.round(usd * 1e6)); // USDC has 6 decimals
  const buy = await jup.quote(USDC_MINT, mint, inRaw, 300);
  if (!buy || buy.outAmount === 0n) return { buyOk: false, sellOk: false, roundtripLossPct: null, priceImpactPct: null };
  const sell = await jup.quote(mint, USDC_MINT, buy.outAmount, 300);
  if (!sell || sell.outAmount === 0n) return { buyOk: true, sellOk: false, roundtripLossPct: null, priceImpactPct: buy.priceImpactPct };
  const loss = (1 - Number(sell.outAmount) / Number(inRaw)) * 100;
  return { buyOk: true, sellOk: true, roundtripLossPct: loss, priceImpactPct: Math.max(buy.priceImpactPct, sell.priceImpactPct) };
}

/** Gathers on-chain + API facts for a token and evaluates them. Never throws. */
export async function checkTokenSafety(
  mint: string,
  deps: SafetyDeps,
  cfg: ScreenerConfig,
  ctx: SafetyContext,
): Promise<SafetyResult> {
  const fail = (reason: string): SafetyResult => ({
    mint, pass: false, reasons: [reason], flags: [], score: 0, top10Pct: null, maxHolderPct: null,
  });
  let facts: MintFacts;
  try {
    facts = await deps.chain.getMintFacts(mint);
  } catch (e) {
    return fail(`CHECK_FAILED:MINT_READ:${(e as Error).message}`);
  }
  let holders: HolderFact[] = [];
  try {
    holders = await deps.chain.getLargestHolders(mint);
  } catch {
    holders = []; // → CHECK_FAILED:HOLDERS in evaluate
  }
  let honeypot: HoneypotResult;
  try {
    honeypot = await honeypotTest(deps.jupiter, mint, cfg.safety.honeypot_test_usd);
  } catch {
    return { ...fail("CHECK_FAILED:HONEYPOT_QUOTE"), facts };
  }
  let rug: RugReport | null | "unavailable";
  try {
    rug = await deps.rugcheck.report(mint);
  } catch {
    rug = "unavailable";
  }
  // Funding sources only for meaningful holders (≥1%), to bound RPC usage.
  const funders = new Map<string, string | null>();
  const conc = concentration(holders, facts.supply, cfg, ctx);
  for (const { h, pct } of conc.counted.slice(0, 10)) {
    if (pct < 1) continue;
    try {
      funders.set(h.owner, await deps.chain.fundingSource(h.owner));
    } catch {
      /* unknown */
    }
  }
  return evaluateSafety({ facts, holders, funders, honeypot, rug }, cfg, ctx);
}
