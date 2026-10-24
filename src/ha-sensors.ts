import { HA_API } from "./notifiers/ha.js";
import { postJson } from "./notifiers/post.js";
import type { HealthSummary } from "./health.js";
import type { Availability, DeliveryDate, WatchItem } from "./types.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function sensorId(item: WatchItem): string {
  return `sensor.hypebot_${slug(item.product)}_${slug(item.variantName)}`;
}

/**
 * Writes one sensor per watched item. Sensors set through the API vanish
 * when HA restarts, so this runs after every check to bring them back.
 */
export async function updateSensors(
  items: WatchItem[],
  now: Availability[],
  opts: { token?: string; apiBase?: string; checkedAt: Date },
): Promise<void> {
  if (!opts.token) return;
  const byId = new Map(now.map((a) => [a.itemId, a.stores]));
  for (const item of items) {
    const stores = byId.get(item.id) ?? [];
    try {
      await postJson(
        `${opts.apiBase ?? HA_API}/states/${sensorId(item)}`,
        {
          state: stores.length > 0 ? "in_stock" : "out_of_stock",
          attributes: {
            friendly_name: `HypeBot ${item.productName} ${item.variantName}`,
            icon: "mdi:cellphone",
            stores: stores.map((s) => s.name),
            quote: stores[0]?.quote ?? "",
            part_number: item.partNumber,
            buy_url: item.buyUrl,
            last_checked: opts.checkedAt.toISOString(),
          },
        },
        { Authorization: `Bearer ${opts.token}` },
      );
    } catch (error) {
      console.error(`Updating ${sensorId(item)} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** One health sensor per shop, e.g. sensor.hypebot_apple_sg_health (ok / degraded / blocked). */
export async function updateHealthSensor(
  sourceName: string,
  label: string,
  s: HealthSummary,
  opts: { token?: string; apiBase?: string; waitSeconds: number },
): Promise<void> {
  if (!opts.token) return;
  const id = `sensor.hypebot_${slug(sourceName)}_health`;
  try {
    await postJson(
      `${opts.apiBase ?? HA_API}/states/${id}`,
      {
        state: s.state,
        attributes: {
          friendly_name: `HypeBot ${label} health`,
          icon: "mdi:heart-pulse",
          failure_rate_percent: Math.round(s.failureRate * 100),
          failures_last_hour: s.failures,
          checks_last_hour: s.checks,
          last_error: s.lastError ?? "",
          last_success: s.lastSuccess === undefined ? "" : new Date(s.lastSuccess).toISOString(),
          wait_seconds: opts.waitSeconds,
        },
      },
      { Authorization: `Bearer ${opts.token}` },
    );
  } catch (error) {
    console.error(`Updating ${id} failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** sensor.hypebot_<shop>_delivery: the earliest online delivery date across watched models. */
export async function updateDeliverySensor(
  sourceName: string,
  label: string,
  items: WatchItem[],
  dates: Map<string, DeliveryDate>,
  opts: { token?: string; apiBase?: string },
): Promise<void> {
  if (!opts.token || dates.size === 0) return;
  const known = items.filter((i) => dates.has(i.id));
  const earliest = known.reduce((a, b) => (dates.get(b.id)!.date < dates.get(a.id)!.date ? b : a));
  const id = `sensor.hypebot_${slug(sourceName)}_delivery`;
  try {
    await postJson(
      `${opts.apiBase ?? HA_API}/states/${id}`,
      {
        state: dates.get(earliest.id)!.date,
        attributes: {
          friendly_name: `HypeBot ${label} earliest delivery`,
          icon: "mdi:truck-delivery",
          device_class: "date",
          earliest_model: `${earliest.productName} ${earliest.variantName}`,
          models: Object.fromEntries(known.map((i) => [`${i.productName} ${i.variantName}`, dates.get(i.id)!.date])),
        },
      },
      { Authorization: `Bearer ${opts.token}` },
    );
  } catch (error) {
    console.error(`Updating ${id} failed: ${error instanceof Error ? error.message : error}`);
  }
}
