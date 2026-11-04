import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA_VERSION = 1;
const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export type Row = Record<string, unknown>;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

/** Thin wrapper around node:sqlite. SQLite is used for paper mode (PRD §1). */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  migrate(): void {
    this.raw.exec(readFileSync(schemaPath, "utf8"));
    const row = this.get<{ version: number }>("SELECT version FROM schema_version LIMIT 1");
    if (!row) this.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.raw.prepare(sql);
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  /** Runs fn inside a transaction (nested calls reuse the outer one). */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  const db = new Db(path);
  db.migrate();
  return db;
}

export const json = {
  parse<T>(s: unknown, fallback: T): T {
    if (typeof s !== "string" || s === "") return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
  str(v: unknown): string {
    return JSON.stringify(v ?? null);
  },
};
