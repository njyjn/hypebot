import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatSoldOut, formatStatus, formatStockAlert } from "../src/format.js";
import { buildNotifiers, sendAll } from "../src/notifiers/index.js";
import { createHaNotify } from "../src/notifiers/ha.js";
import { createSlack } from "../src/notifiers/slack.js";
import { createTelegram } from "../src/notifiers/telegram.js";
import type { AlertMessage, Notifier } from "../src/types.js";
import { duoItem, fakeServer } from "./helpers.js";

const nightSky = duoItem("MK2G4X/A", "Night Sky 512GB");
const msg: AlertMessage = { title: "🟢 iPhone Duo in stock (Apple SG)", lines: ["Night Sky 512GB: Orchard Road (Available Today)"], url: nightSky.buyUrl };

let servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
const server = async (...args: Parameters<typeof fakeServer>) => {
  const s = await fakeServer(...args);
  servers.push(s);
  return s;
};

describe("format", () => {
  it("formats one product's new stock as a single alert", () => {
    const m = formatStockAlert([
      {
        item: nightSky,
        stores: [
          { name: "Orchard Road", quote: "Available Today" },
          { name: "Jewel Changi Airport", quote: "Available Today" },
        ],
      },
    ]);
    expect(m.title).toBe("🟢 iPhone Duo in stock (Apple SG)");
    expect(m.lines[0]).toBe("Night Sky 512GB: Orchard Road, Jewel Changi Airport (Available Today)");
    expect(m.url).toBe("https://www.apple.com/sg/shop/buy-iphone/iphone-duo");
  });

  it("shows each store's own wording when they differ", () => {
    const m = formatStockAlert([
      { item: nightSky, stores: [{ name: "Orchard Road", quote: "Available Today" }, { name: "Jewel Changi Airport", quote: "Available Tomorrow" }] },
    ]);
    expect(m.lines[0]).toBe("Night Sky 512GB: Orchard Road (Available Today), Jewel Changi Airport (Available Tomorrow)");
  });

  it("names the product on each line when several products are in one alert", () => {
    const air = duoItem("MX001X/A", "Sky Blue 256GB", "iphone-air", "iPhone Air");
    const m = formatStockAlert([
      { item: nightSky, stores: [{ name: "Orchard Road", quote: "Available Today" }] },
      { item: air, stores: [{ name: "Orchard Road", quote: "Available Today" }] },
    ]);
    expect(m.title).toBe("🟢 Stock alert (Apple SG)");
    expect(m.lines).toEqual(["iPhone Duo Night Sky 512GB: Orchard Road (Available Today)", "iPhone Air Sky Blue 256GB: Orchard Road (Available Today)"]);
    expect(m.url).toBeUndefined();
  });

  it("formats sold-out and status messages", () => {
    expect(formatSoldOut([nightSky])).toEqual({ title: "⚪ iPhone Duo sold out (Apple SG)", lines: ["Night Sky 512GB"] });
    expect(formatStatus("HypeBot test alert", "Alerts are working.")).toEqual({ title: "HypeBot test alert", lines: ["Alerts are working."] });
  });
});

describe("slack", () => {
  it("posts to chat.postMessage with the bot token", async () => {
    const s = await server();
    await createSlack("xoxb-secret", "#stock", s.base).send(msg);
    expect(s.requests).toHaveLength(1);
    const [r] = s.requests;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/chat.postMessage");
    expect(r.headers.authorization).toBe("Bearer xoxb-secret");
    expect(r.body.channel).toBe("#stock");
    expect(r.body.text).toContain("iPhone Duo in stock");
    expect(r.body.text).toContain(nightSky.buyUrl);
  });

  it("rejects when Slack answers ok:false", async () => {
    const s = await server(() => ({ body: { ok: false, error: "invalid_auth" } }));
    await expect(createSlack("bad", "#stock", s.base).send(msg)).rejects.toThrow(/invalid_auth/);
  });
});

describe("telegram", () => {
  it("sends HTML-escaped text to the chat", async () => {
    const s = await server();
    await createTelegram("123:abc", "42", s.base).send({ title: "A <b> & c", lines: ["x"] });
    const [r] = s.requests;
    expect(r.url).toBe("/bot123:abc/sendMessage");
    expect(r.body.chat_id).toBe("42");
    expect(r.body.parse_mode).toBe("HTML");
    expect(r.body.text).toContain("A &lt;b&gt; &amp; c");
  });

  it("rejects on an HTTP error", async () => {
    const s = await server(() => ({ status: 401, body: { ok: false, description: "Unauthorized" } }));
    await expect(createTelegram("bad", "42", s.base).send(msg)).rejects.toThrow(/401/);
  });
});

describe("ha notify", () => {
  it.each(["notify.mobile_app_x", "mobile_app_x"])("calls the notify service for %s", async (service) => {
    const s = await server();
    await createHaNotify(service, "sup-token", s.base).send(msg);
    const [r] = s.requests;
    expect(r.url).toBe("/services/notify/mobile_app_x");
    expect(r.headers.authorization).toBe("Bearer sup-token");
    expect(r.body).toEqual({
      title: msg.title,
      message: "Night Sky 512GB: Orchard Road (Available Today)",
      data: { url: nightSky.buyUrl, clickAction: nightSky.buyUrl },
    });
  });

  it("rejects on an HTTP error", async () => {
    const s = await server(() => ({ status: 400 }));
    await expect(createHaNotify("nope", "t", s.base).send(msg)).rejects.toThrow(/400/);
  });
});

describe("sendAll", () => {
  it("still delivers to the others when one destination fails", async () => {
    const got: string[] = [];
    const bad: Notifier = { name: "bad", send: async () => Promise.reject(new Error("boom")) };
    const good: Notifier = { name: "good", send: async (m) => void got.push(m.title) };
    await expect(sendAll([bad, good], msg)).resolves.toBeUndefined();
    expect(got).toEqual([msg.title]);
  });
});

describe("buildNotifiers", () => {
  const missing = "/nonexistent/options.json";
  it("builds only fully configured destinations", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing, SLACK_BOT_TOKEN: "x", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" });
    expect(buildNotifiers(cfg, {}).map((n) => n.name)).toEqual(["telegram"]);
  });

  it("builds HA notify only when running under the Supervisor", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing, HA_NOTIFY_SERVICE: "notify.x" });
    expect(buildNotifiers(cfg, {}).map((n) => n.name)).toEqual([]);
    expect(buildNotifiers(cfg, { SUPERVISOR_TOKEN: "s" }).map((n) => n.name)).toEqual(["ha_notify"]);
  });
});
