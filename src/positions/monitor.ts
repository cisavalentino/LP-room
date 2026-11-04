import type { Config } from "../config/schema";
import { SOL_MINT } from "../config/load";
import type { SnapshotRow, Store } from "../db/store";
import { logger } from "../lib/log";
import { createProposal, proposeEmergencyExit } from "../proposals/lifecycle";
import type { Position } from "../types";
import { DAY, HOUR, MINUTE } from "../types";
import { binIdFromPrice, composition, inRange, type DlmmPositionModel } from "./dlmmModel";
import type { PoolState, PoolStateSource, PriceSource } from "./market";
import { evaluateTriggers, isCriticalExit, type TriggerHit } from "./triggers";

const log = logger("position-monitor");

export interface MonitorDeps {
  pools: PoolStateSource;
  prices: PriceSource;
}

export interface Valuation {
  activeBin: number;
  inRange: boolean;
  x: number;
  y: number;
  usdX: number;
  usdY: number;
  valueUsd: number;
}

/** Values a paper DLMM position at the given pool state / prices. */
export function valuePosition(pos: Position, state: PoolState, usdY: number): Valuation {
  const model = pos.model as DlmmPositionModel;
  const activeBin = binIdFromPrice(state.price, model.binStep, model.decimalsX, model.decimalsY);
  const { x, y } = composition(model, activeBin);
  const usdX = state.price * usdY;
  return { activeBin, inRange: inRange(model, activeBin), x, y, usdX, usdY, valueUsd: x * usdX + y * usdY };
}

/**
 * Position Manager — monitor loop (code). Every few minutes: snapshot each open position,
 * evaluate triggers, write events. Critical events go straight to an emergency FULL_EXIT
 * proposal; others stay OPEN for the Position agent (milestone 6).
 */
export class PositionMonitor {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly deps: MonitorDeps,
  ) {}

  async runOnce(): Promise<{ snapshots: number; events: number[]; errors: string[] }> {
    const positions = this.store.openPositions();
    const events: number[] = [];
    const errors: string[] = [];
    if (!positions.length) return { snapshots: 0, events, errors };

    const mints = new Set<string>([SOL_MINT]);
    const states = new Map<string, PoolState>();
    for (const pool of new Set(positions.map((p) => p.pool))) {
      try {
        const s = await this.deps.pools.getPoolState(pool);
        states.set(pool, s);
        mints.add(s.mintX).add(s.mintY);
      } catch (e) {
        errors.push(`pool ${pool}: ${(e as Error).message}`);
      }
    }
    let prices = new Map<string, number>();
    try {
      prices = await this.deps.prices.pricesUsd([...mints]);
    } catch (e) {
      errors.push(`prices: ${(e as Error).message}`);
    }

    let snapshots = 0;
    for (const pos of positions) {
      const state = states.get(pos.pool);
      const usdY = state ? prices.get(state.mintY) : undefined;
      const sol = prices.get(SOL_MINT);
      if (!state || !usdY || !sol || !pos.model) {
        errors.push(`position ${pos.id}: missing ${!state ? "pool state" : !pos.model ? "model" : "price"}`);
        continue;
      }
      const snap = this.snapshot(pos, state, usdY, sol);
      snapshots++;
      events.push(...this.handleTriggers(this.store.getPosition(pos.id)!, snap));
    }
    for (const e of errors) log.warn(e);
    return { snapshots, events, errors };
  }

  snapshot(pos: Position, state: PoolState, usdY: number, solUsd: number): SnapshotRow {
    const now = this.store.now();
    const model = pos.model as DlmmPositionModel;
    const v = valuePosition(pos, state, usdY);
    const pf = this.cfg.positions.paper_fees;

    // Paper fee accrual: pool fees over the interval × our share of pool liquidity, only in range.
    const dt = Math.min(Math.max(0, now - model.lastAccrualTs), pf.max_accrual_gap_min * MINUTE);
    let accrued = 0;
    if (v.inRange && state.tvlUsd > 0) {
      const share = Math.min(1, (v.valueUsd / state.tvlUsd) * pf.share_boost);
      accrued = state.fees24hUsd * (dt / DAY) * share;
    }
    const nextModel: DlmmPositionModel = { ...model, feesUnclaimedUsd: model.feesUnclaimedUsd + accrued, lastAccrualTs: now };
    this.store.updatePosition(pos.id, { model: nextModel });

    const tokenIsX = state.mintX === pos.token_mint;
    const tokenUsd = tokenIsX ? v.usdX : v.usdY;
    const baseUsd = tokenIsX ? v.usdY : v.usdX;
    const hodl = pos.deposit_x * v.usdX + pos.deposit_y * v.usdY;
    const feesTotal = pos.fees_claimed_usd + nextModel.feesUnclaimedUsd;
    const pnl = v.valueUsd + feesTotal - pos.deposit_usd - pos.tx_costs_usd;
    const feeApr = state.tvlUsd > 0 ? (state.fees24hUsd / state.tvlUsd) * 365 * 100 : 0;

    const row = {
      position_id: pos.id,
      ts: now,
      price: state.price,
      token_price_usd: tokenUsd,
      base_price_usd: baseUsd,
      active_bin: v.activeBin,
      in_range: v.inRange ? 1 : 0,
      amount_x: v.x,
      amount_y: v.y,
      value_usd: v.valueUsd,
      value_sol: v.valueUsd / solUsd,
      fees_unclaimed_usd: nextModel.feesUnclaimedUsd,
      fees_total_usd: feesTotal,
      hodl_value_usd: hodl,
      il_pct: hodl > 0 ? ((hodl - v.valueUsd) / hodl) * 100 : 0,
      pnl_usd: pnl,
      pnl_pct: pos.deposit_usd > 0 ? (pnl / pos.deposit_usd) * 100 : 0,
      pool_tvl_usd: state.tvlUsd,
      pool_volume_24h_usd: state.volume24hUsd,
      pool_fee_apr: feeApr,
    };
    const cols = Object.keys(row);
    const id = this.store.db.run(
      `INSERT INTO position_snapshots (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      Object.values(row),
    ).lastInsertRowid;
    this.store.db.run(
      "INSERT OR REPLACE INTO pool_history (pool, ts, tvl_usd, volume_24h_usd, price) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pools WHERE address = ?)",
      [pos.pool, now, state.tvlUsd, state.volume24hUsd, state.price, pos.pool],
    );
    return { id, ...row };
  }

  /** Turns trigger hits into events / proposals. Returns new event ids. */
  handleTriggers(pos: Position, snap: SnapshotRow): number[] {
    const window = Math.max(this.cfg.positions.triggers.fees_dried_up_hours, 1) * HOUR + 30 * MINUTE;
    const history = this.store.snapshotsSince(pos.id, snap.ts - window);
    const hits = evaluateTriggers(pos, snap, history, this.store.getToken(pos.token_mint), this.cfg.positions);
    const created: number[] = [];

    this.store.db.tx(() => {
      const hitTypes = new Set(hits.map((h) => h.type));
      // Resolve open events whose condition cleared.
      for (const e of this.store.openEvents()) {
        if (e.position_id === pos.id && !hitTypes.has(e.type) && e.type !== "EXECUTION_FAILED") {
          this.store.setEventStatus(e.id, "RESOLVED");
        }
      }
      for (const hit of hits) {
        const id = this.raise(pos, hit);
        if (id !== null) created.push(id);
      }
    });
    return created;
  }

  private raise(pos: Position, hit: TriggerHit): number | null {
    const critical = isCriticalExit(hit);
    const existing = this.store.findOpenEvent(hit.type, pos.id);
    if (existing) {
      // Already open. Only a warning that escalates to critical is raised again.
      if (!(critical && existing.severity !== "critical")) return null;
      this.store.setEventStatus(existing.id, "RESOLVED");
    }
    if (critical) {
      const handled = this.store.db.get(
        "SELECT 1 FROM events WHERE type = ? AND position_id = ? AND status = 'HANDLED' AND severity = 'critical'",
        [hit.type, pos.id],
      );
      if (handled) return null; // emergency exit already proposed for this position
    }
    const id = this.store.createEvent({
      type: hit.type,
      severity: hit.severity,
      position_id: pos.id,
      pool: pos.pool,
      token_mint: pos.token_mint,
      details: hit.details,
    });
    if (critical) {
      // Emergency: skip the agent, code proposes FULL_EXIT with priority.
      const p = proposeEmergencyExit(this.store, pos.id, "position_monitor", `${hit.type}: ${JSON.stringify(hit.details)}`, id);
      this.store.setEventStatus(id, "HANDLED");
      this.store.addReport("alert", `${hit.type} on position #${pos.id} (${pos.pool}) → emergency FULL_EXIT proposal #${p.id}`);
    } else if (hit.type === "CLAIM_DUE") {
      const active = this.store.activeProposalsForPosition(pos.id);
      if (!active.some((p) => p.action === "CLAIM_FEES" || p.action === "FULL_EXIT")) {
        createProposal(this.store, {
          action: "CLAIM_FEES",
          source: "position_monitor",
          position_id: pos.id,
          pool: pos.pool,
          event_id: id,
          reasoning: `Unclaimed fees ${hit.details.unclaimed_usd} USD above threshold`,
        });
      }
    }
    return id;
  }
}
