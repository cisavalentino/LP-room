import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import {
  AppConfigSchema,
  KnownAssetsSchema,
  RiskConfigSchema,
  ScreenerConfigSchema,
  type Config,
} from "./schema";

function loadYaml<T extends z.ZodType>(file: string, schema: T): z.infer<T> {
  const raw = parse(readFileSync(file, "utf8"));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config ${file}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(dir = process.env.LP_ROOM_CONFIG_DIR ?? "config"): Config {
  const base = resolve(dir);
  return {
    app: loadYaml(join(base, "app.yaml"), AppConfigSchema),
    risk: loadYaml(join(base, "risk.yaml"), RiskConfigSchema),
    screener: loadYaml(join(base, "screener.yaml"), ScreenerConfigSchema),
    knownAssets: loadYaml(join(base, "known-assets.yaml"), KnownAssetsSchema),
  };
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_MINTS = new Set([SOL_MINT, USDC_MINT]);
