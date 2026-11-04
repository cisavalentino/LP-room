# LP-room

Multi-agent Solana concentrated-liquidity LP desk. See [PRD.md](PRD.md).

**This build is paper mode only.** Milestones 1–5 are implemented (skeleton, Screener stages 1–6,
position monitor, Risk Officer, paper Executor). There is no key handling and no code path that
signs or sends a transaction — a test (`tests/m5.executor.test.ts`) fails the build if signing /
sending identifiers appear anywhere in `src/`, and `config/app.yaml` only accepts `mode: paper`.

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

```sh
npm install
npm run cli migrate
npm test            # 136 tests
npm run typecheck
```

| Env var | Purpose |
|---|---|
| `SOLANA_RPC_URL` | RPC for on-chain safety reads (Helius recommended: DAS `getAsset` is used for metadata) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | reports / commands (optional; messages go to stdout without them) |
| `LP_ROOM_CONFIG_DIR` | config directory (default `config/`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## Running (paper)

```sh
npm run cli screen                      # one Screener scan, prints the shortlist
npm run cli propose-enter <pool> 250 10 spot
npm run cli approve <proposalId>        # stand-in for the Manager agent (milestone 6)
npm run cli step                        # Risk Officer + Executor once
npm run cli monitor                     # one monitor pass (snapshots + events)
npm run cli status
npm start                               # all loops + Telegram bot
```

Paper balances are seeded from `config/app.yaml` (`paper.starting_balances`) on first start.

## How it fits together

Bots never call each other — they read and write SQLite tables (`src/db/schema.sql`), which is
also the audit trail (`proposal_transitions`, `risk_decisions`, `executions`, `screen_rejections`).

```
Screener ──► candidates ──► (Manager, M6) ──► proposals ──► Risk Officer ──► Executor (paper)
                                                  ▲                               │
Position monitor ──► snapshots / events ──────────┘ (critical: emergency exit)   ▼
                                                                    executions, positions, balances
```

| Path | What |
|---|---|
| `config/` | `app`, `risk`, `screener`, `positions` YAML + `known-assets` allowlist (zod-validated) |
| `src/proposals/lifecycle.ts` | PRD §9 state machine, compare-and-set transitions, emergency path |
| `src/screener/` | stages 1–6: collect, hard filters, identity, on-chain safety, pool quality, score |
| `src/screener/identity.ts` | NFKC, zero-width stripping, confusable skeletons, canonical resolution |
| `src/screener/safety.ts` | mint/freeze authority, Token-2022 extensions, holders, insider clusters, honeypot, RugCheck |
| `src/chain/reader.ts` | read-only RPC (mint facts, largest holders, DAS metadata, funding source) |
| `src/positions/` | DLMM paper model, monitor loop, trigger rules |
| `src/risk/` | pure rules (`rules.ts`) + officer (portfolio guards, kill switch, decision logging) |
| `src/executor/` | plan inspection + paper executor |
| `src/telegram/` | `/status /positions /pause /resume /mode /exitall`, approval buttons, report flushing |

## Paper-mode simplifications (worth knowing when reading paper PnL)

- **Simulation is model-based, not `simulateTransaction`.** The Executor builds an abstract plan
  (programs, token movements), inspects it against the allowlist and our own accounts, and
  simulates balances using live Jupiter quotes for swaps and a constant-sum DLMM bin model for
  liquidity. Building real DEX-SDK transactions comes with approval mode.
- **Fees are estimated**: pool fees × (our in-range value / pool TVL) × `paper_fees.share_boost`
  (default 1.0, conservative), credited in the base token. Position rent is ignored.
- **Unique traders**: DexScreener does not provide it, so that filter is skipped and flagged
  (`UNIQUE_TRADERS_UNKNOWN`) until a Birdeye source is added. Token age uses the earliest
  DexScreener pair. "Same wallets trading back and forth" needs trade-level data and is not done.
- **TVL-drop (24h) and 7d volatility** use our own `pool_history`, so they're unknown for the first day.
- Only Meteora DLMM is wired (Orca / Raydium are v2 per the PRD). Agents (Screener review,
  Position decisions, Manager) are milestone 6; non-critical events stay `OPEN` for them.
