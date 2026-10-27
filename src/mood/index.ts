import { dailyDue, localClock } from "../clock.js";
import { sendAll } from "../notifiers/index.js";
import type { AlertMessage, Notifier } from "../types.js";
import { buildBatchRequest, buildDigestRequest, readBatchReply, readDigestReply } from "./analyse.js";
import type { collect } from "./sources.js";
import { loadMood, moodLabel, prune, saveMood, score24h } from "./store.js";
import type { MoodConfig, MoodState } from "./types.js";

const CYCLE_MS = 30 * 60_000;
const DIGEST_CHECK_MS = 60_000;
const MAX_ITEMS = 60;
const ALERT_AFTER_FAILURES = 6;
const DAY = 24 * 3_600_000;
const MAX_ITEM_AGE_MS = 2 * DAY; // feeds keep old posts for weeks; only recent ones count
const MAX_FALLBACK_THEMES = 8;

export interface MoodCtx {
  cfg: MoodConfig;
  statePath: string;
  notifiers: Notifier[];
  collect: typeof collect;
  ai: (body: object) => Promise<unknown>;
  sensor: (s: MoodState, now: number, sources: string[]) => Promise<void>;
  now?: () => number;
  timeZone?: string; // defaults to the container's TZ
  log?: (msg: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function save(ctx: MoodCtx, state: MoodState) {
  try {
    saveMood(ctx.statePath, state);
  } catch (error) {
    (ctx.log ?? console.error)(`Mood: saving ${ctx.statePath} failed: ${message(error)}`);
  }
}

/** Collect new posts, score them, refresh the sensor and save. */
export async function runMoodCycle(ctx: MoodCtx, state: MoodState): Promise<void> {
  const log = ctx.log ?? ((m: string) => console.warn(m));
  const now = (ctx.now ?? Date.now)();
  const { items, sources } = await ctx.collect({
    subreddits: ctx.cfg.subreddits,
    newsQuery: ctx.cfg.newsQuery,
    reddit: ctx.cfg.redditClientId && ctx.cfg.redditClientSecret ? { clientId: ctx.cfg.redditClientId, clientSecret: ctx.cfg.redditClientSecret } : undefined,
    log,
  });
  const fresh = items.filter((i) => state.seen[i.id] === undefined && i.createdAt > 0 && now - i.createdAt <= MAX_ITEM_AGE_MS).slice(0, MAX_ITEMS);

  if (fresh.length > 0) {
    try {
      const { score, themes } = readBatchReply(await ctx.ai(buildBatchRequest(ctx.cfg.aiTaskEntity, fresh)), fresh);
      state.batches.push({ at: now, score, items: fresh.length, themes });
      for (const i of fresh) state.seen[i.id] = now;
      if (state.alerted) {
        await sendAll(ctx.notifiers, { title: "✅ HypeBot mood is working again", lines: ["The AI Task is answering again."], kind: "status" });
      }
      state.failuresInARow = 0;
      state.alerted = false;
    } catch (error) {
      state.failuresInARow++;
      log(`Mood: AI Task failed (${state.failuresInARow} in a row), will retry these posts: ${message(error)}`);
      if (state.failuresInARow >= ALERT_AFTER_FAILURES && !state.alerted) {
        state.alerted = true;
        await sendAll(ctx.notifiers, {
          title: "⚠️ HypeBot mood can't reach the AI Task",
          lines: [`The last ${state.failuresInARow} attempts failed. Latest error: ${message(error)}. Stock alerts are not affected.`],
          kind: "status",
        });
      }
    }
  }

  prune(state, now);
  await ctx.sensor(state, now, sources);
  save(ctx, state);
}

const signed = (n: number) => `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}`;

/** Send today's digest if it's digest time and it hasn't gone out yet. */
export async function maybeSendDigest(ctx: MoodCtx, state: MoodState): Promise<boolean> {
  const now = (ctx.now ?? Date.now)();
  const date = dailyDue(now, ctx.cfg.digestTime, state.lastDigestDate, ctx.timeZone);
  if (!date) return false;
  state.lastDigestDate = date; // set before any await so overlapping checks send once
  save(ctx, state);
  await sendAll(ctx.notifiers, await buildMoodDigest(ctx, state, now));
  return true;
}

/** Today's mood digest: a header HypeBot computes, then the AI's summary (or the themes if that fails). */
export async function buildMoodDigest(ctx: MoodCtx, state: MoodState, now: number): Promise<AlertMessage> {
  const { date } = localClock(now, ctx.timeZone);
  const today = state.batches.filter((b) => localClock(b.at, ctx.timeZone).date === date && b.at <= now);
  const current = score24h(state, now);
  if (today.length === 0 || !current) return { title: "📊 iPhone Duo mood: no new posts today", lines: [], kind: "digest" };
  const yesterday = score24h(state, now - DAY)?.score;
  const title = `📊 iPhone Duo mood: ${signed(current.score)} (${moodLabel(current.score)})${yesterday === undefined ? "" : `, was ${signed(yesterday)} yesterday`} · ${current.items} posts`;

  let lines: string[];
  try {
    lines = readDigestReply(await ctx.ai(buildDigestRequest(ctx.cfg.aiTaskEntity, today, yesterday))).split("\n").filter((l) => l.trim());
  } catch (error) {
    (ctx.log ?? console.warn)(`Mood: digest AI call failed, sending the themes instead: ${message(error)}`);
    const newestFirst = [...today].reverse().flatMap((b) => b.themes);
    const unique = newestFirst.filter((t, i) => newestFirst.findIndex((u) => u.text === t.text) === i).slice(0, MAX_FALLBACK_THEMES);
    lines = unique.map((t) => (t.url ? `${t.text}: ${t.url}` : t.text));
  }
  return { title, lines, kind: "digest" };
}

/** Run mood in the background. Errors are logged and never reach the stock loop. */
export function startMood(ctx: MoodCtx, opts: { digest?: boolean } = {}): { stop: () => void; state: MoodState } {
  const state = loadMood(ctx.statePath);
  const log = ctx.log ?? ((m: string) => console.warn(m));
  let busy = false;
  const cycle = async () => {
    if (busy) return;
    busy = true;
    try {
      await runMoodCycle(ctx, state);
    } catch (error) {
      log(`Mood: run failed: ${message(error)}`);
    } finally {
      busy = false;
    }
  };
  const digest = () => maybeSendDigest(ctx, state).catch((error) => log(`Mood: digest failed: ${message(error)}`));
  void cycle();
  // In daily_summary mode the combined daily message includes mood instead.
  const timers = [setInterval(cycle, CYCLE_MS), ...(opts.digest === false ? [] : [setInterval(digest, DIGEST_CHECK_MS)])];
  return { stop: () => timers.forEach(clearInterval), state };
}
