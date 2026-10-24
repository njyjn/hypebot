import { readFileSync } from "node:fs";
import type { WatchConfig } from "./types.js";

export interface Config {
  intervalSeconds: number;
  watch: WatchConfig[];
  appleSgStores: string[];
  notifySoldOut: boolean;
  sendTestAlert: boolean;
  haNotifyService: string;
  slackBotToken: string;
  slackChannel: string;
  telegramBotToken: string;
  telegramChatId: string;
  statePath: string;
  /** Problems worth logging at startup. Never contains secret values. */
  warnings: string[];
}

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 3600;

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

  const interval = Number(pick("interval_seconds"));
  const intervalSeconds = Number.isFinite(interval) && interval > 0
    ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(interval)))
    : 60;

  let watch: WatchConfig[] = Array.isArray(raw.watch) ? (raw.watch as WatchConfig[]) : [];
  if (env.WATCH) watch = JSON.parse(env.WATCH);

  const cfg: Config = {
    intervalSeconds,
    watch,
    appleSgStores: strList("apple_sg_stores"),
    notifySoldOut: bool("notify_sold_out"),
    sendTestAlert: bool("send_test_alert"),
    haNotifyService: str("ha_notify_service"),
    slackBotToken: str("slack_bot_token"),
    slackChannel: str("slack_channel"),
    telegramBotToken: str("telegram_bot_token"),
    telegramChatId: str("telegram_chat_id"),
    statePath: env.STATE_PATH || "/data/state.json",
    warnings: [],
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

  return cfg;
}
