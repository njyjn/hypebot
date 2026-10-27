import type { Config } from "./config.js";
import { formatReminder, formatSoldOut, formatStatus, formatStockAlert } from "./format.js";
import { HealthTracker, saveHealth, type HealthSummary } from "./health.js";
import { sendAll } from "./notifiers/index.js";
import { saveState, type StockState } from "./state.js";
import { recordAvailability, saveSummary, type SummaryLog } from "./summary.js";
import { cooldownLeftMs, saveSchedule, type Schedule } from "./schedule.js";
import type { Availability, Notifier, Source, StoreStock, WatchItem } from "./types.js";

/** One shop and the items watched there. Each shop fails and backs off on its own. */
export interface Group {
  source: Source;
  items: WatchItem[];
  failures: FailureTracker;
  health?: HealthTracker;
}

export interface Ctx {
  cfg: Config;
  groups: Group[];
  notifiers: Notifier[];
  state: StockState;
  sensors: (items: WatchItem[], now: Availability[]) => Promise<void>;
  now?: () => number; // clock, swappable in tests
  lastAlerted?: Map<string, number>; // item id -> when we last alerted about it (for reminders)
  healthSensor?: (group: Group, summary: HealthSummary) => Promise<void>;
  healthStatePath?: string; // where health survives restarts; unset = memory only
  healthSavedAt?: number;
  summary?: { log: SummaryLog; path: string }; // used in daily_summary mode
  schedule?: { data: Schedule; path: string }; // check times and cool-downs that survive restarts
}

const COOLDOWN_MS = 30 * 60_000; // after Apple's 541 "too many requests"
const BLIND_AFTER_MS = 30 * 60_000; // no successful check for this long -> alert

function saveScheduleNow(ctx: Ctx): void {
  if (!ctx.schedule) return;
  try {
    saveSchedule(ctx.schedule.path, ctx.schedule.data);
  } catch (error) {
    console.error(`Saving schedule failed: ${error instanceof Error ? error.message : error}`);
  }
}

const HEALTH_SAVE_EVERY_MS = 5 * 60_000;

/** Write every shop's health now (also used on shutdown). */
export function saveHealthNow(ctx: Ctx, at = (ctx.now ?? Date.now)()): void {
  if (!ctx.healthStatePath) return;
  const trackers = Object.fromEntries(ctx.groups.filter((g) => g.health).map((g) => [g.source.name, g.health!]));
  try {
    saveHealth(ctx.healthStatePath, trackers);
    ctx.healthSavedAt = at;
  } catch (error) {
    console.error(`Saving health failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** One pass over every shop: check, alert on changes, update sensors, remember the result. */
export async function runCheck(ctx: Ctx): Promise<void> {
  const checkedItems: WatchItem[] = [];
  const now: Availability[] = [];
  const failed = new Set<Group>();

  const sched = ctx.schedule?.data;
  let attempted = false;
  for (const group of ctx.groups) {
    const label = group.source.label;
    const health = (group.health ??= new HealthTracker());
    const clock = (ctx.now ?? Date.now)();
    // Cooling down after a 541: don't ask Apple at all; the shop keeps its last known state.
    if (sched && cooldownLeftMs(sched, group.source.name, clock) > 0) {
      failed.add(group);
      continue;
    }
    attempted = true;
    try {
      now.push(...(await group.source.check(group.items)));
      checkedItems.push(...group.items);
      health.record(true, clock);
    } catch (error) {
      failed.add(group);
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`${label} check failed: ${reason}`);
      health.record(false, clock, reason);
      group.failures.fail(clock);
      if (sched && /\bHTTP 541\b/.test(reason)) {
        (sched.cooldownUntil ??= {})[group.source.name] = clock + COOLDOWN_MS;
        console.warn(`${label} is limiting requests (HTTP 541); pausing checks for 30 minutes.`);
      }
      // Blind = no successful check for 30 minutes, counted from the first failure since the last success
      // (saved, so restarting during a block doesn't restart the count).
      const since = sched ? ((sched.failingSince ??= {})[group.source.name] ??= clock) : (group.failures.failingSince ?? clock);
      const alerted = sched ? sched.blindAlerted?.[group.source.name] === true : group.failures.alerted;
      if (!alerted && clock - since >= BLIND_AFTER_MS) {
        if (sched) (sched.blindAlerted ??= {})[group.source.name] = true;
        group.failures.alerted = true;
        await sendAll(
          ctx.notifiers,
          formatStatus(`⚠️ HypeBot is blind: ${label} has refused every check for 30 minutes`, `Latest error: ${reason}. HypeBot keeps trying and will say when it's back.`),
        );
      }
      await reportHealth(ctx, group, clock);
      continue;
    }
    const wasBlind = sched ? sched.blindAlerted?.[group.source.name] === true : group.failures.alerted;
    group.failures.succeed();
    if (sched?.cooldownUntil) delete sched.cooldownUntil[group.source.name];
    if (sched?.failingSince) delete sched.failingSince[group.source.name];
    if (wasBlind) {
      if (sched?.blindAlerted) delete sched.blindAlerted[group.source.name];
      group.failures.alerted = false;
      await sendAll(ctx.notifiers, formatStatus("✅ HypeBot is back to normal", `Checking ${label} stock again.`));
    }
    await reportHealth(ctx, group, clock);
  }
  // Saved at most every 5 minutes to spare the SD card; a crash loses at most that.
  const clock = (ctx.now ?? Date.now)();
  if (sched && attempted) {
    sched.lastStockCheckAt = clock;
    saveScheduleNow(ctx);
  }
  if (ctx.healthSavedAt === undefined || clock - ctx.healthSavedAt >= HEALTH_SAVE_EVERY_MS) saveHealthNow(ctx, clock);
  if (checkedItems.length === 0) return;

  const changes = diffAvailability(checkedItems, ctx.state, now);
  if (ctx.cfg.notifyMode === "daily_summary") {
    // Stock news waits for the daily message; sensors below still update live.
    if (ctx.summary && recordAvailability(ctx.summary.log, checkedItems, now, clock)) {
      try {
        saveSummary(ctx.summary.path, ctx.summary.log);
      } catch (error) {
        console.error(`Saving summary failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  } else {
    if (changes.newlyInStock.length > 0) await sendAll(ctx.notifiers, formatStockAlert(changes.newlyInStock));
    await sendReminders(ctx, checkedItems, now, changes);
    if (ctx.cfg.notifySoldOut && changes.soldOut.length > 0) await sendAll(ctx.notifiers, formatSoldOut(changes.soldOut));
  }

  await ctx.sensors(checkedItems, now);

  // Shops that failed keep what we last knew; items no longer watched drop out.
  const next: StockState = {};
  for (const group of ctx.groups) {
    for (const item of group.items) {
      const known = failed.has(group) ? ctx.state[item.id] : changes.next[item.id];
      if (known) next[item.id] = known;
    }
  }
  ctx.state = next;
  try {
    saveState(ctx.cfg.statePath, ctx.state);
  } catch (error) {
    console.error(`Saving state failed: ${error instanceof Error ? error.message : error}`);
  }

  const inStock = now.filter((a) => a.stores.length > 0).length;
  console.log(`${new Date().toISOString()} checked ${checkedItems.length} item(s), ${inStock} in stock`);
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
 * Counts consecutive failed checks, so HypeBot backs off instead of keeping a
 * rate-limit block alive by retrying every minute.
 */
export class FailureTracker {
  private count = 0;
  /** When this run of failures started. */
  failingSince?: number;
  /** "HypeBot is blind" sent (used when there is no saved schedule). */
  alerted = false;

  /** Failed checks in a row right now. */
  get inARow(): number {
    return this.count;
  }

  fail(at = Date.now()): void {
    if (this.count === 0) this.failingSince = at;
    this.count++;
  }

  succeed(): void {
    this.count = 0;
    this.failingSince = undefined;
  }

  delayMs(baseMs: number): number {
    if (this.count === 0) return baseMs;
    // Cap the exponent so a long outage cannot overflow.
    const backoff = baseMs * 2 ** Math.min(this.count, 20);
    return Math.max(baseMs, Math.min(backoff, MAX_BACKOFF_MS));
  }
}

/** Re-alert about models still in stock once `remind_every_minutes` has passed since the last alert. */
async function sendReminders(ctx: Ctx, items: WatchItem[], now: Availability[], changes: Changes): Promise<void> {
  const clock = (ctx.now ?? Date.now)();
  const last = (ctx.lastAlerted ??= new Map());
  const remindMs = ctx.cfg.remindEveryMinutes * 60_000;
  const byId = new Map(now.map((a) => [a.itemId, a.stores]));

  for (const { item } of changes.newlyInStock) last.set(item.id, clock);
  const due: Changes["newlyInStock"] = [];
  for (const item of items) {
    const stores = byId.get(item.id) ?? [];
    if (stores.length === 0) {
      last.delete(item.id);
      continue;
    }
    const at = last.get(item.id);
    if (at === undefined) {
      last.set(item.id, clock); // e.g. still in stock from before a restart: start the timer now
    } else if (remindMs > 0 && clock - at >= remindMs) {
      due.push({ item, stores });
    }
  }
  if (due.length === 0) return;
  for (const { item } of due) last.set(item.id, clock);
  await sendAll(ctx.notifiers, formatReminder(due));
}

/** Publish a shop's health and alert when it starts or stops refusing a large share of checks. */
async function reportHealth(ctx: Ctx, group: Group, clock: number): Promise<void> {
  const health = group.health!;
  const summary = health.summary(clock, group.failures.inARow);
  await ctx.healthSensor?.(group, summary);
  const label = group.source.label;
  const change = health.transition(summary);
  if (change === "degraded") {
    const pct = Math.round(summary.failureRate * 100);
    await sendAll(
      ctx.notifiers,
      formatStatus(
        `⚠️ ${label} is refusing some checks`,
        `${pct}% of checks in the last hour failed (${summary.failures} of ${summary.checks}). Latest error: ${summary.lastError ?? "unknown"}. HypeBot is backing off; consider a longer interval_seconds.`,
      ),
    );
  } else if (change === "cleared") {
    await sendAll(ctx.notifiers, formatStatus(`✅ ${label} checks are healthy again`, `Fewer than 30% of checks in the last hour failed.`));
  }
}
