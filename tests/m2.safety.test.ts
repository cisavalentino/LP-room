import { describe, expect, it } from "vitest";
import { evaluateSafety, checkTokenSafety, type SafetyInputs } from "../src/screener/safety";
import { cleanMint, FakeChain, FakeJupiter, FakeRug, spreadHolders } from "./fakes";
import { config } from "./helpers";

const cfg = config().screener;
const ctx = { poolReserves: new Set<string>() };
const okHoneypot = { buyOk: true, sellOk: true, roundtripLossPct: 0.6, priceImpactPct: 0.1 };

function inputs(over: Partial<SafetyInputs> = {}, mintOver: Parameters<typeof cleanMint>[1] = {}): SafetyInputs {
  return {
    facts: cleanMint("M", mintOver),
    holders: spreadHolders("M"),
    funders: new Map(),
    honeypot: okHoneypot,
    rug: { score: 100, risks: [] },
    ...over,
  };
}
const reasons = (i: SafetyInputs) => evaluateSafety(i, cfg, ctx).reasons;

describe("token safety (on-chain)", () => {
  it("passes a clean token", () => {
    const r = evaluateSafety(inputs(), cfg, ctx);
    expect(r.pass).toBe(true);
    expect(r.score).toBeGreaterThan(0.5);
  });

  it.each([
    [{ mintAuthority: "Auth" }, "MINT_AUTHORITY_NOT_REVOKED"],
    [{ freezeAuthority: "Auth" }, "FREEZE_AUTHORITY_NOT_REVOKED"],
    [{ program: "token2022" as const, permanentDelegate: "Del", extensions: ["PermanentDelegate"] }, "T22_PERMANENT_DELEGATE"],
    [{ program: "token2022" as const, transferHookProgram: "HookProg", extensions: ["TransferHook"] }, "T22_TRANSFER_HOOK:HookProg"],
    [{ program: "token2022" as const, extensions: ["NonTransferable"] }, "T22_NON_TRANSFERABLE"],
    [{ program: "token2022" as const, transferFeeBps: 500, extensions: ["TransferFeeConfig"] }, "T22_TRANSFER_FEE:500bps"],
    [{ program: "token2022" as const, defaultAccountStateFrozen: true, extensions: ["DefaultAccountState"] }, "T22_DEFAULT_ACCOUNT_FROZEN"],
    [{ program: "token2022" as const, pausable: true, extensions: ["PausableConfig"] }, "T22_PAUSABLE"],
    [{ program: "not_a_mint" as const }, "NOT_A_MINT"],
  ])("rejects %o", (over, reason) => {
    expect(reasons(inputs({}, over))).toContain(reason);
  });

  it("allows Token-2022 with harmless extensions", () => {
    const r = evaluateSafety(inputs({}, { program: "token2022", extensions: ["MetadataPointer", "TokenMetadata"] }), cfg, ctx);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain("TOKEN_2022");
  });

  it("rejects top-10 concentration and single whales", () => {
    expect(reasons(inputs({ holders: spreadHolders("M", undefined, 4, 20) })).some((r) => r.startsWith("TOP10_CONCENTRATION"))).toBe(true);
    const whale = spreadHolders("M");
    whale[0] = { ...whale[0]!, amount: (whale[0]!.amount * 15n) };
    expect(reasons(inputs({ holders: whale })).some((r) => r.startsWith("SINGLE_HOLDER"))).toBe(true);
  });

  it("excludes pools, burn address and lockers from concentration", () => {
    const h = spreadHolders("M");
    const big = (h[0]!.amount * 40n);
    h.unshift(
      { tokenAccount: "vault", owner: "poolPda", amount: big, ownerProgram: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
      { tokenAccount: "burn", owner: "1nc1nerator11111111111111111111111111111111", amount: big, ownerProgram: null },
      { tokenAccount: "reserveX", owner: "someone", amount: big, ownerProgram: null },
    );
    const r = evaluateSafety(inputs({ holders: h }), cfg, { poolReserves: new Set(["reserveX"]) });
    expect(r.pass).toBe(true);
  });

  it("rejects an insider cluster funded from one wallet", () => {
    const h = spreadHolders("M", undefined, 2.5, 12);
    const funders = new Map(h.slice(0, 10).map((x) => [x.owner, "DevWallet"]));
    expect(reasons(inputs({ holders: h, funders })).some((r) => r.startsWith("INSIDER_CLUSTER:DevWallet"))).toBe(true);
  });

  it("honeypots: no sell route / big round-trip loss", () => {
    expect(reasons(inputs({ honeypot: { buyOk: true, sellOk: false, roundtripLossPct: null, priceImpactPct: 0 } }))).toContain("HONEYPOT:NO_SELL_ROUTE");
    expect(reasons(inputs({ honeypot: { ...okHoneypot, roundtripLossPct: 12 } })).some((r) => r.startsWith("HONEYPOT:ROUNDTRIP_LOSS"))).toBe(true);
  });

  it("RugCheck can reject but its absence never blocks or passes on its own", () => {
    expect(reasons(inputs({ rug: { score: 20_000, risks: [] } }))).toContain("RUGCHECK_DANGER:20000");
    const r = evaluateSafety(inputs({ rug: "unavailable" }), cfg, ctx);
    expect(r.pass).toBe(true);
    expect(r.flags).toContain("RUGCHECK_UNAVAILABLE");
    // A great RugCheck score does not save a token with a mint authority.
    expect(evaluateSafety(inputs({ rug: { score: 0, risks: [] } }, { mintAuthority: "A" }), cfg, ctx).pass).toBe(false);
  });

  it("fails closed when RPC is down", async () => {
    const chain = new FakeChain();
    chain.failMints.add("M");
    const r = await checkTokenSafety("M", { chain, jupiter: new FakeJupiter(), rugcheck: new FakeRug() }, cfg, ctx);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^CHECK_FAILED/);
  });

  it("end-to-end honeypot via Jupiter quotes", async () => {
    const jup = new FakeJupiter();
    jup.roundtrip.set("M", null);
    const r = await checkTokenSafety("M", { chain: new FakeChain(), jupiter: jup, rugcheck: new FakeRug() }, cfg, ctx);
    expect(r.reasons).toContain("HONEYPOT:NO_SELL_ROUTE");
  });
});
