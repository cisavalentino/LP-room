-- LP-room shared state. Bots never call each other; they read/write these tables.
-- All timestamps are unix epoch milliseconds. *_json columns hold JSON text.

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tokens (
  mint            TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  decimals        INTEGER NOT NULL,
  program         TEXT NOT NULL CHECK (program IN ('spl', 'token2022', 'unknown')),
  safety_score    REAL,                         -- 0..1, null = never checked
  status          TEXT NOT NULL DEFAULT 'UNCHECKED'
                  CHECK (status IN ('UNCHECKED', 'PASS', 'REJECT')),
  flags_json      TEXT NOT NULL DEFAULT '[]',   -- e.g. ["IMPERSONATOR","MINT_AUTHORITY"]
  is_major        INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL,
  last_checked    INTEGER
);

CREATE TABLE IF NOT EXISTS pools (
  address         TEXT PRIMARY KEY,
  dex             TEXT NOT NULL CHECK (dex IN ('meteora_dlmm', 'orca_whirlpool', 'raydium_clmm')),
  mint_x          TEXT NOT NULL,
  mint_y          TEXT NOT NULL,
  bin_step        INTEGER,                      -- DLMM bin step / CLMM tick spacing
  fee_bps         REAL,
  tvl_usd         REAL,
  volume_24h_usd  REAL,
  fees_24h_usd    REAL,
  fee_apr         REAL,                         -- real: fees_24h / tvl * 365 * 100
  price           REAL,                         -- price of X in Y (UI units)
  created_at      INTEGER,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);

-- Pool metric history (for TVL-drop / volatility checks).
CREATE TABLE IF NOT EXISTS pool_history (
  pool            TEXT NOT NULL REFERENCES pools(address),
  ts              INTEGER NOT NULL,
  tvl_usd         REAL,
  volume_24h_usd  REAL,
  price           REAL,
  PRIMARY KEY (pool, ts)
);

CREATE TABLE IF NOT EXISTS screen_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  stats_json      TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES screen_runs(id),
  pool            TEXT NOT NULL REFERENCES pools(address),
  token_mint      TEXT NOT NULL,                -- the non-base token
  base_mint       TEXT NOT NULL,
  score           REAL NOT NULL,
  rank            INTEGER NOT NULL,
  reasons_json    TEXT NOT NULL DEFAULT '[]',
  metrics_json    TEXT NOT NULL DEFAULT '{}',
  agent_verdict_json TEXT,                      -- filled by Screener agent (milestone 6)
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);

-- Every pool rejected and why: the "how often did we catch bad tokens" metric.
CREATE TABLE IF NOT EXISTS screen_rejections (
  run_id          INTEGER NOT NULL REFERENCES screen_runs(id),
  pool            TEXT NOT NULL,
  token_mint      TEXT,
  stage           TEXT NOT NULL,
  reasons_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address         TEXT NOT NULL UNIQUE,         -- on-chain address, or paper-<uuid>
  pool            TEXT NOT NULL REFERENCES pools(address),
  dex             TEXT NOT NULL,
  paper           INTEGER NOT NULL DEFAULT 1,
  token_mint      TEXT NOT NULL,                -- non-base token
  base_mint       TEXT NOT NULL,
  strategy        TEXT NOT NULL,                -- spot | curve | bid_ask
  lower_bin       INTEGER NOT NULL,
  upper_bin       INTEGER NOT NULL,
  deposit_x       REAL NOT NULL,                -- UI units
  deposit_y       REAL NOT NULL,
  deposit_usd     REAL NOT NULL,
  entry_price     REAL NOT NULL,                -- X in Y
  model_json      TEXT,                         -- paper liquidity model (per-bin)
  fees_claimed_usd REAL NOT NULL DEFAULT 0,
  tx_costs_usd    REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER,
  close_pnl_usd   REAL,
  rebalance_count INTEGER NOT NULL DEFAULT 0,
  last_rebalance_at INTEGER
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id     INTEGER NOT NULL REFERENCES positions(id),
  ts              INTEGER NOT NULL,
  price           REAL NOT NULL,                -- X in Y
  token_price_usd REAL NOT NULL,
  base_price_usd  REAL NOT NULL,
  active_bin      INTEGER NOT NULL,
  in_range        INTEGER NOT NULL,
  amount_x        REAL NOT NULL,
  amount_y        REAL NOT NULL,
  value_usd       REAL NOT NULL,
  value_sol       REAL NOT NULL,
  fees_unclaimed_usd REAL NOT NULL,
  fees_total_usd  REAL NOT NULL,                -- claimed + unclaimed
  hodl_value_usd  REAL NOT NULL,
  il_pct          REAL NOT NULL,                -- (hodl - value) / hodl * 100
  pnl_usd         REAL NOT NULL,
  pnl_pct         REAL NOT NULL,
  pool_tvl_usd    REAL,
  pool_volume_24h_usd REAL,
  pool_fee_apr    REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos_ts ON position_snapshots(position_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  position_id     INTEGER REFERENCES positions(id),
  pool            TEXT,
  token_mint      TEXT,
  details_json    TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'HANDLED', 'RESOLVED')),
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_open ON events(status, type, position_id);

CREATE TABLE IF NOT EXISTS proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action          TEXT NOT NULL,                -- ENTER | CLAIM_FEES | REBALANCE | WIDEN_RANGE | PARTIAL_EXIT | FULL_EXIT | SWAP_TO_BASE
  state           TEXT NOT NULL,
  emergency       INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,                -- position_monitor | manager | human | kill_switch | ...
  position_id     INTEGER REFERENCES positions(id),
  pool            TEXT,
  event_id        INTEGER REFERENCES events(id),
  params_json     TEXT NOT NULL DEFAULT '{}',   -- size_usd, range_pct, strategy, fraction, slippage_bps, ...
  reasoning       TEXT,
  ref_price       REAL,                         -- price at approval, for freshness check
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_state ON proposals(state);

-- Full audit trail of state transitions.
CREATE TABLE IF NOT EXISTS proposal_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     INTEGER NOT NULL REFERENCES proposals(id),
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  actor           TEXT NOT NULL,
  note            TEXT,
  ts              INTEGER NOT NULL
);

-- Every Risk Officer decision with the rules that fired.
CREATE TABLE IF NOT EXISTS risk_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     INTEGER NOT NULL REFERENCES proposals(id),
  outcome         TEXT NOT NULL CHECK (outcome IN ('APPROVE', 'REJECT', 'RESIZE')),
  original_size_usd REAL,
  approved_size_usd REAL,
  checks_json     TEXT NOT NULL,
  ts              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     INTEGER NOT NULL REFERENCES proposals(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  simulated       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'DONE', 'FAILED', 'ABORTED')),
  signature       TEXT,                         -- paper-<uuid> in paper mode
  attempts        INTEGER NOT NULL DEFAULT 0,
  plan_json       TEXT,                         -- instructions that would have been sent
  expected_json   TEXT,                         -- balance changes per proposal
  simulated_json  TEXT,                         -- balance changes per simulation
  fees_usd        REAL,
  slippage_bps    REAL,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                -- cycle | daily | alert
  body            TEXT NOT NULL,
  sent            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Wallet balances (simulated in paper mode), UI units.
CREATE TABLE IF NOT EXISTS balances (
  mint            TEXT PRIMARY KEY,
  amount          REAL NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  ts              INTEGER PRIMARY KEY,
  value_usd       REAL NOT NULL,
  free_usd        REAL NOT NULL,
  deployed_usd    REAL NOT NULL,
  sol_price_usd   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);
