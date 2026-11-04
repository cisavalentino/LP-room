import type {
  Clock,
  DeskEvent,
  EventType,
  PoolRow,
  Position,
  Proposal,
  ProposalAction,
  ProposalParams,
  ProposalState,
  Severity,
  TokenRow,
} from "../types";
import { systemClock } from "../types";
import { type Db, json, type Row } from "./db";

/**
 * Typed access to the shared tables. Every bot gets a Store; this is the only way they communicate.
 */
export class Store {
  constructor(
    readonly db: Db,
    readonly now: Clock = systemClock,
  ) {}

  // ---------- system_state ----------
  getState(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM system_state WHERE key = ?", [key])?.value;
  }
  setState(key: string, value: string): void {
    this.db.run(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, this.now()],
    );
  }
  isPaused(): boolean {
    return this.getState("paused") === "1";
  }
  setPaused(paused: boolean): void {
    this.setState("paused", paused ? "1" : "0");
  }
  isKillSwitchActive(): boolean {
    return this.getState("kill_switch") === "1";
  }
  setKillSwitch(active: boolean): void {
    this.setState("kill_switch", active ? "1" : "0");
  }

  // ---------- tokens ----------
  upsertToken(t: Omit<TokenRow, "first_seen" | "last_checked" | "safety_score" | "status" | "flags"> &
    Partial<Pick<TokenRow, "safety_score" | "status" | "flags" | "last_checked">>): void {
    const now = this.now();
    this.db.run(
      `INSERT INTO tokens (mint, symbol, name, decimals, program, safety_score, status, flags_json, is_major, first_seen, last_checked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET
         symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
         program = CASE WHEN excluded.program = 'unknown' THEN tokens.program ELSE excluded.program END,
         is_major = excluded.is_major,
         safety_score = COALESCE(excluded.safety_score, tokens.safety_score),
         status = CASE WHEN excluded.last_checked IS NULL THEN tokens.status ELSE excluded.status END,
         flags_json = CASE WHEN excluded.last_checked IS NULL THEN tokens.flags_json ELSE excluded.flags_json END,
         last_checked = COALESCE(excluded.last_checked, tokens.last_checked)`,
      [
        t.mint,
        t.symbol,
        t.name,
        t.decimals,
        t.program,
        t.safety_score ?? null,
        t.status ?? "UNCHECKED",
        json.str(t.flags ?? []),
        t.is_major ? 1 : 0,
        now,
        t.last_checked ?? null,
      ],
    );
  }
  setTokenVerdict(mint: string, status: TokenRow["status"], flags: string[], safetyScore: number | null): void {
    this.db.run(
      "UPDATE tokens SET status = ?, flags_json = ?, safety_score = ?, last_checked = ? WHERE mint = ?",
      [status, json.str(flags), safetyScore, this.now(), mint],
    );
  }
  getToken(mint: string): TokenRow | undefined {
    const r = this.db.get("SELECT * FROM tokens WHERE mint = ?", [mint]);
    return r ? toToken(r) : undefined;
  }

  // ---------- pools ----------
  upsertPool(p: Omit<PoolRow, "first_seen" | "last_seen">): void {
    const now = this.now();
    this.db.run(
      `INSERT INTO pools (address, dex, mint_x, mint_y, bin_step, fee_bps, tvl_usd, volume_24h_usd, fees_24h_usd, fee_apr, price, created_at, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         bin_step = excluded.bin_step, fee_bps = excluded.fee_bps, tvl_usd = excluded.tvl_usd,
         volume_24h_usd = excluded.volume_24h_usd, fees_24h_usd = excluded.fees_24h_usd,
         fee_apr = excluded.fee_apr, price = excluded.price,
         created_at = COALESCE(excluded.created_at, pools.created_at), last_seen = excluded.last_seen`,
      [
        p.address, p.dex, p.mint_x, p.mint_y, p.bin_step, p.fee_bps, p.tvl_usd, p.volume_24h_usd,
        p.fees_24h_usd, p.fee_apr, p.price, p.created_at, now, now,
      ],
    );
    this.db.run(
      "INSERT OR REPLACE INTO pool_history (pool, ts, tvl_usd, volume_24h_usd, price) VALUES (?, ?, ?, ?, ?)",
      [p.address, now, p.tvl_usd, p.volume_24h_usd, p.price],
    );
  }
  getPool(address: string): PoolRow | undefined {
    return this.db.get<PoolRow>("SELECT * FROM pools WHERE address = ?", [address]);
  }
  /** Oldest pool_history row at or after `since`. */
  poolHistorySince(pool: string, since: number): { ts: number; tvl_usd: number | null; price: number | null }[] {
    return this.db.all("SELECT ts, tvl_usd, price FROM pool_history WHERE pool = ? AND ts >= ? ORDER BY ts", [
      pool,
      since,
    ]);
  }

  // ---------- events ----------
  createEvent(e: {
    type: EventType;
    severity: Severity;
    position_id?: number | null;
    pool?: string | null;
    token_mint?: string | null;
    details?: Record<string, unknown>;
  }): number {
    return this.db.run(
      `INSERT INTO events (type, severity, position_id, pool, token_mint, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.type, e.severity, e.position_id ?? null, e.pool ?? null, e.token_mint ?? null, json.str(e.details ?? {}), this.now()],
    ).lastInsertRowid;
  }
  findOpenEvent(type: EventType, positionId: number | null): DeskEvent | undefined {
    const r = this.db.get(
      "SELECT * FROM events WHERE type = ? AND status = 'OPEN' AND position_id IS ? ORDER BY id DESC LIMIT 1",
      [type, positionId],
    );
    return r ? toEvent(r) : undefined;
  }
  openEvents(): DeskEvent[] {
    return this.db.all("SELECT * FROM events WHERE status = 'OPEN' ORDER BY id").map(toEvent);
  }
  setEventStatus(id: number, status: DeskEvent["status"]): void {
    this.db.run("UPDATE events SET status = ?, resolved_at = ? WHERE id = ?", [
      status,
      status === "OPEN" ? null : this.now(),
      id,
    ]);
  }

  // ---------- proposals (state changes go through proposals/lifecycle.ts) ----------
  insertProposal(p: {
    action: ProposalAction;
    state: ProposalState;
    emergency?: boolean;
    priority?: number;
    source: string;
    position_id?: number | null;
    pool?: string | null;
    event_id?: number | null;
    params?: ProposalParams;
    reasoning?: string | null;
    ref_price?: number | null;
    expires_at?: number | null;
  }): number {
    const now = this.now();
    return this.db.run(
      `INSERT INTO proposals (action, state, emergency, priority, source, position_id, pool, event_id, params_json, reasoning, ref_price, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.action, p.state, p.emergency ? 1 : 0, p.priority ?? 0, p.source, p.position_id ?? null, p.pool ?? null,
        p.event_id ?? null, json.str(p.params ?? {}), p.reasoning ?? null, p.ref_price ?? null, now, now,
        p.expires_at ?? null,
      ],
    ).lastInsertRowid;
  }
  getProposal(id: number): Proposal | undefined {
    const r = this.db.get("SELECT * FROM proposals WHERE id = ?", [id]);
    return r ? toProposal(r) : undefined;
  }
  proposalsInState(...states: ProposalState[]): Proposal[] {
    const q = states.map(() => "?").join(",");
    return this.db
      .all(`SELECT * FROM proposals WHERE state IN (${q}) ORDER BY emergency DESC, priority DESC, id`, states)
      .map(toProposal);
  }
  /** Active (non-terminal) proposals for a position. */
  activeProposalsForPosition(positionId: number): Proposal[] {
    return this.db
      .all(
        `SELECT * FROM proposals WHERE position_id = ? AND state NOT IN ('DONE','REJECTED','EXPIRED','FAILED') ORDER BY id`,
        [positionId],
      )
      .map(toProposal);
  }

  // ---------- positions ----------
  insertPosition(p: Omit<Position, "id" | "status" | "closed_at" | "close_pnl_usd" | "rebalance_count" | "last_rebalance_at" | "fees_claimed_usd" | "tx_costs_usd"> &
    Partial<Pick<Position, "tx_costs_usd">>): number {
    return this.db.run(
      `INSERT INTO positions (address, pool, dex, paper, token_mint, base_mint, strategy, lower_bin, upper_bin, deposit_x, deposit_y, deposit_usd, entry_price, model_json, tx_costs_usd, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.address, p.pool, p.dex, p.paper ? 1 : 0, p.token_mint, p.base_mint, p.strategy, p.lower_bin, p.upper_bin,
        p.deposit_x, p.deposit_y, p.deposit_usd, p.entry_price, json.str(p.model), p.tx_costs_usd ?? 0, p.opened_at,
      ],
    ).lastInsertRowid;
  }
  getPosition(id: number): Position | undefined {
    const r = this.db.get("SELECT * FROM positions WHERE id = ?", [id]);
    return r ? toPosition(r) : undefined;
  }
  openPositions(): Position[] {
    return this.db.all("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id").map(toPosition);
  }
  updatePosition(id: number, fields: Partial<Omit<Position, "id">>): void {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k === "model") {
        cols.push("model_json = ?");
        vals.push(json.str(v));
      } else if (k === "paper") {
        cols.push("paper = ?");
        vals.push(v ? 1 : 0);
      } else {
        cols.push(`${k} = ?`);
        vals.push(v as string | number | null);
      }
    }
    if (!cols.length) return;
    this.db.run(`UPDATE positions SET ${cols.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  /** Most recent close of a pool (for re-entry cooldown). */
  lastClosedPosition(pool: string): Position | undefined {
    const r = this.db.get(
      "SELECT * FROM positions WHERE pool = ? AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT 1",
      [pool],
    );
    return r ? toPosition(r) : undefined;
  }

  // ---------- snapshots ----------
  latestSnapshot(positionId: number): SnapshotRow | undefined {
    return this.db.get<SnapshotRow>(
      "SELECT * FROM position_snapshots WHERE position_id = ? ORDER BY ts DESC, id DESC LIMIT 1",
      [positionId],
    );
  }
  snapshotsSince(positionId: number, since: number): SnapshotRow[] {
    return this.db.all<SnapshotRow>(
      "SELECT * FROM position_snapshots WHERE position_id = ? AND ts >= ? ORDER BY ts, id",
      [positionId, since],
    );
  }

  // ---------- balances ----------
  getBalances(): Map<string, number> {
    return new Map(this.db.all<{ mint: string; amount: number }>("SELECT mint, amount FROM balances").map((r) => [r.mint, r.amount]));
  }
  getBalance(mint: string): number {
    return this.db.get<{ amount: number }>("SELECT amount FROM balances WHERE mint = ?", [mint])?.amount ?? 0;
  }
  adjustBalance(mint: string, delta: number): void {
    const next = this.getBalance(mint) + delta;
    if (next < -1e-9) throw new Error(`Balance of ${mint} would go negative (${next})`);
    this.db.run(
      `INSERT INTO balances (mint, amount, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
      [mint, Math.max(0, next), this.now()],
    );
  }

  // ---------- reports ----------
  addReport(kind: string, body: string): number {
    return this.db.run("INSERT INTO reports (kind, body, created_at) VALUES (?, ?, ?)", [kind, body, this.now()])
      .lastInsertRowid;
  }
  unsentReports(): { id: number; kind: string; body: string }[] {
    return this.db.all("SELECT id, kind, body FROM reports WHERE sent = 0 ORDER BY id");
  }
  markReportSent(id: number): void {
    this.db.run("UPDATE reports SET sent = 1 WHERE id = ?", [id]);
  }
}

export interface SnapshotRow {
  id: number;
  position_id: number;
  ts: number;
  price: number;
  token_price_usd: number;
  base_price_usd: number;
  active_bin: number;
  in_range: number;
  amount_x: number;
  amount_y: number;
  value_usd: number;
  value_sol: number;
  fees_unclaimed_usd: number;
  fees_total_usd: number;
  hodl_value_usd: number;
  il_pct: number;
  pnl_usd: number;
  pnl_pct: number;
  pool_tvl_usd: number | null;
  pool_volume_24h_usd: number | null;
  pool_fee_apr: number | null;
}

function toToken(r: Row): TokenRow {
  return {
    ...(r as unknown as TokenRow),
    flags: json.parse<string[]>(r.flags_json, []),
    is_major: r.is_major === 1,
  };
}
function toEvent(r: Row): DeskEvent {
  return { ...(r as unknown as DeskEvent), details: json.parse(r.details_json, {}) };
}
function toProposal(r: Row): Proposal {
  return {
    ...(r as unknown as Proposal),
    emergency: r.emergency === 1,
    params: json.parse<ProposalParams>(r.params_json, {}),
  };
}
function toPosition(r: Row): Position {
  return {
    ...(r as unknown as Position),
    paper: r.paper === 1,
    model: json.parse(r.model_json, null),
  };
}
