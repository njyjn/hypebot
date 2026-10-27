import { dailyDue } from "./clock.js";
import { buildMoodDigest, type MoodCtx } from "./mood/index.js";
import type { MoodState } from "./mood/types.js";
import { sendAll } from "./notifiers/index.js";
import { clearReported, formatSummary, saveSummary, type SummaryLog } from "./summary.js";
import type { Notifier } from "./types.js";

const CHECK_MS = 60_000;
const MOOD_PREFIX = "📊 iPhone Duo mood: ";

export interface DailyCtx {
  time: string; // "HH:MM", local
  notifiers: Notifier[];
  summary: { log: SummaryLog; path: string };
  mood?: () => { ctx: MoodCtx; state: MoodState } | undefined; // set once mood is running
  now?: () => number;
  timeZone?: string;
  log?: (msg: string) => void;
}

function save(ctx: DailyCtx) {
  try {
    saveSummary(ctx.summary.path, ctx.summary.log);
  } catch (error) {
    (ctx.log ?? console.error)(`Saving summary failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** daily_summary mode: one message a day with the day's drops, delivery changes and mood. */
export async function maybeSendDaily(ctx: DailyCtx): Promise<boolean> {
  const now = (ctx.now ?? Date.now)();
  const date = dailyDue(now, ctx.time, ctx.summary.log.lastSentDate, ctx.timeZone);
  if (!date) return false;
  ctx.summary.log.lastSentDate = date; // set before any await so overlapping checks send once
  save(ctx);

  const lines = formatSummary(ctx.summary.log, now, ctx.timeZone);
  const mood = ctx.mood?.();
  if (mood) {
    try {
      const digest = await buildMoodDigest(mood.ctx, mood.state, now);
      lines.push(`Mood: ${digest.title.replace(MOOD_PREFIX, "")}`, ...digest.lines);
    } catch (error) {
      (ctx.log ?? console.warn)(`Daily message: mood part failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(now)).replace(",", "");
  await sendAll(ctx.notifiers, { title: `📊 HypeBot · ${day}`, lines, kind: "digest" });
  clearReported(ctx.summary.log);
  save(ctx);
  return true;
}

export function startDaily(ctx: DailyCtx): () => void {
  const timer = setInterval(() => {
    maybeSendDaily(ctx).catch((error) => (ctx.log ?? console.error)(`Daily message failed: ${error instanceof Error ? error.message : error}`));
  }, CHECK_MS);
  return () => clearInterval(timer);
}
