import { plainText } from "../format.js";
import type { AlertMessage, Notifier } from "../types.js";
import { postJson } from "./post.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createTelegram(token: string, chatId: string, apiBase = "https://api.telegram.org"): Notifier {
  return {
    name: "telegram",
    async send(msg: AlertMessage) {
      await postJson(`${apiBase}/bot${token}/sendMessage`, {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `<b>${esc(msg.title)}</b>\n${esc(plainText(msg))}`,
        link_preview_options: { is_disabled: true },
      });
    },
  };
}
