import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeliveryChange } from "./delivery.js";
import type { Availability, WatchItem } from "./types.js";

/** A model available at one store, from when it appeared until it sold out. */
export interface DropEvent {
  itemId: string;
  label: string; // "Star White 512GB"
  store: string;
  start: number;
  end?: number; // unset while still in stock
}

export interface DeliveryEvent {
  label: string;
  from: string; // Apple's wording, e.g. "Mon 25/01/2027"
  to: string;
  at: number;
}

/** What happened since the last daily message (kept in /data/summary.json). */
export interface SummaryLog {
  drops: DropEvent[];
  delivery: DeliveryEvent[];
  lastSentDate?: string; // local YYYY-MM-DD of the last daily message
}

const MAX_DROPS_LISTED = 20;

export const emptySummary = (): SummaryLog => ({ drops: [], delivery: [] });

export function loadSummary(path: string): SummaryLog {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<SummaryLog>;
    if (!data || typeof data !== "object" || Array.isArray(data)) return emptySummary();
    return {
      ...data,
      drops: Array.isArray(data.drops) ? data.drops : [],
      delivery: Array.isArray(data.delivery) ? data.delivery : [],
    };
  } catch {
    return emptySummary();
  }
}

export function saveSummary(path: string, log: SummaryLog): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(log));
  renameSync(`${path}.tmp`, path);
}

/** Open a drop for each new store, close drops whose store sold out. Returns whether anything changed. */
export function recordAvailability(log: SummaryLog, items: WatchItem[], now: Availability[], at: number): boolean {
  const byId = new Map(now.map((a) => [a.itemId, new Set(a.stores.map((s) => s.name))]));
  let changed = false;
  for (const item of items) {
    const stores = byId.get(item.id) ?? new Set<string>();
    const open = log.drops.filter((d) => d.itemId === item.id && d.end === undefined);
    for (const d of open) {
      if (!stores.has(d.store)) {
        d.end = at;
        changed = true;
      }
    }
    for (const store of stores) {
      if (!open.some((d) => d.store === store)) {
        log.drops.push({ itemId: item.id, label: item.variantName, store, start: at });
        changed = true;
      }
    }
  }
  return changed;
}

export function recordDeliveryChanges(log: SummaryLog, changes: DeliveryChange[], at: number): void {
  for (const c of changes) log.delivery.push({ label: c.item.variantName, from: c.from.label, to: c.to.label, at });
}

function localParts(t: number, timeZone?: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
}

function duration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins < 60 ? `~${mins} min` : `~${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
}

/** The stock and delivery part of the daily message. */
export function formatSummary(log: SummaryLog, now: number, timeZone?: string): string[] {
  const n = log.drops.length;
  const lines = [n === 0 ? "Stock: no drops today" : `Stock: ${n} drop${n === 1 ? "" : "s"}`];
  const today = localParts(now, timeZone);
  for (const d of log.drops.slice(0, MAX_DROPS_LISTED)) {
    const p = localParts(d.start, timeZone);
    const day = p.day === today.day && p.month === today.month && p.year === today.year ? "" : `${p.day} ${p.month} `;
    const lasted = d.end === undefined ? "still in stock" : duration(d.end - d.start);
    lines.push(`• ${day}${p.hour}:${p.minute} ${d.label}, ${d.store} (${lasted})`);
  }
  if (n > MAX_DROPS_LISTED) lines.push(`…and ${n - MAX_DROPS_LISTED} more`);
  for (const e of log.delivery) lines.push(`Delivery: ${e.label} now ${e.to} (was ${e.from})`);
  return lines;
}

/** After a daily message: forget what was reported, keep drops still in stock. */
export function clearReported(log: SummaryLog): void {
  log.drops = log.drops.filter((d) => d.end === undefined);
  log.delivery = [];
}
