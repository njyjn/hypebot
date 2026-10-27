import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPLE_SG_MODELS } from "./sources/apple-sg-models.js";
import type { MoodConfig } from "./mood/types.js";
import { MESSAGE_KINDS, type MessageKind, type WatchConfig } from "./types.js";

export type HaNotifyPriority = "normal" | "time_sensitive" | "critical";
export type NotifyMode = "instant" | "daily_summary";
const PRIORITIES: HaNotifyPriority[] = ["normal", "time_sensitive", "critical"];

export interface Config {
  intervalSeconds: number;
  watch: WatchConfig[]; // typed `watch` entries plus picked `models`
  buyLinkBase: string; // Apple store front used for links in alerts and sensors
  appleSgStores: string[];
  notifySoldOut: boolean;
  haNotifyPriority: HaNotifyPriority; // how loudly stock alerts arrive on phones
  remindEveryMinutes: number; // 0 = off; otherwise re-alert while still in stock
  sendTestAlert: boolean;
  notifyMode: NotifyMode; // daily_summary: stock and delivery news wait for the daily message
  haNotifyService: string;
  slackBotToken: string;
  slackChannel: string;
  telegramBotToken: string;
  telegramChatId: string;
  /** Which kinds of message each destination gets (default: all). */
  telegramMessages: MessageKind[];
  slackMessages: MessageKind[];
  haNotifyMessages: MessageKind[];
  statePath: string;
  trackDeliveryDates: boolean;
  deliveryStatePath: string;
  healthStatePath: string;
  mood: MoodConfig;
  moodStatePath: string;
  summaryStatePath: string;
  schedulePath: string;
  modelCachePath: string;
  /** Problems worth logging at startup. Never contains secret values. */
  warnings: string[];
}

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 3600;
const DEFAULT_BUY_LINK_BASE = "https://www.apple.com/sg";

/**
 * Settings come from the add-on options file (Home Assistant writes
 * /data/options.json), and any scalar key can be overridden by its
 * upper-case env var, so plain Docker works without a file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(env.OPTIONS_PATH || "/data/options.json", "utf8"));
  } catch {
    // no options file outside Home Assistant
  }

  const pick = (key: string): unknown => {
    const fromEnv = env[key.toUpperCase()];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : raw[key];
  };
  const str = (key: string) => {
    const v = pick(key);
    return typeof v === "string" ? v.trim() : "";
  };
  const bool = (key: string) => {
    const v = pick(key);
    return v === true || v === "true" || v === "1";
  };
  const strList = (key: string) =>
    Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

  // A missing or empty list means every kind: existing setups keep getting
  // everything, and clearing the list never silently mutes a destination.
  const kinds = (key: string): MessageKind[] => {
    const picked = Array.isArray(raw[key]) ? MESSAGE_KINDS.filter((k) => (raw[key] as unknown[]).includes(k)) : [];
    return picked.length > 0 ? picked : [...MESSAGE_KINDS];
  };

  const interval = Number(pick("interval_seconds"));
  const intervalSeconds = Number.isFinite(interval) && interval > 0
    ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(interval)))
    : 60;

  let watch: WatchConfig[] = Array.isArray(raw.watch) ? (raw.watch as WatchConfig[]) : [];
  if (env.WATCH) watch = JSON.parse(env.WATCH);

  // Models picked from the dropdown become watch entries, one per product.
  const warnings: string[] = [];
  const picked = new Map<string, string[]>();
  for (const label of strList("models")) {
    const model = APPLE_SG_MODELS[label];
    if (!model) {
      warnings.push(`Unknown model "${label}" in models; skipping it`);
      continue;
    }
    picked.set(model.product, [...(picked.get(model.product) ?? []), model.variant]);
  }
  watch = [...watch, ...[...picked].map(([product, variants]) => ({ source: "apple_sg", product, variants }))];

  let buyLinkBase = str("buy_link_base").replace(/\/+$/, "") || DEFAULT_BUY_LINK_BASE;
  if (!/^https:\/\/www\.apple\.com\//.test(`${buyLinkBase}/`)) {
    warnings.push(`buy_link_base must be an https://www.apple.com/... address; using ${DEFAULT_BUY_LINK_BASE}`);
    buyLinkBase = DEFAULT_BUY_LINK_BASE;
  }

  const cfg: Config = {
    intervalSeconds,
    watch,
    buyLinkBase,
    appleSgStores: strList("apple_sg_stores"),
    notifySoldOut: bool("notify_sold_out"),
    haNotifyPriority: (PRIORITIES as string[]).includes(str("ha_notify_priority")) ? (str("ha_notify_priority") as HaNotifyPriority) : "time_sensitive",
    remindEveryMinutes: Math.min(60, Math.max(0, Math.round(Number(pick("remind_every_minutes")) || 0))),
    sendTestAlert: bool("send_test_alert"),
    notifyMode: str("notify_mode") === "daily_summary" ? "daily_summary" : "instant",
    haNotifyService: str("ha_notify_service"),
    slackBotToken: str("slack_bot_token"),
    slackChannel: str("slack_channel"),
    telegramBotToken: str("telegram_bot_token"),
    telegramChatId: str("telegram_chat_id"),
    telegramMessages: kinds("telegram_messages"),
    slackMessages: kinds("slack_messages"),
    haNotifyMessages: kinds("ha_notify_messages"),
    statePath: env.STATE_PATH || "/data/state.json",
    trackDeliveryDates: pick("track_delivery_dates") === undefined ? true : bool("track_delivery_dates"),
    deliveryStatePath: join(dirname(env.STATE_PATH || "/data/state.json"), "delivery.json"),
    healthStatePath: join(dirname(env.STATE_PATH || "/data/state.json"), "health.json"),
    mood: moodConfig(raw, pick, str, bool, warnings),
    moodStatePath: join(dirname(env.STATE_PATH || "/data/state.json"), "mood.json"),
    summaryStatePath: join(dirname(env.STATE_PATH || "/data/state.json"), "summary.json"),
    schedulePath: join(dirname(env.STATE_PATH || "/data/state.json"), "schedule.json"),
    modelCachePath: join(dirname(env.STATE_PATH || "/data/state.json"), "models.json"),
    warnings,
  };

  const pairs: [string, string, string][] = [
    ["Slack", cfg.slackBotToken, cfg.slackChannel],
    ["Telegram", cfg.telegramBotToken, cfg.telegramChatId],
  ];
  for (const [name, a, b] of pairs) {
    if (Boolean(a) !== Boolean(b)) cfg.warnings.push(`${name} is only half configured (needs both token and ${name === "Slack" ? "channel" : "chat id"}); skipping it`);
  }
  const anyDestination = cfg.haNotifyService || pairs.some(([, a, b]) => a && b);
  if (!anyDestination) cfg.warnings.push("No alert destination configured; only Home Assistant sensors will update");
  else {
    const routes: MessageKind[][] = [
      ...(cfg.haNotifyService ? [cfg.haNotifyMessages] : []),
      ...(cfg.slackBotToken && cfg.slackChannel ? [cfg.slackMessages] : []),
      ...(cfg.telegramBotToken && cfg.telegramChatId ? [cfg.telegramMessages] : []),
    ];
    for (const k of MESSAGE_KINDS) {
      if (!routes.some((r) => r.includes(k))) cfg.warnings.push(`${k} messages go to no destination (check telegram_messages, slack_messages, ha_notify_messages)`);
    }
  }

  return cfg;
}

/** The mood_* options. Missing keys get defaults; an empty news query turns news off. */
function moodConfig(raw: Record<string, unknown>, pick: (k: string) => unknown, str: (k: string) => string, bool: (k: string) => boolean, warnings: string[]): MoodConfig {
  const subs = Array.isArray(raw.mood_subreddits) ? (raw.mood_subreddits as unknown[]) : ["iPhoneDuo"];
  let digestTime = str("mood_digest_time") || "21:00";
  const m = /^(\d{2}):(\d{2})$/.exec(digestTime);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    warnings.push(`mood_digest_time must be HH:MM (24-hour); using 21:00`);
    digestTime = "21:00";
  }
  let redditClientId = str("reddit_client_id");
  let redditClientSecret = str("reddit_client_secret");
  if (Boolean(redditClientId) !== Boolean(redditClientSecret)) {
    warnings.push("Reddit login needs both reddit_client_id and reddit_client_secret; using Reddit's public feed instead");
    redditClientId = redditClientSecret = "";
  }
  return {
    enabled: bool("mood_enabled"),
    aiTaskEntity: str("mood_ai_task_entity") || "ai_task.claude_ai_task",
    subreddits: subs
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().replace(/^\/?r\//i, "").replace(/\/+$/, ""))
      .filter(Boolean),
    newsQuery: pick("mood_news_enabled") !== undefined && !bool("mood_news_enabled") ? "" : pick("mood_news_query") === undefined ? "iPhone Duo" : str("mood_news_query"),
    digestTime,
    redditClientId,
    redditClientSecret,
  };
}
