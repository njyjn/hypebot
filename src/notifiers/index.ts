import type { Config } from "../config.js";
import type { AlertMessage, MessageKind, Notifier } from "../types.js";
import { createHaNotify } from "./ha.js";
import { createSlack } from "./slack.js";
import { createTelegram } from "./telegram.js";

export function buildNotifiers(cfg: Config, env: NodeJS.ProcessEnv = process.env): Notifier[] {
  const list: Notifier[] = [];
  const only = (n: Notifier, kinds: MessageKind[]): Notifier => ({ ...n, kinds: new Set(kinds) });
  if (cfg.haNotifyService && env.SUPERVISOR_TOKEN) list.push(only(createHaNotify(cfg.haNotifyService, env.SUPERVISOR_TOKEN, undefined, cfg.haNotifyPriority), cfg.haNotifyMessages));
  if (cfg.slackBotToken && cfg.slackChannel) list.push(only(createSlack(cfg.slackBotToken, cfg.slackChannel), cfg.slackMessages));
  if (cfg.telegramBotToken && cfg.telegramChatId) list.push(only(createTelegram(cfg.telegramBotToken, cfg.telegramChatId), cfg.telegramMessages));
  return list;
}

/**
 * Send to every destination that takes this kind of message; a failure in
 * one never stops the others. `everywhere` ignores the routing (--test-notify).
 */
export async function sendAll(notifiers: Notifier[], msg: AlertMessage, opts: { everywhere?: boolean } = {}): Promise<void> {
  const targets = opts.everywhere ? notifiers : notifiers.filter((n) => !n.kinds || n.kinds.has(msg.kind));
  const results = await Promise.allSettled(targets.map((n) => n.send(msg)));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Alert via ${targets[i].name} failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  });
}
