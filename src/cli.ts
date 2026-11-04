import { buildDesk, every, startLoops } from "./app";
import { loadConfig } from "./config/load";
import { openDb } from "./db/db";
import { Store } from "./db/store";
import { createProposal, proposeEmergencyExit, transition } from "./proposals/lifecycle";
import { ConsoleTransport, TelegramApi } from "./telegram/api";
import { TelegramBot } from "./telegram/bot";
import type { Strategy } from "./types";

const USAGE = `lp-room <command>   (paper mode only — nothing is ever sent on-chain)

  migrate                               create / upgrade the database
  run                                   run all loops + Telegram bot
  screen                                run one Screener scan and print the shortlist
  monitor                               run one Position Manager monitor pass
  step                                  run Risk Officer + Executor once
  status                                portfolio summary
  propose-enter <pool> <usd> [range%] [spot|curve|bid_ask]
                                        create an ENTER proposal (until the Manager agent exists)
  approve <proposalId>                  act as Manager: PROPOSED → MANAGER_APPROVED
  reject <proposalId>                   act as Manager: → REJECTED
  exit <positionId>                     emergency FULL_EXIT proposal
  bot                                   Telegram bot only
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return void console.log(USAGE);
  const cfg = loadConfig();
  const store = new Store(openDb(cfg.app.database.path));

  if (cmd === "migrate") return void console.log(`Database ready at ${cfg.app.database.path}`);

  const desk = buildDesk(store, cfg);
  switch (cmd) {
    case "screen": {
      const r = await desk.screener.run();
      console.log(JSON.stringify(r.stats));
      for (const [i, s] of r.shortlist.entries()) {
        const c = s.cand;
        console.log(
          `${String(i + 1).padStart(2)}. ${s.score.toFixed(1).padStart(5)}  ${c.token.symbol}/${c.base.symbol}  ${c.pool.address}  ` +
            `TVL $${Math.round(c.pool.tvlUsd)}  APR ${(c.metrics.fee_apr ?? 0).toFixed(0)}%  ${c.flags.join(",")}`,
        );
      }
      return;
    }
    case "monitor":
      return void console.log(JSON.stringify(await desk.monitor.runOnce()));
    case "step": {
      const risk = await desk.risk.processPending();
      const exec = await desk.executor.runOnce();
      console.log(JSON.stringify({ risk: risk.map((r) => ({ id: r.proposal.id, outcome: r.decision.outcome })), exec }, null, 2));
      return;
    }
    case "status":
      console.log(await desk.status.status());
      console.log(await desk.status.positions());
      return;
    case "propose-enter": {
      const [pool, usd, range, strategy] = args;
      if (!pool || !usd) throw new Error("usage: propose-enter <pool> <usd> [range%] [strategy]");
      const p = createProposal(store, {
        action: "ENTER",
        source: "human",
        pool,
        params: { size_usd: Number(usd), range_pct: range ? Number(range) : 10, strategy: (strategy ?? "spot") as Strategy },
        reasoning: "manual paper proposal",
      });
      return void console.log(`Proposal #${p.id} created (PROPOSED). Approve with: approve ${p.id}`);
    }
    case "approve":
      return void console.log(transition(store, Number(args[0]), "MANAGER_APPROVED", { actor: "human-as-manager" }).state);
    case "reject":
      return void console.log(transition(store, Number(args[0]), "REJECTED", { actor: "human-as-manager" }).state);
    case "exit":
      return void console.log(`Proposal #${proposeEmergencyExit(store, Number(args[0]), "human", "manual exit").id}`);
    case "bot":
    case "run": {
      const token = process.env[cfg.app.telegram.token_env];
      const chatId = process.env[cfg.app.telegram.chat_id_env] ?? "console";
      const bot = new TelegramBot(token ? new TelegramApi(token) : new ConsoleTransport(), store, desk.status, {
        chatId,
        pollTimeoutS: cfg.app.telegram.poll_timeout_s,
        mode: cfg.app.mode,
      });
      const stops: (() => void)[] = [];
      if (cmd === "run") stops.push(startLoops(store, cfg, desk));
      stops.push(every("reports", 10_000, () => bot.flushReports()));
      await bot.notify(`LP-room online (paper mode${token ? "" : ", no Telegram token: console output"}).`);
      const shutdown = () => {
        stops.forEach((f) => f());
        bot.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      if (token) await bot.start();
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
