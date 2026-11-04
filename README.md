# LP-room

Multi-agent Solana concentrated-liquidity LP desk. See [PRD.md](PRD.md).

**This build runs in paper mode only.** There is no key handling and no code path that sends a transaction:
the Executor builds and simulates, then records a simulated fill.

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

```sh
npm install
npm run cli migrate
npm test
```

Environment:

| Var | Purpose |
|---|---|
| `SOLANA_RPC_URL` | RPC endpoint (Helius recommended) for on-chain safety reads |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram reports / commands (optional; console if unset) |
| `LP_ROOM_CONFIG_DIR` | config directory (default `config/`) |

## Layout

```
config/            app.yaml, risk.yaml, screener.yaml, known-assets.yaml
src/config         zod-validated config loader
src/db             SQLite schema + typed Store (shared state / audit trail)
src/proposals      proposal state machine (PRD §9)
src/telegram       Telegram bot: reports, commands, approval buttons
```
