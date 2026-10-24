import { loadConfig } from "./config.js";
import { formatStatus } from "./format.js";
import { updateSensors } from "./ha-sensors.js";
import { buildNotifiers, sendAll } from "./notifiers/index.js";
import { createAppleSg } from "./sources/apple-sg.js";
import { loadState } from "./state.js";
import type { WatchItem } from "./types.js";
import { FailureTracker, runCheck, type Ctx } from "./watcher.js";

const RESOLVE_EVERY_MS = 6 * 60 * 60 * 1000;
const RESOLVE_RETRY_MS = 10 * 60 * 1000;
const JITTER_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = loadConfig();
  cfg.warnings.forEach((w) => console.warn(`Warning: ${w}`));

  const source = createAppleSg({ stores: cfg.appleSgStores });
  const notifiers = buildNotifiers(cfg);
  console.log(`HypeBot starting. Alerts: ${notifiers.map((n) => n.name).join(", ") || "none"}. Interval: ${cfg.intervalSeconds}s.`);

  if (args.has("--test-notify") || cfg.sendTestAlert) {
    await sendAll(notifiers, formatStatus("HypeBot test alert", "Alerts are working."));
    console.log(`Test alert sent to: ${notifiers.map((n) => n.name).join(", ") || "nobody (no destinations configured)"}`);
    if (args.has("--test-notify")) return;
  }

  if (cfg.watch.length === 0) {
    console.error("Nothing to watch: add at least one entry under `watch` in the settings.");
    process.exitCode = 1;
    return;
  }

  // Resolve names to part numbers, retrying until Apple's page can be read.
  let items: WatchItem[] = [];
  let alertedResolve = false;
  for (;;) {
    try {
      items = await source.resolve(cfg.watch);
      break;
    } catch (error) {
      console.error(`Could not resolve watched models: ${message(error)}`);
      if (args.has("--once")) {
        process.exitCode = 1;
        return;
      }
      if (!alertedResolve) {
        await sendAll(notifiers, formatStatus("⚠️ HypeBot can't find your models", message(error)));
        alertedResolve = true;
      }
      await sleep(RESOLVE_RETRY_MS);
    }
  }
  let resolvedAt = Date.now();
  console.log(`Watching: ${items.map((i) => `${i.productName} ${i.variantName} (${i.partNumber})`).join("; ")}`);

  if (args.has("--once")) {
    const now = await source.check(items);
    for (const item of items) {
      const stores = now.find((a) => a.itemId === item.id)?.stores ?? [];
      console.log(`${`${item.productName} ${item.variantName}`.padEnd(32)} ${stores.length ? stores.map((s) => `${s.name} (${s.quote})`).join(", ") : "unavailable"}`);
    }
    return;
  }

  const ctx: Ctx = {
    cfg,
    source,
    items,
    notifiers,
    failures: new FailureTracker(),
    state: loadState(cfg.statePath),
    sensors: (its, now) => updateSensors(its, now, { token: process.env.SUPERVISOR_TOKEN, checkedAt: new Date() }),
  };

  for (;;) {
    if (Date.now() - resolvedAt > RESOLVE_EVERY_MS) {
      try {
        ctx.items = await source.resolve(cfg.watch);
      } catch (error) {
        console.warn(`Re-checking model list failed, keeping the current one: ${message(error)}`);
      }
      resolvedAt = Date.now();
    }
    await runCheck(ctx);
    await sleep(ctx.failures.delayMs(cfg.intervalSeconds * 1000) + Math.random() * JITTER_MS);
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((error) => {
  console.error(`HypeBot stopped: ${message(error)}`);
  process.exit(1);
});
