import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "../src/config/load";
import { PROGRAMS } from "../src/chain/programs";
import type { PortfolioState } from "../src/portfolio";
import { computePortfolio, seedPaperBalances } from "../src/portfolio";
import { createProposal, transition } from "../src/proposals/lifecycle";
import { RiskOfficer } from "../src/risk/officer";
import { evaluate, type RiskInputs } from "../src/risk/rules";
import type { PoolState } from "../src/positions/market";
import type { Position, Proposal, TokenRow } from "../src/types";
import { HOUR, MINUTE } from "../src/types";
import { FakeJupiter } from "./fakes";
import { config, makeStore, testClock } from "./helpers";

const cfg = config();
const NOW = Date.UTC(2026, 0, 10, 12);
const TOKEN = "TokenMint111";

function portfolio(over: Partial<PortfolioState> = {}): PortfolioState {
  return {
    ts: NOW, valueUsd: 10_000, freeUsd: 8_000, deployedUsd: 2_000, solBalance: 20, solPriceUsd: 150,
    positions: [{ id: 1, pool: "other", token_mint: "Other", valueUsd: 2_000 }],
    tokenExposureUsd: new Map([["Other", 2_000]]), nonMajorUsd: 2_000,
    dayStartValueUsd: 10_000, peakValueUsd: 10_000, dailyPnlPct: 0, drawdownPct: 0, ...over,
  };
}
const token = (over: Partial<TokenRow> = {}): TokenRow => ({
  mint: TOKEN, symbol: "TKN", name: "Token", decimals: 6, program: "spl", safety_score: 0.9, status: "PASS", flags: [],
  is_major: false, first_seen: NOW - 10 * HOUR, last_checked: NOW - 30 * MINUTE, ...over,
});
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 1, action: "ENTER", state: "MANAGER_APPROVED", emergency: false, priority: 0, source: "manager", position_id: null,
  pool: "P", event_id: null, params: { size_usd: 500, range_pct: 10, strategy: "spot" }, reasoning: null, ref_price: null,
  created_at: NOW, updated_at: NOW, expires_at: null, ...over,
});
const position = (over: Partial<Position> = {}): Position => ({
  id: 7, address: "paper-7", pool: "P", dex: "meteora_dlmm", paper: true, token_mint: TOKEN, base_mint: SOL_MINT, strategy: "spot",
  lower_bin: 0, upper_bin: 10, deposit_x: 1, deposit_y: 1, deposit_usd: 1000, entry_price: 1, model: null, fees_claimed_usd: 0,
  tx_costs_usd: 0, status: "OPEN", opened_at: NOW - HOUR, closed_at: null, close_pnl_usd: null, rebalance_count: 0,
  last_rebalance_at: null, ...over,
});
const goodPrograms = [PROGRAMS.COMPUTE_BUDGET, PROGRAMS.TOKEN, PROGRAMS.ATA, PROGRAMS.METEORA_DLMM, PROGRAMS.JUPITER_V6];

function inputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return {
    proposal: proposal(), portfolio: portfolio(), mode: "paper", paused: false, killSwitch: false,
    pool: { address: "P", dex: "meteora_dlmm", mint_x: TOKEN, mint_y: SOL_MINT, bin_step: 20, fee_bps: 20, tvl_usd: 1e6, volume_24h_usd: 2e6, fees_24h_usd: 5000, fee_apr: 180, price: 0.001, created_at: null, first_seen: NOW, last_seen: NOW },
    token: token(), tokenIsMajor: false, rebalancesLast24h: 0, lastRebalanceAt: null, entrySwapImpactPct: 0.2,
    programs: goodPrograms, now: NOW, ...over,
  };
}
const failed = (d: ReturnType<typeof evaluate>) => d.checks.filter((c) => c.result === "FAIL").map((c) => c.rule);

describe("Risk rules — entries", () => {
  it("approves a clean entry", () => {
    const d = evaluate(inputs(), cfg.risk);
    expect(d.outcome).toBe("APPROVE");
    expect(d.params.slippage_bps).toBe(200);
  });

  it("resizes to max 10% of portfolio", () => {
    const d = evaluate(inputs({ proposal: proposal({ params: { size_usd: 3_000 } }) }), cfg.risk);
    expect(d.outcome).toBe("RESIZE");
    expect(d.approvedSizeUsd).toBe(1_000);
    expect(d.params.resized_from_usd).toBe(3_000);
  });

  it("resizes to token exposure cap (15%) across pools", () => {
    const pf = portfolio({ tokenExposureUsd: new Map([[TOKEN, 1_200]]) });
    const d = evaluate(inputs({ portfolio: pf, proposal: proposal({ params: { size_usd: 900 } }) }), cfg.risk);
    expect(d.approvedSizeUsd).toBe(300);
  });

  it("resizes to the non-major cap (50%)", () => {
    const pf = portfolio({ nonMajorUsd: 4_800 });
    const d = evaluate(inputs({ portfolio: pf }), cfg.risk);
    expect(d.approvedSizeUsd).toBe(200);
  });

  it("never deploys the SOL reserve", () => {
    const pf = portfolio({ freeUsd: 0.5 * 150 + 100 });
    const d = evaluate(inputs({ portfolio: pf }), cfg.risk);
    expect(d.approvedSizeUsd).toBe(100);
  });

  it("rejects when resizing goes below the minimum", () => {
    const pf = portfolio({ freeUsd: 0.5 * 150 + 10 });
    expect(failed(evaluate(inputs({ portfolio: pf }), cfg.risk))).toContain("min_position_usd");
  });

  it.each<[string, Partial<RiskInputs>]>([
    ["max_open_positions", { portfolio: portfolio({ positions: Array.from({ length: 8 }, (_, i) => ({ id: i, pool: "p" + i, token_mint: "t" + i, valueUsd: 100 })) }) }],
    ["daily_loss_limit", { portfolio: portfolio({ dailyPnlPct: -5.1 }) }],
    ["drawdown", { portfolio: portfolio({ drawdownPct: 15 }) }],
    ["kill_switch", { killSwitch: true }],
    ["paused", { paused: true }],
    ["token_screened", { token: token({ last_checked: NOW - 7 * HOUR }) }],
    ["token_screened", { token: token({ status: "REJECT", flags: ["MINT_AUTHORITY_NOT_REVOKED"] }) }],
    ["token_screened", { token: undefined }],
    ["program_allowlist", { programs: [...goodPrograms, "EvilProgram111"] }],
    ["price_impact", { entrySwapImpactPct: 1.5 }],
    ["price_impact", { entrySwapImpactPct: null }],
    ["reentry_cooldown", { lastClosedInPool: position({ status: "CLOSED", closed_at: NOW - 2 * HOUR, close_pnl_usd: -50 }) }],
  ])("rejects entry: %s", (rule, over) => {
    const d = evaluate(inputs(over), cfg.risk);
    expect(d.outcome).toBe("REJECT");
    expect(failed(d)).toContain(rule);
  });

  it("allows re-entry after a profitable exit or after the cooldown", () => {
    expect(evaluate(inputs({ lastClosedInPool: position({ status: "CLOSED", closed_at: NOW - HOUR, close_pnl_usd: 20 }) }), cfg.risk).outcome).toBe("APPROVE");
    expect(evaluate(inputs({ lastClosedInPool: position({ status: "CLOSED", closed_at: NOW - 25 * HOUR, close_pnl_usd: -20 }) }), cfg.risk).outcome).toBe("APPROVE");
  });

  it("clamps slippage and priority fee instead of trusting the proposer", () => {
    const d = evaluate(inputs({ proposal: proposal({ params: { size_usd: 500, slippage_bps: 1000, priority_fee_lamports: 9e9 } }) }), cfg.risk);
    expect(d.params.slippage_bps).toBe(200);
    expect(d.params.priority_fee_lamports).toBe(200_000);
    expect(evaluate(inputs({ tokenIsMajor: true, proposal: proposal({ params: { size_usd: 500, slippage_bps: 500 } }) }), cfg.risk).params.slippage_bps).toBe(100);
  });
});

describe("Risk rules — exits are always allowed", () => {
  const exitInputs = (over: Partial<RiskInputs> = {}) =>
    inputs({ proposal: proposal({ action: "FULL_EXIT", position_id: 7, params: { fraction: 1 } }), position: position(), ...over });

  it.each<[string, Partial<RiskInputs>]>([
    ["kill switch", { killSwitch: true }],
    ["paused", { paused: true }],
    ["daily loss", { portfolio: portfolio({ dailyPnlPct: -20 }) }],
    ["drawdown", { portfolio: portfolio({ drawdownPct: 40 }) }],
    ["flagged token", { token: token({ status: "REJECT" }) }],
    ["too many positions", { portfolio: portfolio({ positions: Array.from({ length: 20 }, (_, i) => ({ id: i, pool: "p", token_mint: "t", valueUsd: 1 })) }) }],
  ])("FULL_EXIT approved despite %s", (_n, over) => {
    expect(evaluate(exitInputs(over), cfg.risk).outcome).toBe("APPROVE");
  });

  it("rejects an exit for a position that does not exist", () => {
    expect(failed(evaluate(exitInputs({ position: undefined }), cfg.risk))).toContain("position_exists");
  });

  it("PARTIAL_EXIT needs a sane fraction; SWAP_TO_BASE must output SOL/USDC", () => {
    const pe = evaluate(inputs({ proposal: proposal({ action: "PARTIAL_EXIT", position_id: 7, params: { fraction: 1.5 } }), position: position() }), cfg.risk);
    expect(failed(pe)).toContain("exit_fraction");
    const sw = evaluate(inputs({ proposal: proposal({ action: "SWAP_TO_BASE", position_id: 7, params: { input_mint: TOKEN, output_mint: "Scam", amount: 1 } }), position: position() }), cfg.risk);
    expect(failed(sw)).toContain("swap_to_base_output");
  });
});

describe("Risk rules — rebalance discipline + mode gates", () => {
  const reb = (over: Partial<RiskInputs> = {}) =>
    inputs({ proposal: proposal({ action: "REBALANCE", position_id: 7, params: {} }), position: position(), ...over });
  it("limits rebalances per day and enforces a cooldown", () => {
    expect(evaluate(reb(), cfg.risk).outcome).toBe("APPROVE");
    expect(failed(evaluate(reb({ rebalancesLast24h: 3 }), cfg.risk))).toContain("rebalance_limit");
    expect(failed(evaluate(reb({ lastRebalanceAt: NOW - 10 * MINUTE }), cfg.risk))).toContain("rebalance_cooldown");
  });
  it("approval mode needs a human; auto only above auto_max_size", () => {
    expect(evaluate(inputs({ mode: "approval" }), cfg.risk).needsHuman).toBe(true);
    expect(evaluate(inputs({ mode: "auto", proposal: proposal({ params: { size_usd: 200 } }) }), cfg.risk).needsHuman).toBe(false);
    expect(evaluate(inputs({ mode: "auto", proposal: proposal({ params: { size_usd: 900 } }) }), cfg.risk).needsHuman).toBe(true);
    expect(evaluate(inputs({ mode: "paper" }), cfg.risk).needsHuman).toBe(false);
  });
});

// ------------------------------------------------------------- officer integration

class Prices {
  sol = 150;
  extra = new Map<string, number>();
  async pricesUsd() {
    return new Map([[SOL_MINT, this.sol], [USDC_MINT, 1], ...this.extra]);
  }
}
class Pools {
  async getPoolState(address: string): Promise<PoolState> {
    return { address, mintX: TOKEN, mintY: SOL_MINT, price: 0.001, binStep: 20, tvlUsd: 1e6, volume24hUsd: 2e6, fees24hUsd: 5000 };
  }
}

function officerSetup() {
  const clock = testClock(NOW);
  const { store } = makeStore(clock);
  seedPaperBalances(store, cfg); // 20 SOL + 2000 USDC = $5000
  const prices = new Prices();
  store.upsertPool({ address: "P", dex: "meteora_dlmm", mint_x: TOKEN, mint_y: SOL_MINT, bin_step: 20, fee_bps: 20, tvl_usd: 1e6, volume_24h_usd: 2e6, fees_24h_usd: 5000, fee_apr: 180, price: 0.001, created_at: null });
  store.upsertToken({ mint: TOKEN, symbol: "TKN", name: "Token", decimals: 6, program: "spl", is_major: false, status: "PASS", flags: [], last_checked: NOW });
  const officer = new RiskOfficer(store, cfg, { prices, jupiter: new FakeJupiter(), pools: new Pools() });
  return { store, clock, prices, officer };
}

describe("RiskOfficer", () => {
  it("logs every decision with rules and moves the proposal", async () => {
    const { store, officer } = officerSetup();
    const p = createProposal(store, { action: "ENTER", source: "manager", pool: "P", params: { size_usd: 2_000, strategy: "spot", range_pct: 10 } });
    transition(store, p.id, "MANAGER_APPROVED", { actor: "manager" });
    const [r] = await officer.processPending();
    expect(r!.decision.outcome).toBe("RESIZE");
    const after = store.getProposal(p.id)!;
    expect(after.state).toBe("RISK_APPROVED");
    expect(after.params.size_usd).toBe(500); // 10% of $5000
    expect(after.ref_price).toBe(0.001);
    const logged = store.db.get<{ outcome: string; checks_json: string }>("SELECT outcome, checks_json FROM risk_decisions WHERE proposal_id = ?", [p.id])!;
    expect(logged.outcome).toBe("RESIZE");
    expect(JSON.parse(logged.checks_json).some((c: { rule: string }) => c.rule === "max_position_pct")).toBe(true);
  });

  it("does not touch non-emergency proposals the Manager has not approved", async () => {
    const { store, officer } = officerSetup();
    const p = createProposal(store, { action: "ENTER", source: "manager", pool: "P", params: { size_usd: 100 } });
    await officer.processPending();
    expect(store.getProposal(p.id)!.state).toBe("PROPOSED");
  });

  it("approves emergency exits straight from PROPOSED", async () => {
    const { store, officer, clock } = officerSetup();
    const posId = store.insertPosition({ address: "paper-x", pool: "P", dex: "meteora_dlmm", paper: true, token_mint: TOKEN, base_mint: SOL_MINT, strategy: "spot", lower_bin: 0, upper_bin: 1, deposit_x: 0, deposit_y: 1, deposit_usd: 150, entry_price: 0.001, model: null, opened_at: clock() });
    store.adjustBalance(SOL_MINT, -1);
    store.setKillSwitch(true);
    const p = createProposal(store, { action: "FULL_EXIT", source: "position_monitor", emergency: true, position_id: posId, pool: "P", params: { fraction: 1 } });
    await officer.processPending();
    expect(store.getProposal(p.id)!.state).toBe("RISK_APPROVED");
  });

  it("kill switch: drawdown -15% from peak → exits everything, stops, alerts", async () => {
    const { store, officer, prices, clock } = officerSetup();
    const posId = store.insertPosition({ address: "paper-y", pool: "P", dex: "meteora_dlmm", paper: true, token_mint: TOKEN, base_mint: SOL_MINT, strategy: "spot", lower_bin: 0, upper_bin: 1, deposit_x: 0, deposit_y: 1, deposit_usd: 150, entry_price: 0.001, model: null, opened_at: clock() });
    await officer.guard(); // peak $5000 (+150 position)
    clock.advance(HOUR);
    prices.sol = 100; // 20 SOL: 3000 → 2000; portfolio 5150 → ~4150 (-19%)
    const pf = await officer.guard();
    expect(pf.drawdownPct).toBeGreaterThan(15);
    expect(store.isKillSwitchActive()).toBe(true);
    expect(store.isPaused()).toBe(true);
    const exits = store.proposalsInState("PROPOSED").filter((p) => p.emergency && p.position_id === posId);
    expect(exits).toHaveLength(1);
    expect(store.unsentReports().some((r) => r.kind === "alert" && r.body.includes("KILL SWITCH"))).toBe(true);
    await officer.guard(); // idempotent
    expect(store.db.all("SELECT * FROM events WHERE type = 'KILL_SWITCH'")).toHaveLength(1);
  });

  it("daily loss limit raises one event per day", async () => {
    const { store, officer, prices, clock } = officerSetup();
    await officer.guard();
    clock.advance(HOUR);
    prices.sol = 130; // 3000 → 2600: -8%
    await officer.guard();
    await officer.guard();
    expect(store.db.all("SELECT * FROM events WHERE type = 'DAILY_LOSS_LIMIT'")).toHaveLength(1);
    const pf = await computePortfolio(store, cfg, prices);
    expect(pf.dailyPnlPct).toBeLessThan(-5);
  });
});
