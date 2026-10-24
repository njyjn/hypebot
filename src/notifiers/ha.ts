import type { AlertMessage, Notifier } from "../types.js";
import { postJson } from "./post.js";

export const HA_API = process.env.HA_API_URL || "http://supervisor/core/api";

/**
 * Calls a Home Assistant notify service through the Supervisor proxy.
 * @param service "notify.mobile_app_x" or just "mobile_app_x"
 */
export function createHaNotify(service: string, token: string, apiBase = HA_API): Notifier {
  const name = service.replace(/^notify\./, "");
  return {
    name: "ha_notify",
    async send(msg: AlertMessage) {
      await postJson(
        `${apiBase}/services/notify/${name}`,
        {
          title: msg.title,
          message: msg.lines.join("\n"),
          // url opens on iOS, clickAction on Android, when the alert is tapped
          ...(msg.url ? { data: { url: msg.url, clickAction: msg.url } } : {}),
        },
        { Authorization: `Bearer ${token}` },
      );
    },
  };
}
