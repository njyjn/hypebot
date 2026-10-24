import type { HaNotifyPriority } from "../config.js";
import type { AlertMessage, Notifier } from "../types.js";
import { postJson } from "./post.js";

export const HA_API = process.env.HA_API_URL || "http://supervisor/core/api";

/**
 * Calls a Home Assistant notify service through the Supervisor proxy.
 * @param service "notify.mobile_app_x" or just "mobile_app_x"
 */
/** Companion-app push options per priority (iOS keys under push, Android at the top level). */
const LOUDNESS: Record<HaNotifyPriority, Record<string, unknown>> = {
  normal: {},
  time_sensitive: { push: { "interruption-level": "time-sensitive" }, ttl: 0, priority: "high" },
  critical: {
    push: { "interruption-level": "critical", sound: { name: "default", critical: 1, volume: 1.0 } },
    ttl: 0,
    priority: "high",
    channel: "alarm_stream",
  },
};

export function createHaNotify(service: string, token: string, apiBase = HA_API, priority: HaNotifyPriority = "normal"): Notifier {
  const name = service.replace(/^notify\./, "");
  return {
    name: "ha_notify",
    async send(msg: AlertMessage) {
      await postJson(
        `${apiBase}/services/notify/${name}`,
        {
          title: msg.title,
          message: msg.lines.join("\n"),
          ...dataFor(msg, priority),
        },
        { Authorization: `Bearer ${token}` },
      );
    },
  };
}

function dataFor(msg: AlertMessage, priority: HaNotifyPriority): { data?: Record<string, unknown> } {
  const data: Record<string, unknown> = {
    ...(msg.urgent ? LOUDNESS[priority] : {}),
    // url opens on iOS, clickAction on Android, when the alert is tapped
    ...(msg.url ? { url: msg.url, clickAction: msg.url } : {}),
  };
  return Object.keys(data).length > 0 ? { data } : {};
}
