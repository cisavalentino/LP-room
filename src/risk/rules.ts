import type { RiskConfig } from "../config/schema";
import { DEX_PROGRAM } from "../chain/programs";
import type { PortfolioState } from "../portfolio";
import type { Mode, PoolRow, Position, Proposal, ProposalParams, TokenRow } from "../types";
import { HOUR, MINUTE, RISK_ADDING_ACTIONS } from "../types";

/**
 * Risk Officer rules (PRD §7). Pure, deterministic code — no LLM, cannot be talked out of a
 * limit. Exits are always allowed; only actions that add risk can be blocked.
 */

export type CheckResult = "PASS" | "FAIL" | "RESIZE" | "CLAMP" | "INFO";
export interface Check {
  rule: string;
  result: CheckResult;
  detail: string;
}

export interface RiskInputs {
  proposal: Proposal;
  portfolio: PortfolioState;
  mode: Mode;
  paused: boolean;
  killSwitch: boolean;
  pool?: PoolRow;
  token?: TokenRow;
  position?: Position;
  /** whether the non-base token is an allowlisted major */
  tokenIsMajor: boolean;
  /** last closed position in this pool (re-entry cooldown) */
  lastClosedInPool?: Position;
  /** REBALANCE / WIDEN_RANGE executed for this position in the last 24h */
  rebalancesLast24h: number;
  lastRebalanceAt: number | null;
  /** Price impact % of the entry swap (base → token), null = no quote (fail closed). */
  entrySwapImpactPct?: number | null;
  /** Programs the transaction will touch. */
  programs: string[];
  now: number;
}

export interface RiskDecision {
  outcome: "APPROVE" | "REJECT" | "RESIZE";
  checks: Check[];
  params: ProposalParams;
  originalSizeUsd: number | null;
  approvedSizeUsd: number | null;
  /** approval mode, or auto mode above auto_max_size */
  needsHuman: boolean;
}

export function evaluate(inp: RiskInputs, cfg: RiskConfig): RiskDecision {
  const p = inp.proposal;
  const checks: Check[] = [];
  const params: ProposalParams = { ...p.params };
  const add = (rule: string, result: CheckResult, detail: string) => checks.push({ rule, result, detail });
  const addsRisk = RISK_ADDING_ACTIONS.has(p.action);
  const pf = inp.portfolio;
  const isMajor = inp.tokenIsMajor;

  // ---- per-trade clamps (apply to every action, including exits: clamp, never block)
  const maxSlip = isMajor ? cfg.trade.max_slippage_bps_major : cfg.trade.max_slippage_bps_other;
  if (params.slippage_bps === undefined) {
    params.slippage_bps = maxSlip;
    add("max_slippage", "INFO", `defaulted to ${maxSlip} bps`);
  } else if (params.slippage_bps > maxSlip) {
    add("max_slippage", "CLAMP", `${params.slippage_bps} → ${maxSlip} bps`);
    params.slippage_bps = maxSlip;
  } else add("max_slippage", "PASS", `${params.slippage_bps} bps ≤ ${maxSlip}`);

  const maxFee = cfg.trade.max_priority_fee_lamports;
  if (params.priority_fee_lamports === undefined || params.priority_fee_lamports > maxFee) {
    if (params.priority_fee_lamports !== undefined) add("max_priority_fee", "CLAMP", `${params.priority_fee_lamports} → ${maxFee}`);
    params.priority_fee_lamports = Math.min(params.priority_fee_lamports ?? maxFee, maxFee);
  } else add("max_priority_fee", "PASS", `${params.priority_fee_lamports} ≤ ${maxFee}`);

  // Program allowlist: safety invariant for every transaction, exits included.
  const allow = new Set(cfg.program_allowlist);
  const bad = inp.programs.filter((x) => !allow.has(x));
  if (bad.length) add("program_allowlist", "FAIL", `not allowlisted: ${bad.join(", ")}`);
  else add("program_allowlist", "PASS", inp.programs.join(", ") || "none");

  // ---- structural validity
  if (p.action !== "ENTER") {
    if (!inp.position) add("position_exists", "FAIL", `position ${p.position_id} not found`);
    else if (inp.position.status !== "OPEN" && p.action !== "SWAP_TO_BASE") add("position_exists", "FAIL", `position ${inp.position.id} is ${inp.position.status}`);
    else add("position_exists", "PASS", `#${inp.position.id}`);
  }
  if (p.action === "PARTIAL_EXIT") {
    const f = params.fraction;
    if (f === undefined || !(f > 0 && f < 1)) add("exit_fraction", "FAIL", `fraction must be in (0,1), got ${f}`);
  }
  if (p.action === "SWAP_TO_BASE") {
    const base = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
    if (!params.output_mint || !base.has(params.output_mint)) add("swap_to_base_output", "FAIL", `output ${params.output_mint} is not SOL/USDC`);
  }

  // ---- gates that only block risk-adding actions
  if (addsRisk) {
    if (inp.killSwitch) add("kill_switch", "FAIL", "kill switch active: exits only");
    if (inp.paused) add("paused", "FAIL", "desk paused: exits only");
    if (pf.dailyPnlPct <= -cfg.portfolio.daily_loss_limit_pct) {
      add("daily_loss_limit", "FAIL", `daily PnL ${pf.dailyPnlPct.toFixed(2)}% ≤ -${cfg.portfolio.daily_loss_limit_pct}%: exits only`);
    } else add("daily_loss_limit", "PASS", `daily PnL ${pf.dailyPnlPct.toFixed(2)}%`);
    if (pf.drawdownPct >= cfg.portfolio.kill_switch_drawdown_pct) {
      add("drawdown", "FAIL", `drawdown ${pf.drawdownPct.toFixed(2)}% ≥ ${cfg.portfolio.kill_switch_drawdown_pct}%`);
    }

    // token freshly screened and passing
    const t = inp.token;
    if (!t) add("token_screened", "FAIL", "token never screened");
    else if (t.status !== "PASS") add("token_screened", "FAIL", `token status ${t.status}: ${t.flags.join(",")}`);
    else if (!t.last_checked || inp.now - t.last_checked > cfg.trade.screened_within_hours * HOUR) {
      add("token_screened", "FAIL", `last screened ${t.last_checked ? ((inp.now - t.last_checked) / HOUR).toFixed(1) + "h" : "never"} ago > ${cfg.trade.screened_within_hours}h`);
    } else add("token_screened", "PASS", `screened ${((inp.now - t.last_checked) / MINUTE).toFixed(0)} min ago`);

    if (!inp.pool) add("pool_known", "FAIL", "pool not in database");
    else if (!allow.has(DEX_PROGRAM[inp.pool.dex])) add("pool_program", "FAIL", `${inp.pool.dex} program not allowlisted`);
    else add("pool_program", "PASS", inp.pool.dex);
  }

  if (p.action === "ENTER") enterRules(inp, cfg, params, add);
  if (p.action === "REBALANCE" || p.action === "WIDEN_RANGE") {
    const r = cfg.rebalance;
    if (inp.rebalancesLast24h >= r.max_per_position_per_day) {
      add("rebalance_limit", "FAIL", `${inp.rebalancesLast24h} rebalances in 24h ≥ ${r.max_per_position_per_day}`);
    } else add("rebalance_limit", "PASS", `${inp.rebalancesLast24h}/${r.max_per_position_per_day} in 24h`);
    if (inp.lastRebalanceAt && inp.now - inp.lastRebalanceAt < r.cooldown_min * MINUTE) {
      add("rebalance_cooldown", "FAIL", `last rebalance ${((inp.now - inp.lastRebalanceAt) / MINUTE).toFixed(0)} min ago < ${r.cooldown_min}`);
    }
  }

  const failed = checks.some((c) => c.result === "FAIL");
  const resized = checks.some((c) => c.result === "RESIZE");
  const originalSizeUsd = p.params.size_usd ?? null;
  const approvedSizeUsd = params.size_usd ?? null;
  if (resized && !failed) params.resized_from_usd = originalSizeUsd ?? undefined;

  // ---- mode gates
  let needsHuman = false;
  if (!failed) {
    if (inp.mode === "approval") {
      needsHuman = true;
      add("mode_gate", "INFO", "approval mode: human ✅ required");
    } else if (inp.mode === "auto") {
      const size = approvedSizeUsd ?? estimateNotional(inp);
      needsHuman = addsRisk && size > cfg.modes.auto_max_size_usd;
      add("mode_gate", "INFO", needsHuman ? `auto: $${size.toFixed(0)} > auto_max_size $${cfg.modes.auto_max_size_usd} → human` : "auto: within auto_max_size");
    } else add("mode_gate", "INFO", "paper: simulated executor only");
  }

  return {
    outcome: failed ? "REJECT" : resized ? "RESIZE" : "APPROVE",
    checks,
    params,
    originalSizeUsd,
    approvedSizeUsd: failed ? null : approvedSizeUsd,
    needsHuman,
  };
}

function enterRules(inp: RiskInputs, cfg: RiskConfig, params: ProposalParams, add: (r: string, x: CheckResult, d: string) => void) {
  const pf = inp.portfolio;
  const pc = cfg.portfolio;
  const requested = params.size_usd;
  if (!requested || !(requested > 0)) {
    add("size", "FAIL", `invalid size_usd ${requested}`);
    return;
  }
  if (params.range_pct !== undefined && !(params.range_pct > 0 && params.range_pct <= 100)) {
    add("range", "FAIL", `invalid range_pct ${params.range_pct}`);
  }

  if (pf.positions.length >= pc.max_open_positions) {
    add("max_open_positions", "FAIL", `${pf.positions.length} open ≥ ${pc.max_open_positions}`);
  } else add("max_open_positions", "PASS", `${pf.positions.length}/${pc.max_open_positions}`);

  const last = inp.lastClosedInPool;
  if (last && last.closed_at && (last.close_pnl_usd ?? 0) < 0 && inp.now - last.closed_at < cfg.trade.reentry_cooldown_hours * HOUR) {
    add("reentry_cooldown", "FAIL", `exited this pool at a loss ${((inp.now - last.closed_at) / HOUR).toFixed(1)}h ago < ${cfg.trade.reentry_cooldown_hours}h`);
  }

  if (inp.entrySwapImpactPct === null || inp.entrySwapImpactPct === undefined) {
    add("price_impact", "FAIL", "no quote for the entry swap");
  } else if (inp.entrySwapImpactPct >= cfg.trade.max_price_impact_pct) {
    add("price_impact", "FAIL", `${inp.entrySwapImpactPct.toFixed(2)}% ≥ ${cfg.trade.max_price_impact_pct}%`);
  } else add("price_impact", "PASS", `${inp.entrySwapImpactPct.toFixed(2)}%`);

  // Size caps — resize down to the tightest one.
  const caps: { rule: string; usd: number }[] = [
    { rule: "max_position_pct", usd: (pc.max_position_pct / 100) * pf.valueUsd },
    { rule: "free_capital_after_reserve", usd: pf.freeUsd - pc.sol_reserve * pf.solPriceUsd },
  ];
  if (inp.token && !inp.tokenIsMajor) {
    caps.push({ rule: "max_non_major_pct", usd: (pc.max_non_major_pct / 100) * pf.valueUsd - pf.nonMajorUsd });
  }
  if (inp.token) {
    const cur = pf.tokenExposureUsd.get(inp.token.mint) ?? 0;
    caps.push({ rule: "max_token_exposure_pct", usd: (pc.max_token_exposure_pct / 100) * pf.valueUsd - cur });
  }
  let size = requested;
  for (const c of caps) {
    if (c.usd < size) {
      add(c.rule, "RESIZE", `cap $${Math.max(0, c.usd).toFixed(2)} < $${size.toFixed(2)}`);
      size = Math.max(0, c.usd);
    } else add(c.rule, "PASS", `cap $${c.usd.toFixed(2)}`);
  }
  if (size < cfg.trade.min_position_usd) {
    add("min_position_usd", "FAIL", `size after caps $${size.toFixed(2)} < $${cfg.trade.min_position_usd}`);
  }
  params.size_usd = Math.floor(size * 100) / 100;
}

function estimateNotional(inp: RiskInputs): number {
  const pos = inp.portfolio.positions.find((x) => x.id === inp.proposal.position_id);
  return pos?.valueUsd ?? 0;
}
