import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sendAll } from "./notifiers/index.js";
import type { AlertMessage, DeliveryDate, Notifier, Source, WatchItem } from "./types.js";

/** Item id -> last delivery date seen. */
export type DeliveryState = Record<string, DeliveryDate>;

export interface DeliveryChange {
  item: WatchItem;
  from: DeliveryDate;
  to: DeliveryDate;
}

export function loadDeliveryState(path: string): DeliveryState {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveDeliveryState(path: string, state: DeliveryState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
}

/** Models whose promised date is earlier than the last one seen. */
export function diffDelivery(items: WatchItem[], prev: DeliveryState, now: Map<string, DeliveryDate>): DeliveryChange[] {
  return items.flatMap((item) => {
    const from = prev[item.id];
    const to = now.get(item.id);
    return from && to && to.date < from.date ? [{ item, from, to }] : [];
  });
}

export function formatDeliveryAlert(changes: DeliveryChange[]): AlertMessage {
  const items = changes.map((c) => c.item);
  const oneProduct = new Set(items.map((i) => i.product)).size === 1;
  const shops = new Set(items.map((i) => i.shop));
  const shop = shops.size === 1 ? ` (${items[0].shop})` : "";
  return {
    title: oneProduct ? `📦 ${items[0].productName} delivery moved earlier${shop}` : `📦 Delivery dates moved earlier${shop}`,
    lines: changes.map((c) => `${oneProduct ? "" : `${c.item.productName} `}${c.item.variantName}: ${c.to.label} (was ${c.from.label})`),
    kind: "delivery",
    ...(changes.length === 1 ? { url: changes[0].item.buyUrl } : {}),
  };
}

export interface DeliveryCtx {
  groups: { source: Source; items: WatchItem[] }[];
  notifiers: Notifier[];
  statePath: string;
  sensor?: (source: Source, items: WatchItem[], dates: Map<string, DeliveryDate>) => Promise<void>;
  /** daily_summary mode: receives earlier dates instead of an alert being sent. */
  onEarlier?: (changes: DeliveryChange[]) => void;
}

/** Check online delivery dates for every shop that offers them; alert when one moves earlier. */
export async function runDeliveryCheck(ctx: DeliveryCtx): Promise<void> {
  const state = loadDeliveryState(ctx.statePath);
  let changed = false;
  for (const { source, items } of ctx.groups) {
    if (!source.deliveryDates) continue;
    let dates: Map<string, DeliveryDate>;
    try {
      dates = await source.deliveryDates(items);
    } catch (error) {
      console.warn(`${source.label} delivery date check failed: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const earlier = diffDelivery(items, state, dates);
    if (earlier.length > 0) {
      if (ctx.onEarlier) ctx.onEarlier(earlier);
      else await sendAll(ctx.notifiers, formatDeliveryAlert(earlier));
    }
    for (const [id, d] of dates) state[id] = d;
    changed = true;
    await ctx.sensor?.(source, items, dates);
    const summary = items.map((i) => `${i.variantName}: ${dates.get(i.id)?.label ?? "no date"}`).join("; ");
    console.log(`${source.label} delivery dates: ${summary}`);
  }
  if (changed) saveDeliveryState(ctx.statePath, state);
}
