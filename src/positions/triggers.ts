import type { PositionsConfig } from "../config/schema";
import type { SnapshotRow } from "../db/store";
import type { EventType, Position, Severity, TokenRow } from "../types";
import { HOUR, MINUTE } from "../types";

export interface TriggerHit {
  type: EventType;
  severity: Severity;
  details: Record<string, unknown>;
}

/** Critical events skip the agent: code proposes FULL_EXIT immediately. */
export const CRITICAL_EXIT_EVENTS: ReadonlySet<EventType> = new Set(["STOP_LOSS", "TOKEN_FLAGGED", "TVL_DROP"]);

/** Sample closest to (and not after) `ts`, else the oldest after it. */
function sampleNear(history: SnapshotRow[], ts: number): SnapshotRow | undefined {
  let best: SnapshotRow | undefined;
  for (const s of history) {
    if (s.ts <= ts) best = s;
    else break;
  }
  return best;
}

/**
 * Evaluates every trigger for one position. `history` is the snapshots of the last ~6h+ in
 * ascending order, ending with `now` (the snapshot just taken).
 */
export function evaluateTriggers(
  pos: Position,
  now: SnapshotRow,
  history: SnapshotRow[],
  token: TokenRow | undefined,
  cfg: PositionsConfig,
): TriggerHit[] {
  const t = cfg.triggers;
  const hits: TriggerHit[] = [];

  // OUT_OF_RANGE: continuously out for > N minutes.
  if (!now.in_range) {
    // Start of the current out-of-range streak.
    let since = now.ts;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.in_range) break;
      since = Math.min(since, history[i]!.ts);
    }
    const outMin = (now.ts - since) / MINUTE;
    if (outMin > t.out_of_range_min) {
      hits.push({ type: "OUT_OF_RANGE", severity: "warning", details: { out_minutes: Math.round(outMin), active_bin: now.active_bin, lower_bin: pos.lower_bin, upper_bin: pos.upper_bin, side: now.active_bin < pos.lower_bin ? "below" : "above" } });
    }
  }

  // IL_HIGH: IL above threshold and fees don't cover it.
  const ilUsd = now.hodl_value_usd - now.value_usd;
  if (now.il_pct > t.il_high_pct && now.fees_total_usd < ilUsd) {
    hits.push({ type: "IL_HIGH", severity: "warning", details: { il_pct: round(now.il_pct), il_usd: round(ilUsd), fees_usd: round(now.fees_total_usd) } });
  }

  if (now.pnl_pct < t.stop_loss_pct) {
    hits.push({ type: "STOP_LOSS", severity: "critical", details: { pnl_pct: round(now.pnl_pct), pnl_usd: round(now.pnl_usd) } });
  }

  const feesPct = pos.deposit_usd > 0 ? (now.fees_total_usd / pos.deposit_usd) * 100 : 0;
  if (now.pnl_pct > t.take_profit_pct || feesPct > t.take_profit_fees_pct) {
    hits.push({ type: "TAKE_PROFIT", severity: "info", details: { pnl_pct: round(now.pnl_pct), fees_pct: round(feesPct) } });
  }

  // 1h-ago comparisons need a sample at least ~1h old.
  const hourAgo = sampleNear(history, now.ts - HOUR);
  if (hourAgo && now.ts - hourAgo.ts >= 50 * MINUTE) {
    if (hourAgo.pool_tvl_usd && now.pool_tvl_usd !== null) {
      const drop = ((hourAgo.pool_tvl_usd - now.pool_tvl_usd) / hourAgo.pool_tvl_usd) * 100;
      if (drop > t.tvl_drop_1h_pct) {
        hits.push({
          type: "TVL_DROP",
          severity: drop > t.tvl_drop_severe_pct ? "critical" : "warning",
          details: { drop_pct: round(drop), tvl_before: round(hourAgo.pool_tvl_usd), tvl_now: round(now.pool_tvl_usd) },
        });
      }
    }
    if (hourAgo.token_price_usd > 0) {
      const drop = ((hourAgo.token_price_usd - now.token_price_usd) / hourAgo.token_price_usd) * 100;
      if (drop > t.price_crash_1h_pct) {
        hits.push({ type: "PRICE_CRASH", severity: "warning", details: { drop_pct: round(drop) } });
      }
    }
  }

  if (token?.status === "REJECT") {
    hits.push({ type: "TOKEN_FLAGGED", severity: "critical", details: { flags: token.flags } });
  }

  // FEES_DRIED_UP: fee APR below threshold for the whole window, with enough coverage.
  const windowStart = now.ts - t.fees_dried_up_hours * HOUR;
  const win = history.filter((s) => s.ts >= windowStart);
  const covered = history.length > 0 && history[0]!.ts <= windowStart + 10 * MINUTE;
  if (covered && win.length >= 2 && win.every((s) => s.pool_fee_apr !== null && s.pool_fee_apr < t.fees_dried_up_apr)) {
    hits.push({ type: "FEES_DRIED_UP", severity: "info", details: { fee_apr: round(now.pool_fee_apr ?? 0), hours: t.fees_dried_up_hours } });
  }

  if (now.fees_unclaimed_usd > t.claim_due_usd) {
    hits.push({ type: "CLAIM_DUE", severity: "info", details: { unclaimed_usd: round(now.fees_unclaimed_usd) } });
  }

  // TVL_DROP severity decides whether it's an emergency.
  return hits;
}

/** Whether a hit requires the code-driven emergency exit path. */
export function isCriticalExit(hit: TriggerHit): boolean {
  return CRITICAL_EXIT_EVENTS.has(hit.type) && hit.severity === "critical";
}

const round = (x: number) => Math.round(x * 100) / 100;
