import { describe, expect, it } from "vitest";
import { ConsoleTransport } from "../src/telegram/api";
import { TelegramBot } from "../src/telegram/bot";
import { createProposal, transition } from "../src/proposals/lifecycle";
import { makeStore } from "./helpers";

function setup() {
  const { store, clock } = makeStore();
  const tg = new ConsoleTransport(false);
  const bot = new TelegramBot(tg, store, { status: () => "STATUS", positions: () => "POSITIONS" }, {
    chatId: "42", pollTimeoutS: 1, mode: "paper",
  });
  return { store, clock, tg, bot };
}
const msg = (text: string, chat = 42) => ({ update_id: 1, message: { message_id: 1, chat: { id: chat }, text } });

describe("telegram bot", () => {
  it("answers commands from the configured chat only", async () => {
    const { bot, tg } = setup();
    await bot.handleUpdate(msg("/status"));
    await bot.handleUpdate(msg("/status", 999));
    expect(tg.sent.map((s) => s.text)).toEqual(["STATUS"]);
  });

  it("pause / resume", async () => {
    const { bot, store } = setup();
    await bot.handleCommand("/pause");
    expect(store.isPaused()).toBe(true);
    await bot.handleCommand("/resume");
    expect(store.isPaused()).toBe(false);
  });

  it("refuses non-paper modes", async () => {
    const { bot } = setup();
    expect(await bot.handleCommand("/mode auto")).toMatch(/not available/);
  });

  it("/exitall requires confirmation", async () => {
    const { bot, store } = setup();
    expect(await bot.handleCommand("/exitall")).toMatch(/confirm/);
    expect(store.isPaused()).toBe(false);
    expect(await bot.handleCommand("/exitall confirm")).toMatch(/No open positions/);
    expect(store.isPaused()).toBe(true);
  });

  it("approve button moves a RISK_APPROVED proposal to HUMAN_APPROVED", () => {
    const { bot, store } = setup();
    const p = createProposal(store, { action: "ENTER", source: "manager" });
    transition(store, p.id, "MANAGER_APPROVED", { actor: "m" });
    transition(store, p.id, "RISK_APPROVED", { actor: "r" });
    expect(bot.handleCallback(`approve:${p.id}`, "me")).toMatch(/approved/);
    expect(store.getProposal(p.id)!.state).toBe("HUMAN_APPROVED");
    expect(bot.handleCallback(`approve:${p.id}`, "me")).toMatch(/nothing to approve/);
  });

  it("flushes unsent reports once", async () => {
    const { bot, store, tg } = setup();
    store.addReport("alert", "kill switch");
    expect(await bot.flushReports()).toBe(1);
    expect(await bot.flushReports()).toBe(0);
    expect(tg.sent[0]!.text).toContain("kill switch");
  });
});
