import { loadConfig } from "./config/load";
import { openDb } from "./db/db";
import { Store } from "./db/store";
import { ConsoleTransport, TelegramApi, type TelegramTransport } from "./telegram/api";
import { TelegramBot } from "./telegram/bot";

const USAGE = `lp-room <command>

  migrate          create / upgrade the database
  bot              run the Telegram bot only
`;

function telegramTransport(token: string | undefined): TelegramTransport {
  return token ? new TelegramApi(token) : new ConsoleTransport();
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const cfg = loadConfig();
  const db = openDb(cfg.app.database.path);
  const store = new Store(db);

  switch (cmd) {
    case "migrate":
      console.log(`Database ready at ${cfg.app.database.path}`);
      return;
    case "bot": {
      const token = process.env[cfg.app.telegram.token_env];
      const chatId = process.env[cfg.app.telegram.chat_id_env];
      if (!token || !chatId) throw new Error(`Set ${cfg.app.telegram.token_env} and ${cfg.app.telegram.chat_id_env}`);
      const bot = new TelegramBot(telegramTransport(token), store, {
        status: () => `mode=${cfg.app.mode} paused=${store.isPaused()}`,
        positions: () => `${store.openPositions().length} open position(s)`,
      }, { chatId, pollTimeoutS: cfg.app.telegram.poll_timeout_s, mode: cfg.app.mode });
      await bot.notify("LP-room bot online (paper mode).");
      await bot.start();
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
