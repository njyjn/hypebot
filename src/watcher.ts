import type { Config } from "./config.js";
import { formatSoldOut, formatStatus, formatStockAlert } from "./format.js";
import { sendAll } from "./notifiers/index.js";
import { saveState, type StockState } from "./state.js";
import type { Availability, Notifier, Source, StoreStock, WatchItem } from "./types.js";

export interface Ctx {
  cfg: Config;
  source: Source;
  items: WatchItem[];
  notifiers: Notifier[];
  failures: FailureTracker;
  state: StockState;
  sensors: (items: WatchItem[], now: Availability[]) => Promise<void>;
}

const SHOP_LABEL = "Apple SG";

/** One pass: check, alert on changes, update sensors, remember the result. */
export async function runCheck(ctx: Ctx): Promise<void> {
  let now: Availability[];
  try {
    now = await ctx.source.check(ctx.items);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Check failed: ${reason}`);
    if (ctx.failures.fail() === "alert") {
      await sendAll(ctx.notifiers, formatStatus(`⚠️ HypeBot can't reach ${SHOP_LABEL}`, `Last 10 checks failed. Latest error: ${reason}`));
    }
    return;
  }

  if (ctx.failures.succeed() === "recovered") {
    await sendAll(ctx.notifiers, formatStatus("✅ HypeBot is back to normal", `Checking ${SHOP_LABEL} stock again.`));
  }

  const changes = diffAvailability(ctx.items, ctx.state, now);
  if (changes.newlyInStock.length > 0) await sendAll(ctx.notifiers, formatStockAlert(changes.newlyInStock));
  if (ctx.cfg.notifySoldOut && changes.soldOut.length > 0) await sendAll(ctx.notifiers, formatSoldOut(changes.soldOut));

  await ctx.sensors(ctx.items, now);
  ctx.state = changes.next;
  try {
    saveState(ctx.cfg.statePath, ctx.state);
  } catch (error) {
    console.error(`Saving state failed: ${error instanceof Error ? error.message : error}`);
  }

  const inStock = now.filter((a) => a.stores.length > 0).length;
  console.log(`${new Date().toISOString()} checked ${ctx.items.length} item(s), ${inStock} in stock`);
}

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
