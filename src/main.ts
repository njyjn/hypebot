import { loadConfig, type Config } from "./config.js";
import { formatStatus } from "./format.js";
import { runDeliveryCheck } from "./delivery.js";
import { updateDeliverySensor, updateHealthSensor, updateSensors } from "./ha-sensors.js";
import { buildNotifiers, sendAll } from "./notifiers/index.js";
import { createAppleSg } from "./sources/apple-sg.js";
import { loadState } from "./state.js";
import type { Source, WatchConfig, WatchItem } from "./types.js";
import { loadHealth } from "./health.js";
import { FailureTracker, runCheck, saveHealthNow, type Ctx, type Group } from "./watcher.js";

const RESOLVE_EVERY_MS = 6 * 60 * 60 * 1000;
const RESOLVE_RETRY_MS = 10 * 60 * 1000;
const JITTER_MS = 10_000;
const DELIVERY_EVERY_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every shop HypeBot can watch, keyed by the `source` value in the settings. */
const SOURCES: Record<string, (cfg: Config) => Source> = {
  apple_sg: (cfg) => createAppleSg({ stores: cfg.appleSgStores, buyLinkBase: cfg.buyLinkBase }),
};

/** Resolve one shop's entries, retrying until its product pages can be read. */
async function resolveWithRetry(source: Source, entries: WatchConfig[], once: boolean, onFirstFailure: (e: unknown) => Promise<void>): Promise<WatchItem[] | undefined> {
  let alerted = false;
  for (;;) {
    try {
      return await source.resolve(entries);
    } catch (error) {
      console.error(`Could not resolve watched ${source.label} models: ${message(error)}`);
      if (once) return undefined;
      if (!alerted) {
        await onFirstFailure(error);
        alerted = true;
      }
      await sleep(RESOLVE_RETRY_MS);
    }
  }
}
async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = loadConfig();
  cfg.warnings.forEach((w) => console.warn(`Warning: ${w}`));

  const notifiers = buildNotifiers(cfg);
  console.log(`HypeBot starting. Alerts: ${notifiers.map((n) => n.name).join(", ") || "none"}. Interval: ${cfg.intervalSeconds}s.`);

  if (args.has("--test-notify") || cfg.sendTestAlert) {
    // Urgent like a stock alert, so it shows how loud a real one will be.
    await sendAll(notifiers, { ...formatStatus("HypeBot test alert", "Alerts are working."), urgent: true });
    console.log(`Test alert sent to: ${notifiers.map((n) => n.name).join(", ") || "nobody (no destinations configured)"}`);
    if (args.has("--test-notify")) return;
  }

  if (cfg.watch.length === 0) {
    console.error("Nothing to watch: pick at least one model under `models` (or add a `watch` entry) in the settings.");
    process.exitCode = 1;
    return;
  }

  const unknown = [...new Set(cfg.watch.map((w) => w.source))].filter((name) => !SOURCES[name]);
  if (unknown.length > 0) {
    console.error(`Unknown source(s) in watch: ${unknown.join(", ")}. Known: ${Object.keys(SOURCES).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Resolve names to part numbers, one group per shop.
  const groups: Group[] = [];
  const savedHealth = loadHealth(cfg.healthStatePath);
  for (const name of new Set(cfg.watch.map((w) => w.source))) {
    const source = SOURCES[name](cfg);
    const entries = cfg.watch.filter((w) => w.source === name);
    const items = await resolveWithRetry(source, entries, args.has("--once"), (error) =>
      sendAll(notifiers, formatStatus("⚠️ HypeBot can't find your models", message(error))),
    );
    if (!items) {
      process.exitCode = 1;
      return;
    }
    console.log(`Watching at ${source.label}: ${items.map((i) => `${i.productName} ${i.variantName} (${i.partNumber})`).join("; ")}`);
    groups.push({ source, items, failures: new FailureTracker(), health: savedHealth[source.name] });
  }
  let resolvedAt = Date.now();

  if (args.has("--once")) {
    for (const { source, items } of groups) {
      const now = await source.check(items);
      for (const item of items) {
        const stores = now.find((a) => a.itemId === item.id)?.stores ?? [];
        console.log(`${`${item.productName} ${item.variantName}`.padEnd(32)} ${stores.length ? stores.map((s) => `${s.name} (${s.quote})`).join(", ") : "unavailable"}`);
      }
      if (cfg.trackDeliveryDates && source.deliveryDates) {
        const dates = await source.deliveryDates(items);
        for (const item of items) console.log(`${`${item.productName} ${item.variantName}`.padEnd(32)} delivers ${dates.get(item.id)?.label ?? "no date"}`);
      }
    }
    return;
  }

  const ctx: Ctx = {
    cfg,
    groups,
    notifiers,
    state: loadState(cfg.statePath),
    healthStatePath: cfg.healthStatePath,
    sensors: (its, now) => updateSensors(its, now, { token: process.env.SUPERVISOR_TOKEN, checkedAt: new Date() }),
    healthSensor: (g, s) =>
      updateHealthSensor(g.source.name, g.source.label, s, {
        token: process.env.SUPERVISOR_TOKEN,
        waitSeconds: Math.round(g.failures.delayMs(cfg.intervalSeconds * 1000) / 1000),
      }),
  };

  onExit = () => saveHealthNow(ctx);

  let deliveryCheckedAt = 0;
  for (;;) {
    if (cfg.trackDeliveryDates && Date.now() - deliveryCheckedAt >= DELIVERY_EVERY_MS) {
      await runDeliveryCheck({
        groups: ctx.groups,
        notifiers,
        statePath: cfg.deliveryStatePath,
        sensor: (source, items, dates) => updateDeliverySensor(source.name, source.label, items, dates, { token: process.env.SUPERVISOR_TOKEN }),
      });
      deliveryCheckedAt = Date.now();
    }
    if (Date.now() - resolvedAt > RESOLVE_EVERY_MS) {
      for (const group of ctx.groups) {
        try {
          group.items = await group.source.resolve(cfg.watch.filter((w) => w.source === group.source.name));
        } catch (error) {
          console.warn(`Re-checking ${group.source.label} model list failed, keeping the current one: ${message(error)}`);
        }
      }
      resolvedAt = Date.now();
    }
    await runCheck(ctx);
    // Back off when any shop is failing; one shared loop keeps requests spread out.
    const delay = Math.max(...ctx.groups.map((g) => g.failures.delayMs(cfg.intervalSeconds * 1000)));
    await sleep(delay + Math.random() * JITTER_MS);
  }
}

// Set once the watch loop starts, so stopping the add-on keeps the latest health counts.
let onExit = () => {};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    onExit();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`HypeBot stopped: ${message(error)}`);
  process.exit(1);
});
