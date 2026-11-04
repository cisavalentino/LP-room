import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "../src/config/schema";
import { canTransition, createProposal, proposeEmergencyExit, transition, transitionsOf } from "../src/proposals/lifecycle";
import { config, makeStore } from "./helpers";

describe("config", () => {
  it("loads all config files", () => {
    const c = config();
    expect(c.app.mode).toBe("paper");
    expect(c.risk.portfolio.max_open_positions).toBe(8);
    expect(c.screener.hard_filters.min_tvl).toBe(50_000);
    expect(c.knownAssets.find((a) => a.symbol === "USDC")?.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("rejects non-paper modes in this build", () => {
    const c = config();
    expect(AppConfigSchema.safeParse({ ...c.app, mode: "auto" }).success).toBe(false);
  });
});

describe("db + proposal lifecycle", () => {
  it("migrates and is idempotent", () => {
    const { db } = makeStore();
    db.migrate();
    expect(db.all("SELECT * FROM schema_version")).toHaveLength(1);
  });

  it("follows the normal path and records transitions", () => {
    const { store } = makeStore();
    const p = createProposal(store, { action: "ENTER", source: "manager", pool: "P", params: { size_usd: 100 } });
    expect(p.state).toBe("PROPOSED");
    transition(store, p.id, "MANAGER_APPROVED", { actor: "manager" });
    transition(store, p.id, "RISK_APPROVED", { actor: "risk" });
    transition(store, p.id, "EXECUTING", { actor: "executor" });
    const done = transition(store, p.id, "DONE", { actor: "executor" });
    expect(done.state).toBe("DONE");
    expect(transitionsOf(store, p.id).map((t) => t.to_state)).toEqual([
      "PROPOSED", "MANAGER_APPROVED", "RISK_APPROVED", "EXECUTING", "DONE",
    ]);
    expect(() => transition(store, p.id, "EXECUTING", { actor: "x" })).toThrow();
  });

  it("only emergencies can skip the manager", () => {
    expect(canTransition({ state: "PROPOSED", emergency: false }, "RISK_APPROVED")).toBe(false);
    expect(canTransition({ state: "PROPOSED", emergency: true }, "RISK_APPROVED")).toBe(true);
    expect(canTransition({ state: "DONE", emergency: true }, "EXECUTING")).toBe(false);
  });

  it("emergency exit is idempotent per position and supersedes other proposals", () => {
    const { store, clock } = makeStore();
    store.upsertPool({ address: "P", dex: "meteora_dlmm", mint_x: "X", mint_y: "Y", bin_step: 10, fee_bps: 10, tvl_usd: 1, volume_24h_usd: 1, fees_24h_usd: 1, fee_apr: 1, price: 1, created_at: null });
    const posId = store.insertPosition({
      address: "paper-1", pool: "P", dex: "meteora_dlmm", paper: true, token_mint: "X", base_mint: "Y", strategy: "spot",
      lower_bin: 0, upper_bin: 10, deposit_x: 1, deposit_y: 1, deposit_usd: 2, entry_price: 1, model: null, opened_at: clock(),
    });
    const claim = createProposal(store, { action: "CLAIM_FEES", source: "pm", position_id: posId });
    const a = proposeEmergencyExit(store, posId, "pm", "stop loss");
    const b = proposeEmergencyExit(store, posId, "pm", "again");
    expect(a.id).toBe(b.id);
    expect(store.getProposal(claim.id)!.state).toBe("REJECTED");
  });

  it("balances cannot go negative", () => {
    const { store } = makeStore();
    store.adjustBalance("SOL", 1);
    expect(() => store.adjustBalance("SOL", -2)).toThrow();
    expect(store.getBalance("SOL")).toBe(1);
  });
});
