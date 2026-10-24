import { plainText } from "../format.js";
import type { AlertMessage, Notifier } from "../types.js";
import { postJson } from "./post.js";

// Slack mrkdwn only needs &, < and > escaped.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Posts as a Slack app bot (needs the chat:write scope and to be in the channel). */
export function createSlack(token: string, channel: string, apiBase = "https://slack.com/api"): Notifier {
  return {
    name: "slack",
    async send(msg: AlertMessage) {
      const text = `*${esc(msg.title)}*\n${esc(plainText(msg))}`;
      const reply = await postJson(`${apiBase}/chat.postMessage`, { channel, text, unfurl_links: false }, { Authorization: `Bearer ${token}` });
      if (reply.ok === false) throw new Error(`Slack error: ${reply.error}`);
    },
  };
}
