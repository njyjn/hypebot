import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WatchConfig, WatchItem } from "./types.js";

const MAX_AGE_MS = 6 * 60 * 60 * 1000; // same as the regular model-list refresh

/** Resolved models per shop, so a restart doesn't re-read Apple's buy pages (kept in /data/models.json). */
export type ModelCache = Record<string, { entries: WatchConfig[]; items: WatchItem[]; at: number }>;

export function loadModelCache(path: string): ModelCache {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function saveModelCache(path: string, cache: ModelCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(cache));
  renameSync(`${path}.tmp`, path);
}

/** The cached models for a shop, if the settings are unchanged and the list is recent. */
export function pickCachedModels(cache: ModelCache, shop: string, entries: WatchConfig[], now: number): { items: WatchItem[]; at: number } | undefined {
  const hit = cache[shop];
  if (!hit || JSON.stringify(hit.entries) !== JSON.stringify(entries) || now - hit.at > MAX_AGE_MS || !Array.isArray(hit.items)) return undefined;
  return { items: hit.items, at: hit.at };
}
