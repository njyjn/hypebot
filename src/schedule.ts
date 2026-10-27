import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Timing that must survive restarts, so restarting never adds requests to Apple (kept in /data/schedule.json). */
export interface Schedule {
  lastStockCheckAt?: number;
  deliveryCheckedAt?: number;
  cooldownUntil?: Record<string, number>; // shop name -> no checks before this time
  blindAlerted?: Record<string, boolean>; // shop name -> "HypeBot is blind" already sent
  failingSince?: Record<string, number>; // shop name -> first failure since the last success
}

export function loadSchedule(path: string): Schedule {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function saveSchedule(path: string, s: Schedule): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(s));
  renameSync(`${path}.tmp`, path);
}

export function cooldownLeftMs(s: Schedule, shop: string, now: number): number {
  return Math.max(0, (s.cooldownUntil?.[shop] ?? 0) - now);
}

/** How long to wait before the first stock check after starting. */
export function firstCheckDelayMs(s: Schedule, now: number, intervalMs: number): number {
  const sinceLast = s.lastStockCheckAt === undefined ? 0 : Math.max(0, s.lastStockCheckAt + intervalMs - now);
  const cooling = Math.max(0, ...Object.values(s.cooldownUntil ?? {}).map((t) => t - now));
  return Math.max(sinceLast, cooling);
}
