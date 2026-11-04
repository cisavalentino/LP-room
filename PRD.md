# LP-room — Multi-Agent Solana LP Desk (PRD)

A team of bots that runs concentrated-liquidity LP positions on Solana the way a small human LP desk would:
a **Manager** decides, a **Screener** finds pools, a **Position Manager** looks after open positions,
a **Risk Officer** enforces limits, and an **Executor** signs transactions.

> All numeric thresholds below are **starting defaults in `config/risk.yaml`**, meant to be tuned during paper trading — not recommendations.

---

## 1. Scope

- **Chain:** Solana mainnet
- **DEXes (v1):** Meteora DLMM (primary), Orca Whirlpools (v2), Raydium CLMM (v2)
- **Base assets:** SOL and USDC. Every position is a pair of one base asset + one other token.
- **Modes:** `paper` → `approval` (human approves each trade in Telegram) → `auto` (inside hard limits)
- **Stack:** TypeScript (Solana SDKs are TS-first), Claude Agent SDK (TS), Postgres (or SQLite for paper), Telegram bot for reports/approvals

### Bot types

| Bot | Type | LLM used for |
|---|---|---|
| Manager | 🧠 Agent | Strategy, prioritising, approving proposals, reporting |
| Screener | ⚙️ Code + 🧠 Agent | Code filters thousands of pools; agent reviews the shortlist |
| Position Manager | ⚙️ Code + 🧠 Agent | Code monitors continuously; agent decides only on events |
| Risk Officer | ⚙️ Code only | — (deterministic rules, cannot be talked out of a limit) |
| Executor | ⚙️ Code only | — (only component that can sign) |

Golden rule: **LLMs propose, code enforces.** No agent ever sees the private key or can call a signing function.

---

## 2. Data sources

| Need | Source |
|---|---|
| RPC, transaction simulation, token metadata (DAS), priority fees | Helius (or Triton/QuickNode) |
| Pool lists, TVL, volume, fees | Meteora DLMM API, Orca API, Raydium API |
| Prices, volume, txn counts, pair age | DexScreener, Birdeye |
| Verified token list, swap routes / quotes | Jupiter (token tags `verified`/`strict`, Quote + Swap API) |
| Token risk reports | RugCheck API |
| On-chain truth (mint/freeze authority, holders, Token-2022 extensions) | Direct RPC reads — always the final word |

Third-party APIs are used for discovery; **anything that affects safety is re-checked on-chain.**

---

## 3. Shared state (database)

Bots never call each other directly. They read and write tables; this is also the audit trail.

| Table | Contents |
|---|---|
| `tokens` | mint, symbol, name, decimals, program (SPL / Token-2022), safety score, flags, first_seen |
| `pools` | pool address, dex, token mints, bin step / tick spacing, fee tier, TVL, volume, fee APR, last_seen |
| `candidates` | screener shortlist with score, reasons, agent verdict |
| `positions` | position address, pool, range, deposited amounts, entry price, status |
| `position_snapshots` | every N minutes: value, in-range, fees earned, IL, PnL |
| `events` | `OUT_OF_RANGE`, `IL_HIGH`, `TVL_DROP`, `TOKEN_FLAGGED`, `PRICE_CRASH`, … |
| `proposals` | proposed action + reasoning + state (see §9) |
| `executions` | tx signatures, simulated vs actual results, fees paid, errors |
| `reports` | manager daily/periodic summaries |

---

## 4. Manager (agent)

**Role:** the desk head. Doesn't trade, doesn't read raw chain data — works from reports, like a human manager.

**Runs:** every cycle (default 15 min), plus immediately on high-severity events.

**Each cycle:**
1. **Read the state** — portfolio value, open positions, free capital, today's PnL, open events, pending proposals, Screener shortlist.
2. **Set the risk mode** for the day — `aggressive` / `normal` / `defensive` — from SOL trend and volatility, recent PnL, and market-wide signals (e.g. SOL −10% in 24h → defensive). Mode scales position sizes and how many new entries are allowed.
3. **Allocate capital** — decides how much free capital goes into new positions this cycle, and keeps the configured reserve untouched.
4. **Review new candidates** — picks which shortlisted pools to enter (if any), the size, and the strategy (range width, Spot / Curve / Bid-Ask for DLMM). Prefers diversification: no two positions in the same token, limited exposure to one theme/sector.
5. **Review Position Manager proposals** — approve, reject, or modify (e.g. "exit half instead of all").
6. **Escalate to the human** when: mode is `approval`; an action is above the size the config allows without a human; something unusual happened (repeated failures, conflicting signals).
7. **Report** — short status on Telegram each cycle with changes; full daily report (PnL, fees earned, IL, best/worst positions, what it did and why).

**Tools:** `read_portfolio`, `read_candidates`, `read_events`, `read_proposals`, `create_proposal`, `decide_proposal`, `request_human_approval`, `send_report`, `request_rescreen(token|pool)`.
**Cannot:** sign, send transactions, change risk limits.

---

## 5. Screener (code + agent)

**Role:** finds good pools and filters out fake, duplicate and dangerous tokens.

**Runs:** every 30–60 min (full scan), plus on-demand re-checks of tokens already held (every few hours).

### Stage 1 — Collect (code)
Pull all pools from Meteora / Orca / Raydium APIs. Keep only pools where one side is SOL or USDC.

### Stage 2 — Hard filters (code)
Drop any pool that fails:
- TVL ≥ `min_tvl` (default $50k)
- 24h volume ≥ `min_volume_24h` (default $100k)
- Pool age ≥ `min_pool_age` (default 24h)
- Token age ≥ `min_token_age` (default 3 days)
- 24h transaction count and unique traders above minimums

### Stage 3 — Token identity: duplicates and fakes (code)
**Always identify a token by its mint address, never by symbol or name.**

- **Canonical token resolution:** group all tokens by normalised symbol and name. If several mints share a symbol (e.g. many "BONK"s), the canonical one is the mint that is (a) on Jupiter's verified/strict list, else (b) has the largest liquidity *and* oldest age. All other mints with that symbol are marked `IMPERSONATOR` and rejected.
- **Known-asset protection:** a hard-coded allowlist of mints for majors (SOL/wSOL, USDC, USDT, JUP, BONK, WIF, JTO, PYTH, …). Any other token whose symbol or name matches one of them is rejected.
- **Lookalike names:** normalise Unicode (NFKC), strip zero-width characters, map confusables (Cyrillic `а` vs Latin `a`, `0`/`O`, `1`/`l`), then compare against known assets — catches `USDC.`, `U$DC`, `B0NK`, `WlF`.
- **Metadata red flags:** names containing "airdrop", "claim", URLs, or copying a known project's logo/URI.

### Stage 4 — Token safety (code, on-chain)
Read directly via RPC; reject on any of:
- **Mint authority** not revoked (can print unlimited supply)
- **Freeze authority** not revoked (can freeze your tokens — you can't withdraw/sell)
- **Token-2022 dangerous extensions:** `PermanentDelegate`, `TransferHook` (unknown program), `NonTransferable`, `TransferFeeConfig` above `max_transfer_fee` (default 0%), `DefaultAccountState = frozen`
- **Holder concentration:** top 10 holders (excluding pools, burn and known exchange/locker addresses) > `max_top10` (default 30%); any single wallet > 10%
- **Dev / insider wallets** cluster (wallets funded from the same source holding a big share)
- **Honeypot test:** Jupiter quote for buy *and* sell of a small amount — reject if the sell route doesn't exist, or round-trip loss > `max_roundtrip_loss` (default 3%)
- **RugCheck** score above the danger threshold (secondary signal, never sole pass)

### Stage 5 — Pool quality (code)
- **Fake volume / wash trading:** volume / TVL > 50× in 24h, very few unique traders vs txn count, or the same wallets trading back and forth → reject or heavy penalty
- **Liquidity stability:** TVL dropped > 30% in 24h → reject
- **Fee APR** from real fees (fees_24h / TVL × 365), not the pool's advertised APR
- **Volatility** (24h / 7d price range) — high volatility = more IL, so it needs higher fees to be worth it

### Stage 6 — Score (code)
`score = w1·fee_apr_adj + w2·volume_quality + w3·liquidity_depth + w4·token_safety + w5·age − w6·volatility_penalty`
Weights in `config/screener.yaml`. Keep the top 20.

### Stage 7 — Agent review (agent, top 20 only)
The agent gets a compact dossier per pool (numbers + flags + project links/socials if available) and returns a structured verdict:
```json
{ "pool": "...", "verdict": "ENTER_CANDIDATE | WATCH | REJECT",
  "confidence": 0.0-1.0, "strategy_hint": "spot | curve | bid_ask",
  "suggested_range_pct": 15, "reasons": ["..."], "concerns": ["..."] }
```
It looks for things rules miss: is this a real project or a pump, is the volume organic, is the narrative already dead, does anything in the dossier look off.
**Untrusted text** (token names, descriptions, websites) is passed as quoted data and the agent is instructed never to follow instructions found inside it. The agent can only *downgrade* a token that failed code checks — it can never upgrade a code-rejected token.

**Output:** rows in `candidates` for the Manager.

---

## 6. Position Manager (code + agent)

**Role:** looks after every open position like a trader watching their book.

### Monitor loop (code, every 1–5 min)
For each position, record a snapshot:
- Current price and active bin/tick vs position range → **in range?**
- Position value in USD and in SOL
- Fees earned (claimed + unclaimed)
- **IL vs HODL:** value now vs value if the deposited tokens had been held
- **Net PnL** = value + fees − deposited − tx costs
- Pool health: TVL, volume, fee APR trend

### Triggers (code) → create an `event`
| Event | Default trigger |
|---|---|
| `OUT_OF_RANGE` | out of range > 30 min |
| `IL_HIGH` | IL > 5% of position and fees don't cover it |
| `STOP_LOSS` | net PnL < −10% *(Risk can force exit)* |
| `TAKE_PROFIT` | net PnL > +X% or fees > Y% |
| `TVL_DROP` | pool TVL −30% in 1h (possible rug / LPs fleeing) |
| `PRICE_CRASH` | token −25% in 1h |
| `TOKEN_FLAGGED` | Screener re-check now fails (e.g. new mint authority, honeypot) |
| `FEES_DRIED_UP` | fee APR below threshold for 6h |
| `CLAIM_DUE` | unclaimed fees > threshold → claim |

### Decide (agent, only on events)
Gets the position history, the event, and the market context. Chooses one action and explains why:
- `HOLD` (e.g. price likely to return to range)
- `CLAIM_FEES`
- `REBALANCE` (close and reopen centred on the current price)
- `WIDEN_RANGE`
- `PARTIAL_EXIT` / `FULL_EXIT`
- `SWAP_TO_BASE` (after exit, convert the other token back to SOL/USDC)

Writes a `proposal`. Critical events (`TOKEN_FLAGGED`, `TVL_DROP` severe, `STOP_LOSS`) skip the agent: code proposes `FULL_EXIT` immediately with priority.

**Rebalance discipline:** max N rebalances per position per day and a cooldown — avoids burning fees on every wiggle.

---

## 7. Risk Officer (code only)

**Role:** the compliance desk. Every proposal goes through it; it can **approve, reject, or resize**. No LLM involved.

### Rules (`config/risk.yaml`)
**Portfolio**
- Max per position: 10% of portfolio
- Max open positions: 8
- Max exposure to one token (across pools): 15%
- Max total in non-major tokens: 50%
- Keep a SOL reserve for fees / rent: e.g. 0.5 SOL — never deployed
- Daily loss limit: −5% portfolio → **block all new entries**, exits only
- Drawdown from peak −15% → **kill switch**: exit everything to base, stop, alert human

**Per trade**
- Max slippage: 1% (majors) / 2% (others)
- Max priority fee per tx
- Price impact of the swap < 1%
- Token must have passed the Screener within the last N hours
- Pool program must be on the **program allowlist** (Meteora DLMM, Orca Whirlpool, Raydium CLMM, Jupiter, System, Token, ATA, Compute Budget)
- Cooldown: no re-entry to a pool within X hours of exiting it at a loss

**Mode gates**
- `paper` → approve to a simulated executor only
- `approval` → approved proposals still need a human "✅" in Telegram (expires after N minutes)
- `auto` → proposals under `auto_max_size` go straight through; bigger ones need a human

**Exits are always allowed** (even when limits are hit) — the Risk Officer only blocks things that *add* risk.

Every decision is logged with the rule that triggered it.

---

## 8. Executor (code only)

**Role:** the only component that can sign. Does exactly what an approved proposal says — nothing more.

**Key handling**
- Dedicated hot wallet holding only the desk's capital (not your main wallet)
- Key loaded from an encrypted file / env at process start; never logged, never in any agent's context
- Optional: sign via a separate signer process the main app talks to over a local socket

**For each approved proposal:**
1. **Re-check freshness** — proposal still valid? Price moved > tolerance since approval? If so, send back to Risk.
2. **Build the transaction** with the DEX SDK (`@meteora-ag/dlmm`, `@orca-so/whirlpools`, Raydium SDK) or Jupiter Swap API.
3. **Inspect instructions** — every program ID must be on the allowlist; token transfers only to our own accounts or the pool. Anything else → abort.
4. **Simulate** (`simulateTransaction`) — check it succeeds and the **balance changes match the proposal** within tolerance. Mismatch → abort.
5. **Set compute budget and priority fee** (Helius priority-fee estimate, capped by Risk).
6. **Send** (RPC, or Jito bundle for MEV protection on swaps) and **confirm**.
7. **Retry** with a fresh blockhash on expiry, max N tries; idempotency key per proposal so a retry can never double-execute.
8. **Record** signature, actual amounts, fees, slippage → `executions`; update `positions`.
9. On failure → mark proposal `FAILED`, raise an event, Manager is told.

**Paper mode:** same steps 1–4 against real quotes and simulation, but step 6 writes a simulated fill instead of sending.

---

## 9. Proposal lifecycle

```
PROPOSED ─► MANAGER_APPROVED ─► RISK_APPROVED ─► (HUMAN_APPROVED) ─► EXECUTING ─► DONE
    │              │                  │                  │                 │
    └─► REJECTED   └─► REJECTED       └─► REJECTED/RESIZED └─► EXPIRED      └─► FAILED
```
Emergency exits (`STOP_LOSS`, `TOKEN_FLAGGED`, kill switch) go `PROPOSED ─► RISK_APPROVED ─► EXECUTING` without waiting for the Manager.

---

## 10. Human interface (Telegram)

- Cycle updates and daily report
- Approve / reject buttons for proposals in `approval` mode
- Commands: `/status`, `/positions`, `/pause`, `/resume`, `/mode paper|approval|auto`, `/exitall`
- Alerts: kill switch, failed transactions, flagged tokens, RPC down

---

## 11. Rollout

1. **Paper (2+ weeks):** everything live except sending. Measure: would-be PnL, fees vs IL, how often the Screener caught bad tokens, false exits.
2. **Approval mode, small capital:** human approves every trade.
3. **Auto mode** with low `auto_max_size`, raising limits only after a stable record.

## 12. Milestones

1. Repo skeleton, config, DB schema, Telegram bot
2. Screener stages 1–6 (code) + token-identity and safety checks, with tests on known scams/impersonators
3. Position monitor + snapshots + events (Meteora DLMM first)
4. Risk Officer + rules + tests
5. Executor in paper mode (simulate only)
6. Agents: Screener review, Position decision, Manager — via Claude Agent SDK
7. End-to-end paper run → approval mode → auto
