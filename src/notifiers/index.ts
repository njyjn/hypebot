import type { Config } from "../config.js";
import type { AlertMessage, Notifier } from "../types.js";
import { createHaNotify } from "./ha.js";
import { createSlack } from "./slack.js";
import { createTelegram } from "./telegram.js";

export function buildNotifiers(cfg: Config, env: NodeJS.ProcessEnv = process.env): Notifier[] {
  const list: Notifier[] = [];
  if (cfg.haNotifyService && env.SUPERVISOR_TOKEN) list.push(createHaNotify(cfg.haNotifyService, env.SUPERVISOR_TOKEN, undefined, cfg.haNotifyPriority));
  if (cfg.slackBotToken && cfg.slackChannel) list.push(createSlack(cfg.slackBotToken, cfg.slackChannel));
  if (cfg.telegramBotToken && cfg.telegramChatId) list.push(createTelegram(cfg.telegramBotToken, cfg.telegramChatId));
  return list;
}

/** Send to every destination; a failure in one never stops the others. */
export async function sendAll(notifiers: Notifier[], msg: AlertMessage): Promise<void> {
  const results = await Promise.allSettled(notifiers.map((n) => n.send(msg)));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Alert via ${notifiers[i].name} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  });
}
