import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MoodState } from "./types.js";

const HOUR = 3_600_000;
const KEEP_BATCHES_MS = 48 * HOUR;
const KEEP_SEEN_MS = 7 * 24 * HOUR;

export const emptyMood = (): MoodState => ({ batches: [], seen: {}, failuresInARow: 0, alerted: false });

export function loadMood(path: string): MoodState {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<MoodState>;
    return {
      ...emptyMood(),
      ...data,
      batches: Array.isArray(data.batches) ? data.batches : [],
      seen: data.seen && typeof data.seen === "object" ? data.seen : {},
    };
  } catch {
    return emptyMood();
  }
}

export function saveMood(path: string, s: MoodState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(s));
  renameSync(`${path}.tmp`, path);
}

export function prune(s: MoodState, now: number): void {
  s.batches = s.batches.filter((b) => now - b.at <= KEEP_BATCHES_MS);
  s.seen = Object.fromEntries(Object.entries(s.seen).filter(([, at]) => now - at <= KEEP_SEEN_MS));
}

/** Item-weighted mood of the 24 hours before `now`; undefined when nothing was analysed. */
export function score24h(s: MoodState, now: number): { score: number; items: number } | undefined {
  const recent = s.batches.filter((b) => b.at <= now && now - b.at <= 24 * HOUR && b.items > 0);
  const items = recent.reduce((n, b) => n + b.items, 0);
  if (items === 0) return undefined;
  const score = recent.reduce((sum, b) => sum + b.score * b.items, 0) / items;
  return { score: Math.round(score * 100) / 100, items };
}

export function moodLabel(score: number): "negative" | "mixed" | "positive" {
  return score < -0.2 ? "negative" : score > 0.2 ? "positive" : "mixed";
}
