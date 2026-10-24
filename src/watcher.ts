import type { StockState } from "./state.js";
import type { Availability, StoreStock, WatchItem } from "./types.js";

export interface Changes {
  newlyInStock: { item: WatchItem; stores: StoreStock[] }[];
  soldOut: WatchItem[];
  next: StockState;
}

/** Compare this check with the last one. Only new stores count as news. */
export function diffAvailability(items: WatchItem[], prev: StockState, now: Availability[]): Changes {
  const byId = new Map(now.map((a) => [a.itemId, a.stores]));
  const changes: Changes = { newlyInStock: [], soldOut: [], next: {} };

  for (const item of items) {
    const stores = byId.get(item.id) ?? [];
    const before = new Set(prev[item.id] ?? []);
    const fresh = stores.filter((s) => !before.has(s.name));
    if (fresh.length > 0) changes.newlyInStock.push({ item, stores: fresh });
    if (before.size > 0 && stores.length === 0) changes.soldOut.push(item);
    changes.next[item.id] = stores.map((s) => s.name);
  }
  return changes;
}

const MAX_BACKOFF_MS = 600_000;

/**
 * Counts consecutive failed checks: decides when to raise (and clear) the
 * "can't reach the shop" alert, and how long to back off so a rate-limit
 * block is not kept alive by retrying every minute.
 */
export class FailureTracker {
  private count = 0;
  private alerted = false;

  constructor(private readonly threshold = 10) {}

  fail(): "alert" | null {
    this.count++;
    if (this.count === this.threshold) {
      this.alerted = true;
      return "alert";
    }
    return null;
  }

  succeed(): "recovered" | null {
    this.count = 0;
    if (!this.alerted) return null;
    this.alerted = false;
    return "recovered";
  }

  delayMs(baseMs: number): number {
    if (this.count === 0) return baseMs;
    // Cap the exponent so a long outage cannot overflow.
    const backoff = baseMs * 2 ** Math.min(this.count, 20);
    return Math.max(baseMs, Math.min(backoff, MAX_BACKOFF_MS));
  }
}
