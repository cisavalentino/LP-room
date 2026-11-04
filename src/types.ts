export type Dex = "meteora_dlmm" | "orca_whirlpool" | "raydium_clmm";
export type Strategy = "spot" | "curve" | "bid_ask";
export type Mode = "paper" | "approval" | "auto";
export type RiskMode = "aggressive" | "normal" | "defensive";

export const PROPOSAL_ACTIONS = [
  "ENTER",
  "CLAIM_FEES",
  "REBALANCE",
  "WIDEN_RANGE",
  "PARTIAL_EXIT",
  "FULL_EXIT",
  "SWAP_TO_BASE",
] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** Actions that add risk. Everything else reduces or keeps exposure and is always allowed. */
export const RISK_ADDING_ACTIONS: ReadonlySet<ProposalAction> = new Set(["ENTER", "REBALANCE", "WIDEN_RANGE"]);

export const PROPOSAL_STATES = [
  "PROPOSED",
  "MANAGER_APPROVED",
  "RISK_APPROVED",
  "HUMAN_APPROVED",
  "EXECUTING",
  "DONE",
  "REJECTED",
  "EXPIRED",
  "FAILED",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export interface ProposalParams {
  /** ENTER: USD notional to deploy. */
  size_usd?: number;
  /** ENTER / REBALANCE / WIDEN_RANGE: half-width of range as % of price. */
  range_pct?: number;
  strategy?: Strategy;
  /** PARTIAL_EXIT: fraction 0..1 of liquidity to remove. */
  fraction?: number;
  /** Max slippage the proposer wants. Risk caps it. */
  slippage_bps?: number;
  priority_fee_lamports?: number;
  /** SWAP_TO_BASE */
  input_mint?: string;
  output_mint?: string;
  amount?: number;
  /** Set by Risk when resized. */
  resized_from_usd?: number;
}

export interface Proposal {
  id: number;
  action: ProposalAction;
  state: ProposalState;
  emergency: boolean;
  priority: number;
  source: string;
  position_id: number | null;
  pool: string | null;
  event_id: number | null;
  params: ProposalParams;
  reasoning: string | null;
  ref_price: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export const EVENT_TYPES = [
  "OUT_OF_RANGE",
  "IL_HIGH",
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TVL_DROP",
  "PRICE_CRASH",
  "TOKEN_FLAGGED",
  "FEES_DRIED_UP",
  "CLAIM_DUE",
  "KILL_SWITCH",
  "EXECUTION_FAILED",
  "DAILY_LOSS_LIMIT",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Severity = "info" | "warning" | "critical";

export interface DeskEvent {
  id: number;
  type: EventType;
  severity: Severity;
  position_id: number | null;
  pool: string | null;
  token_mint: string | null;
  details: Record<string, unknown>;
  status: "OPEN" | "HANDLED" | "RESOLVED";
  created_at: number;
}

export interface Position {
  id: number;
  address: string;
  pool: string;
  dex: Dex;
  paper: boolean;
  token_mint: string;
  base_mint: string;
  strategy: Strategy;
  lower_bin: number;
  upper_bin: number;
  deposit_x: number;
  deposit_y: number;
  deposit_usd: number;
  entry_price: number;
  model: import("./positions/dlmmModel").DlmmPositionModel | null;
  fees_claimed_usd: number;
  tx_costs_usd: number;
  status: "OPEN" | "CLOSED";
  opened_at: number;
  closed_at: number | null;
  close_pnl_usd: number | null;
  rebalance_count: number;
  last_rebalance_at: number | null;
}

export interface PoolRow {
  address: string;
  dex: Dex;
  mint_x: string;
  mint_y: string;
  bin_step: number | null;
  fee_bps: number | null;
  tvl_usd: number | null;
  volume_24h_usd: number | null;
  fees_24h_usd: number | null;
  fee_apr: number | null;
  price: number | null;
  created_at: number | null;
  first_seen: number;
  last_seen: number;
}

export interface TokenRow {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  program: "spl" | "token2022" | "unknown";
  safety_score: number | null;
  status: "UNCHECKED" | "PASS" | "REJECT";
  flags: string[];
  is_major: boolean;
  first_seen: number;
  last_checked: number | null;
}

/** Injectable clock so tests can control time. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
