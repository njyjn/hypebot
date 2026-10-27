import { loadConfig, type Config } from "./config.js";
import { formatStatus } from "./format.js";
import { runDeliveryCheck } from "./delivery.js";
import { updateDeliverySensor, updateHealthSensor, updateMoodSensor, updateSensors } from "./ha-sensors.js";
import { buildNotifiers, sendAll } from "./notifiers/index.js";
import { createAppleSg } from "./sources/apple-sg.js";
import { loadState } from "./state.js";
import type { Source, WatchConfig, WatchItem } from "./types.js";
import { loadHealth } from "./health.js";
import { setProxy } from "./http.js";
import { loadModelCache, pickCachedModels, saveModelCache } from "./model-cache.js";
import { cooldownLeftMs, firstCheckDelayMs, loadSchedule, saveSchedule } from "./schedule.js";
import { callAiTask } from "./mood/analyse.js";
import { startMood, type MoodCtx } from "./mood/index.js";
import { startDaily } from "./daily.js";
import { loadSummary, recordDeliveryChanges, saveSummary } from "./summary.js";
import { startMoodWhenReady, type ReadyCheck } from "./mood/startup.js";
import { collect } from "./mood/sources.js";
import { HA_API } from "./notifiers/ha.js";
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
    // --test-notify checks every destination; the startup test alert follows the routing.
    await sendAll(notifiers, { ...formatStatus("HypeBot test alert", "Alerts are working."), urgent: true, kind: "test" }, { everywhere: args.has("--test-notify") });
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

  setProxy(cfg.proxyUrl);
  if (cfg.proxyUrl) console.log(`Apple requests go through proxy ${cfg.proxyUrl}`);

  // Resolve names to part numbers, one group per shop.
  const groups: Group[] = [];
  const savedHealth = loadHealth(cfg.healthStatePath);
  const modelCache = loadModelCache(cfg.modelCachePath);
  let resolvedAt = Date.now();
  for (const name of new Set(cfg.watch.map((w) => w.source))) {
    const source = SOURCES[name](cfg);
    const entries = cfg.watch.filter((w) => w.source === name);
    // A restart reuses the model list from the last few hours instead of re-reading Apple's buy page.
    const cached = args.has("--once") ? undefined : pickCachedModels(modelCache, name, entries, Date.now());
    const items =
      cached?.items ??
      (await resolveWithRetry(source, entries, args.has("--once"), (error) =>
        sendAll(notifiers, formatStatus("⚠️ HypeBot can't find your models", message(error))),
      ));
    if (!items) {
      process.exitCode = 1;
      return;
    }
    if (cached) resolvedAt = Math.min(resolvedAt, cached.at);
    else modelCache[name] = { entries, items, at: Date.now() };
    console.log(`Watching at ${source.label}${cached ? " (saved model list)" : ""}: ${items.map((i) => `${i.productName} ${i.variantName} (${i.partNumber})`).join("; ")}`);
    groups.push({ source, items, failures: new FailureTracker(), health: savedHealth[source.name] });
  }
  const saveModels = () => {
    try {
      saveModelCache(cfg.modelCachePath, modelCache);
    } catch (error) {
      console.error(`Saving model list failed: ${message(error)}`);
    }
  };
  saveModels();

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

  const schedule = { data: loadSchedule(cfg.schedulePath), path: cfg.schedulePath };
  const intervalMs = cfg.intervalSeconds * 1000;
  // Time until a shop may be asked again: the backoff after failures, or a 541 cool-down.
  const waitMs = (g: Group) => Math.max(g.failures.delayMs(intervalMs), cooldownLeftMs(schedule.data, g.source.name, Date.now()));
  const ctx: Ctx = {
    cfg,
    groups,
    notifiers,
    state: loadState(cfg.statePath),
    healthStatePath: cfg.healthStatePath,
    schedule,
    sensors: (its, now) => updateSensors(its, now, { token: process.env.SUPERVISOR_TOKEN, checkedAt: new Date() }),
    healthSensor: (g, s) =>
      updateHealthSensor(g.source.name, g.source.label, s, {
        token: process.env.SUPERVISOR_TOKEN,
        waitSeconds: Math.round(waitMs(g) / 1000),
        coolingDownUntil: schedule.data.cooldownUntil?.[g.source.name],
      }),
  };

  onExit = () => saveHealthNow(ctx);
  const summaryMode = cfg.notifyMode === "daily_summary";
  let mood: ReturnType<typeof startMood> & { ctx: MoodCtx } | undefined;
  if (cfg.mood.enabled) startMoodInBackground(cfg, notifiers, summaryMode, (m) => (mood = m));
  if (summaryMode) {
    ctx.summary = { log: loadSummary(cfg.summaryStatePath), path: cfg.summaryStatePath };
    startDaily({ time: cfg.mood.digestTime, notifiers, summary: ctx.summary, mood: () => mood });
    console.log(`Notifications: daily summary at ${cfg.mood.digestTime}; problems are still sent straight away.`);
  }

  // A quick restart waits out the rest of the interval (and any cool-down) instead of asking Apple again at once.
  const firstWait = firstCheckDelayMs(schedule.data, Date.now(), intervalMs);
  if (firstWait > 0) {
    console.log(`First stock check in ${Math.round(firstWait / 1000)}s (last check was recent, or Apple asked HypeBot to slow down).`);
    await sleep(firstWait);
  }

  for (;;) {
    if (cfg.trackDeliveryDates && Date.now() - (schedule.data.deliveryCheckedAt ?? 0) >= DELIVERY_EVERY_MS) {
      await runDeliveryCheck({
        groups: ctx.groups,
        notifiers,
        statePath: cfg.deliveryStatePath,
        skip: (source) => cooldownLeftMs(schedule.data, source.name, Date.now()) > 0,
        sensor: (source, items, dates) => updateDeliverySensor(source.name, source.label, items, dates, { token: process.env.SUPERVISOR_TOKEN }),
        ...(ctx.summary
          ? {
              onEarlier: (changes) => {
                recordDeliveryChanges(ctx.summary!.log, changes, Date.now());
                try {
                  saveSummary(ctx.summary!.path, ctx.summary!.log);
                } catch (error) {
                  console.error(`Saving summary failed: ${message(error)}`);
                }
              },
            }
          : {}),
      });
      schedule.data.deliveryCheckedAt = Date.now();
      try {
        saveSchedule(schedule.path, schedule.data);
      } catch (error) {
        console.error(`Saving schedule failed: ${message(error)}`);
      }
    }
    if (Date.now() - resolvedAt > RESOLVE_EVERY_MS) {
      for (const group of ctx.groups) {
        try {
          const entries = cfg.watch.filter((w) => w.source === group.source.name);
          group.items = await group.source.resolve(entries);
          modelCache[group.source.name] = { entries, items: group.items, at: Date.now() };
          saveModels();
        } catch (error) {
          console.warn(`Re-checking ${group.source.label} model list failed, keeping the current one: ${message(error)}`);
        }
      }
      resolvedAt = Date.now();
    }
    await runCheck(ctx);
    // Back off when any shop is failing; one shared loop keeps requests spread out.
    // Shops cooling down are skipped by runCheck; if all are, wait for the first to be ready.
    const active = ctx.groups.filter((g) => cooldownLeftMs(schedule.data, g.source.name, Date.now()) === 0);
    const delay = active.length > 0 ? Math.max(...active.map((g) => g.failures.delayMs(intervalMs))) : Math.min(...ctx.groups.map(waitMs));
    await sleep(delay + Math.random() * JITTER_MS);
  }
}

/** Start mood tracking in the background once the AI Task entity exists. Never blocks stock checks. */
function startMoodInBackground(
  cfg: Config,
  notifiers: ReturnType<typeof buildNotifiers>,
  inDailySummary: boolean,
  onStarted: (m: ReturnType<typeof startMood> & { ctx: MoodCtx }) => void,
): void {
  const token = process.env.SUPERVISOR_TOKEN;
  const entity = cfg.mood.aiTaskEntity;
  const check = async (): Promise<ReadyCheck> => {
    if (!token) return { ok: false, problem: "Mood tracking needs Home Assistant (no Supervisor token), so it is off.", permanent: true };
    const res = await fetch(`${HA_API}/states/${entity}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { ok: true };
    return { ok: false, problem: res.status === 404 ? `${entity} doesn't exist yet; set mood_ai_task_entity to an AI Task entity` : `checking ${entity} failed (HTTP ${res.status})` };
  };
  void startMoodWhenReady({
    check,
    alert: (title, detail) => sendAll(notifiers, formatStatus(title, detail)),
    start: () => {
      console.log(`Mood tracking on: r/${cfg.mood.subreddits.join(", r/") || "(none)"}${cfg.mood.newsQuery ? ` and news for "${cfg.mood.newsQuery}"` : ""}, Reddit via ${cfg.mood.redditClientId ? "login" : "public feed"}, digest at ${cfg.mood.digestTime}.`);
      const moodCtx: MoodCtx = {
        cfg: cfg.mood,
        statePath: cfg.moodStatePath,
        notifiers,
        collect,
        ai: (body) => callAiTask(body, { token: token! }),
        sensor: (s, now, sources) => updateMoodSensor(s, now, sources, { token }),
      };
      // In daily_summary mode mood goes into the combined daily message instead of its own digest.
      onStarted({ ...startMood(moodCtx, { digest: !inDailySummary }), ctx: moodCtx });
    },
  }).catch((error) => console.error(`Mood: startup failed: ${message(error)}`));
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
