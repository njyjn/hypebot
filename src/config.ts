import { readFileSync } from "node:fs";
import { APPLE_SG_MODELS } from "./sources/apple-sg-models.js";
import type { WatchConfig } from "./types.js";

export type HaNotifyPriority = "normal" | "time_sensitive" | "critical";
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
    haNotifyService: str("ha_notify_service"),
    slackBotToken: str("slack_bot_token"),
    slackChannel: str("slack_channel"),
    telegramBotToken: str("telegram_bot_token"),
    telegramChatId: str("telegram_chat_id"),
    statePath: env.STATE_PATH || "/data/state.json",
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

  return cfg;
}
