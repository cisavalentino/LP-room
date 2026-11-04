type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export function log(level: Level, component: string, msg: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}`;
  const out = extra ? `${line} ${JSON.stringify(extra)}` : line;
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const logger = (component: string) => ({
  debug: (m: string, e?: Record<string, unknown>) => log("debug", component, m, e),
  info: (m: string, e?: Record<string, unknown>) => log("info", component, m, e),
  warn: (m: string, e?: Record<string, unknown>) => log("warn", component, m, e),
  error: (m: string, e?: Record<string, unknown>) => log("error", component, m, e),
});
