import { openDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { loadConfig } from "../src/config/load";

export function testClock(start = Date.UTC(2026, 0, 10, 12, 0, 0)) {
  let t = start;
  const clock = () => t;
  return Object.assign(clock, {
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  });
}

export function makeStore(clock = testClock()) {
  const db = openDb(":memory:");
  return { store: new Store(db, clock), clock, db };
}

export const config = () => loadConfig("config");
