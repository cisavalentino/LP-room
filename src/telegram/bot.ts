import type { Store } from "../db/store";
import { IllegalTransitionError, proposeEmergencyExit, transition } from "../proposals/lifecycle";
import type { TelegramTransport, TgUpdate } from "./api";

export interface StatusProvider {
  status(): Promise<string> | string;
  positions(): Promise<string> | string;
}

export interface BotOptions {
  chatId: string;
  pollTimeoutS: number;
  mode: string;
}

const HELP = [
  "LP-room desk bot",
  "/status – portfolio summary",
  "/positions – open positions",
  "/pause – stop new entries and execution",
  "/resume – resume",
  "/mode paper|approval|auto – change mode (this build: paper only)",
  "/exitall confirm – emergency exit of every position",
].join("\n");

/**
 * Human interface (PRD §10). Only the configured chat may issue commands; everything else is
 * ignored. The bot never signs anything — at most it creates emergency exit proposals and
 * records human approvals, which still go through Risk and the Executor.
 */
export class TelegramBot {
  private offset = 0;
  private running = false;

  constructor(
    private readonly tg: TelegramTransport,
    private readonly store: Store,
    private readonly provider: StatusProvider,
    private readonly opts: BotOptions,
  ) {}

  notify(text: string): Promise<void> {
    return this.tg.sendMessage(this.opts.chatId, text);
  }

  /** Sends every unsent row from `reports` (cycle updates, alerts, daily reports). */
  async flushReports(): Promise<number> {
    let n = 0;
    for (const r of this.store.unsentReports()) {
      const prefix = r.kind === "alert" ? "🚨 " : "";
      await this.tg.sendMessage(this.opts.chatId, prefix + r.body);
      this.store.markReportSent(r.id);
      n++;
    }
    return n;
  }

  async requestApproval(proposalId: number, summary: string): Promise<void> {
    await this.tg.sendMessage(this.opts.chatId, `Approval needed for proposal #${proposalId}\n${summary}`, [
      [
        { text: "✅ Approve", callback_data: `approve:${proposalId}` },
        { text: "❌ Reject", callback_data: `reject:${proposalId}` },
      ],
    ]);
  }

  async pollOnce(): Promise<void> {
    const updates = await this.tg.getUpdates(this.offset, this.opts.pollTimeoutS);
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      try {
        await this.handleUpdate(u);
      } catch (e) {
        console.error("telegram update failed:", (e as Error).message);
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        console.error("telegram poll failed:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (String(cq.message?.chat.id) !== this.opts.chatId) return;
      const reply = this.handleCallback(cq.data ?? "", cq.from.username ?? String(cq.from.id));
      await this.tg.answerCallback(cq.id, reply);
      await this.tg.sendMessage(this.opts.chatId, reply);
      return;
    }
    const msg = u.message;
    if (!msg?.text || String(msg.chat.id) !== this.opts.chatId) return;
    const reply = await this.handleCommand(msg.text.trim());
    if (reply) await this.tg.sendMessage(this.opts.chatId, reply);
  }

  async handleCommand(text: string): Promise<string | null> {
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = (rawCmd ?? "").split("@")[0]!.toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        return HELP;
      case "/status":
        return await this.provider.status();
      case "/positions":
        return await this.provider.positions();
      case "/pause":
        this.store.setPaused(true);
        this.store.addReport("alert", "Desk paused by human. Exits already approved will still be executed.");
        return "⏸ Paused. No new entries; the executor only processes emergency exits.";
      case "/resume":
        if (this.store.isKillSwitchActive()) {
          this.store.setKillSwitch(false);
        }
        this.store.setPaused(false);
        return "▶️ Resumed.";
      case "/mode": {
        const m = args[0];
        if (m === "paper") return "Mode is paper.";
        if (m === "approval" || m === "auto") return `Mode '${m}' is not available in this build (paper only).`;
        return `Current mode: ${this.opts.mode}. Usage: /mode paper|approval|auto`;
      }
      case "/exitall": {
        if (args[0] !== "confirm") return "This exits EVERY position. Send `/exitall confirm` to proceed.";
        const positions = this.store.openPositions();
        const ids = positions.map(
          (p) => proposeEmergencyExit(this.store, p.id, "human", "Human requested /exitall").id,
        );
        this.store.setPaused(true);
        return ids.length
          ? `🛑 Emergency exit proposed for ${ids.length} position(s): #${ids.join(", #")}. Desk paused.`
          : "No open positions. Desk paused.";
      }
      default:
        return cmd.startsWith("/") ? `Unknown command.\n${HELP}` : null;
    }
  }

  handleCallback(data: string, who: string): string {
    const m = /^(approve|reject):(\d+)$/.exec(data);
    if (!m) return "Unknown action";
    const id = Number(m[2]);
    const p = this.store.getProposal(id);
    if (!p) return `Proposal #${id} not found`;
    if (p.state !== "RISK_APPROVED") return `Proposal #${id} is ${p.state}; nothing to approve.`;
    if (p.expires_at && p.expires_at < this.store.now()) {
      transition(this.store, id, "EXPIRED", { actor: "telegram", note: "human approval window passed" });
      return `Proposal #${id} expired.`;
    }
    try {
      if (m[1] === "approve") {
        transition(this.store, id, "HUMAN_APPROVED", { actor: `human:${who}` });
        return `✅ Proposal #${id} approved.`;
      }
      transition(this.store, id, "REJECTED", { actor: `human:${who}`, note: "rejected in Telegram" });
      return `❌ Proposal #${id} rejected.`;
    } catch (e) {
      if (e instanceof IllegalTransitionError) return `Cannot change proposal #${id}: ${e.message}`;
      throw e;
    }
  }
}
