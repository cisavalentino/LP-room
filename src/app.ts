import type { Config } from "./config/schema";
import { RpcChainReader } from "./chain/reader";
import type { Store } from "./db/store";
import { PaperExecutor } from "./executor/paperExecutor";
import { logger } from "./lib/log";
import { computePortfolio, seedPaperBalances } from "./portfolio";
import { JupiterPrices, MeteoraPoolState } from "./positions/market";
import { PositionMonitor } from "./positions/monitor";
import { RiskOfficer } from "./risk/officer";
import { Screener } from "./screener/screener";
import { DexScreenerSource } from "./screener/sources/dexscreener";
import { JupiterSource } from "./screener/sources/jupiter";
import { MeteoraDlmmSource } from "./screener/sources/meteora";
import { RugCheckSource } from "./screener/sources/rugcheck";
import type { StatusProvider } from "./telegram/bot";
import { MINUTE } from "./types";

const log = logger("app");

export interface Desk {
  screener: Screener;
  monitor: PositionMonitor;
  risk: RiskOfficer;
  executor: PaperExecutor;
  status: StatusProvider;
}

/** Wires the paper desk against live, read-only data sources. */
export function buildDesk(store: Store, cfg: Config): Desk {
  const t = cfg.app.apis.request_timeout_ms;
  const rpcUrl = process.env[cfg.app.rpc.url_env] ?? cfg.app.rpc.default_url;
  const meteora = new MeteoraDlmmSource(cfg.app.apis.meteora_dlmm, Math.max(t, 60_000));
  const jupiter = new JupiterSource(cfg.app.apis.jupiter, t);
  const prices = new JupiterPrices(jupiter);
  const pools = new MeteoraPoolState(meteora);
  const chain = new RpcChainReader(rpcUrl, cfg.app.rpc.commitment);

  const screener = new Screener(store, cfg, {
    pools: [meteora],
    market: new DexScreenerSource(cfg.app.apis.dexscreener, t),
    jupiter,
    rugcheck: new RugCheckSource(cfg.app.apis.rugcheck, t),
    chain,
  });
  const monitor = new PositionMonitor(store, cfg, { pools, prices });
  const risk = new RiskOfficer(store, cfg, { prices, jupiter, pools });
  const executor = new PaperExecutor(store, cfg, { pools, prices, jupiter });
  seedPaperBalances(store, cfg);

  const status: StatusProvider = {
    async status() {
      const pf = await computePortfolio(store, cfg, prices);
      const pending = store.proposalsInState("PROPOSED", "MANAGER_APPROVED", "RISK_APPROVED", "HUMAN_APPROVED").length;
      return [
        `Mode: ${cfg.app.mode}${store.isPaused() ? " (PAUSED)" : ""}${store.isKillSwitchActive() ? " (KILL SWITCH)" : ""}`,
        `Portfolio: $${pf.valueUsd.toFixed(2)} (free $${pf.freeUsd.toFixed(2)}, deployed $${pf.deployedUsd.toFixed(2)})`,
        `Today: ${pf.dailyPnlPct >= 0 ? "+" : ""}${pf.dailyPnlPct.toFixed(2)}% · drawdown ${pf.drawdownPct.toFixed(2)}%`,
        `Open positions: ${pf.positions.length} · pending proposals: ${pending} · open events: ${store.openEvents().length}`,
      ].join("\n");
    },
    positions() {
      const ps = store.openPositions();
      if (!ps.length) return "No open positions.";
      return ps
        .map((p) => {
          const s = store.latestSnapshot(p.id);
          const sym = store.getToken(p.token_mint)?.symbol || p.token_mint.slice(0, 6);
          return s
            ? `#${p.id} ${sym} ${s.in_range ? "🟢 in range" : "🔴 out of range"} $${s.value_usd.toFixed(2)} fees $${s.fees_total_usd.toFixed(2)} IL ${s.il_pct.toFixed(2)}% PnL ${s.pnl_pct.toFixed(2)}%`
            : `#${p.id} ${sym} $${p.deposit_usd.toFixed(2)} (no snapshot yet)`;
        })
        .join("\n");
    },
  };
  return { screener, monitor, risk, executor, status };
}

/** Runs one task on an interval, never overlapping itself, logging failures. */
export function every(name: string, ms: number, fn: () => Promise<unknown>): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log.error(`${name} failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const h = setInterval(tick, ms);
  return () => {
    stopped = true;
    clearInterval(h);
  };
}

/** Starts all paper-mode loops. Returns a stop function. */
export function startLoops(store: Store, cfg: Config, desk: Desk): () => void {
  const s = cfg.app.schedule;
  desk.executor.recoverStuck();
  const stops = [
    every("screener", s.screener_full_scan_min * MINUTE, () => desk.screener.run()),
    every("recheck-held", s.screener_recheck_held_min * MINUTE, () =>
      desk.screener.recheckTokens([...new Set(store.openPositions().map((p) => p.token_mint))]),
    ),
    every("monitor", s.monitor_interval_min * MINUTE, () => desk.monitor.runOnce()),
    every("risk+executor", s.executor_poll_s * 1000, async () => {
      await desk.risk.processPending();
      await desk.executor.runOnce();
    }),
    every("guards", s.manager_cycle_min * MINUTE, () => desk.risk.guard()),
  ];
  return () => stops.forEach((f) => f());
}
