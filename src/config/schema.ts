import { z } from "zod";

export const AppConfigSchema = z.object({
  // This build only supports paper mode. approval/auto are deliberately not accepted.
  mode: z.literal("paper"),
  database: z.object({ path: z.string() }),
  rpc: z.object({
    url_env: z.string(),
    default_url: z.string().url(),
    commitment: z.enum(["processed", "confirmed", "finalized"]),
  }),
  apis: z.object({
    meteora_dlmm: z.string().url(),
    dexscreener: z.string().url(),
    jupiter: z.string().url(),
    rugcheck: z.string().url(),
    request_timeout_ms: z.number().int().positive(),
  }),
  telegram: z.object({
    token_env: z.string(),
    chat_id_env: z.string(),
    poll_timeout_s: z.number().int().positive(),
  }),
  schedule: z.object({
    screener_full_scan_min: z.number().positive(),
    screener_recheck_held_min: z.number().positive(),
    monitor_interval_min: z.number().positive(),
    manager_cycle_min: z.number().positive(),
    executor_poll_s: z.number().positive(),
  }),
  paper: z.object({
    starting_balances: z.record(z.string(), z.number().nonnegative()),
  }),
});

export const RiskConfigSchema = z.object({
  portfolio: z.object({
    max_position_pct: z.number().positive().max(100),
    max_open_positions: z.number().int().positive(),
    max_token_exposure_pct: z.number().positive().max(100),
    max_non_major_pct: z.number().positive().max(100),
    sol_reserve: z.number().nonnegative(),
    daily_loss_limit_pct: z.number().positive(),
    kill_switch_drawdown_pct: z.number().positive(),
  }),
  trade: z.object({
    max_slippage_bps_major: z.number().int().nonnegative(),
    max_slippage_bps_other: z.number().int().nonnegative(),
    max_priority_fee_lamports: z.number().int().nonnegative(),
    max_price_impact_pct: z.number().nonnegative(),
    screened_within_hours: z.number().positive(),
    reentry_cooldown_hours: z.number().nonnegative(),
    min_position_usd: z.number().nonnegative(),
  }),
  rebalance: z.object({
    max_per_position_per_day: z.number().int().nonnegative(),
    cooldown_min: z.number().nonnegative(),
  }),
  modes: z.object({
    auto_max_size_usd: z.number().nonnegative(),
    human_approval_ttl_min: z.number().positive(),
  }),
  executor: z.object({
    proposal_ttl_min: z.number().positive(),
    price_tolerance_pct: z.number().positive(),
    balance_tolerance_pct: z.number().positive(),
    max_retries: z.number().int().nonnegative(),
  }),
  program_allowlist: z.array(z.string()).min(1),
});

export const ScreenerConfigSchema = z.object({
  hard_filters: z.object({
    min_tvl: z.number().nonnegative(),
    min_volume_24h: z.number().nonnegative(),
    min_pool_age_hours: z.number().nonnegative(),
    min_token_age_days: z.number().nonnegative(),
    min_txns_24h: z.number().nonnegative(),
    min_unique_traders_24h: z.number().nonnegative(),
  }),
  safety: z.object({
    max_transfer_fee_bps: z.number().nonnegative(),
    max_top10_pct: z.number().positive(),
    max_single_holder_pct: z.number().positive(),
    max_insider_cluster_pct: z.number().positive(),
    honeypot_test_usd: z.number().positive(),
    max_roundtrip_loss_pct: z.number().nonnegative(),
    rugcheck_danger_score: z.number().nonnegative(),
    allowed_transfer_hook_programs: z.array(z.string()),
  }),
  pool_quality: z.object({
    max_volume_tvl_ratio: z.number().positive(),
    min_unique_trader_txn_ratio: z.number().nonnegative(),
    max_tvl_drop_24h_pct: z.number().positive(),
  }),
  score: z.object({
    weights: z.object({
      fee_apr_adj: z.number(),
      volume_quality: z.number(),
      liquidity_depth: z.number(),
      token_safety: z.number(),
      age: z.number(),
      volatility_penalty: z.number(),
    }),
    fee_apr_cap: z.number().positive(),
    tvl_full_credit: z.number().positive(),
    age_full_credit_days: z.number().positive(),
    keep_top: z.number().int().positive(),
  }),
  metadata_red_flags: z.array(z.string()),
});

export const KnownAssetSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  mint: z.string(),
  base: z.boolean().optional(),
});
export const KnownAssetsSchema = z.array(KnownAssetSchema);

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type ScreenerConfig = z.infer<typeof ScreenerConfigSchema>;
export type KnownAsset = z.infer<typeof KnownAssetSchema>;

export interface Config {
  app: AppConfig;
  risk: RiskConfig;
  screener: ScreenerConfig;
  knownAssets: KnownAsset[];
}
