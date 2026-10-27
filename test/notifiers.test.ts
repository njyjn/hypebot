import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatReminder, formatSoldOut, formatStatus, formatStockAlert, plainText } from "../src/format.js";
import { formatDeliveryAlert } from "../src/delivery.js";
import { buildNotifiers, sendAll } from "../src/notifiers/index.js";
import { createHaNotify } from "../src/notifiers/ha.js";
import { createSlack } from "../src/notifiers/slack.js";
import { createTelegram } from "../src/notifiers/telegram.js";
import type { AlertMessage, MessageKind, Notifier } from "../src/types.js";
import { duoItem, fakeServer } from "./helpers.js";

const nightSky = duoItem("MK2G4X/A", "Night Sky 512GB");
const msg: AlertMessage = { title: "🟢 iPhone Duo in stock (Apple SG)", lines: ["Night Sky 512GB: Orchard Road (Available Today)"], url: nightSky.buyUrl, kind: "stock" };

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
    expect(m.urgent).toBe(true);
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

  it("names the item's own shop in the title", () => {
    const item = { ...nightSky, shop: "Other Shop" };
    expect(formatStockAlert([{ item, stores: [{ name: "Main St", quote: "In stock" }] }]).title).toBe("🟢 iPhone Duo in stock (Other Shop)");
    expect(formatSoldOut([item]).title).toBe("⚪ iPhone Duo sold out (Other Shop)");
  });

  it("links straight to the model page when one model restocks", () => {
    const item = { ...nightSky, buyUrl: "https://x/iphone-duo/512gb-night-sky" };
    const m = formatStockAlert([{ item, stores: [{ name: "Orchard Road", quote: "Available Today" }] }]);
    expect(m.url).toBe("https://x/iphone-duo/512gb-night-sky");
    expect(plainText(m)).toBe("Night Sky 512GB: Orchard Road (Available Today)\nBuy: https://x/iphone-duo/512gb-night-sky");
  });

  it("gives each model its own buy link when several restock together", () => {
    const a = { ...nightSky, buyUrl: "https://x/iphone-duo/512gb-night-sky", productUrl: "https://x/iphone-duo" };
    const b = { ...duoItem("MK2F4X/A", "Star White 512GB"), buyUrl: "https://x/iphone-duo/512gb-star-white", productUrl: "https://x/iphone-duo" };
    const m = formatStockAlert([
      { item: a, stores: [{ name: "Orchard Road", quote: "Available Today" }] },
      { item: b, stores: [{ name: "Jewel Changi Airport", quote: "Available Today" }] },
    ]);
    expect(m.url).toBe("https://x/iphone-duo");
    expect(m.links).toEqual([
      { label: "Night Sky 512GB", url: "https://x/iphone-duo/512gb-night-sky" },
      { label: "Star White 512GB", url: "https://x/iphone-duo/512gb-star-white" },
    ]);
    expect(plainText(m)).toBe(
      [
        "• Night Sky 512GB: Orchard Road (Available Today)",
        "• Star White 512GB: Jewel Changi Airport (Available Today)",
        "Buy Night Sky 512GB: https://x/iphone-duo/512gb-night-sky",
        "Buy Star White 512GB: https://x/iphone-duo/512gb-star-white",
      ].join("\n"),
    );
  });

  it("formats sold-out and status messages", () => {
    expect(formatSoldOut([nightSky])).toEqual({ title: "⚪ iPhone Duo sold out (Apple SG)", lines: ["Night Sky 512GB"], kind: "stock" });
    expect(formatStatus("HypeBot test alert", "Alerts are working.")).toEqual({ title: "HypeBot test alert", lines: ["Alerts are working."], kind: "status" });
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

describe("ha notify loudness", () => {
  const urgent: AlertMessage = { ...msg, urgent: true };

  it("marks urgent alerts time-sensitive so they break through Focus", async () => {
    const s = await server();
    await createHaNotify("mobile_app_x", "t", s.base, "time_sensitive").send(urgent);
    expect(s.requests[0].body.data.push).toEqual({ "interruption-level": "time-sensitive" });
    expect(s.requests[0].body.data.priority).toBe("high");
    expect(s.requests[0].body.data.ttl).toBe(0);
  });

  it("makes urgent alerts critical, ringing even on silent, when asked", async () => {
    const s = await server();
    await createHaNotify("mobile_app_x", "t", s.base, "critical").send(urgent);
    expect(s.requests[0].body.data.push).toEqual({
      "interruption-level": "critical",
      sound: { name: "default", critical: 1, volume: 1.0 },
    });
    expect(s.requests[0].body.data.channel).toBe("alarm_stream");
  });

  it("sends non-urgent messages, like status notes, normally", async () => {
    const s = await server();
    await createHaNotify("mobile_app_x", "t", s.base, "critical").send({ title: "status", lines: ["x"] });
    expect(s.requests[0].body.data).toBeUndefined();
  });

  it("keeps the tap-to-open link alongside the loudness settings", async () => {
    const s = await server();
    await createHaNotify("mobile_app_x", "t", s.base, "time_sensitive").send(urgent);
    expect(s.requests[0].body.data.url).toBe(msg.url);
    expect(s.requests[0].body.data.clickAction).toBe(msg.url);
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

describe("message kinds", () => {
  it("every formatter sets the kind", () => {
    expect(formatStockAlert([{ item: nightSky, stores: [{ name: "Orchard Road", quote: "x" }] }]).kind).toBe("stock");
    expect(formatReminder([{ item: nightSky, stores: [{ name: "Orchard Road", quote: "x" }] }]).kind).toBe("stock");
    expect(formatSoldOut([nightSky]).kind).toBe("stock");
    expect(formatStatus("⚠️ x", "y").kind).toBe("status");
    expect(formatDeliveryAlert([{ item: nightSky, from: { date: "2027-01-25", label: "a" }, to: { date: "2027-01-18", label: "b" } }]).kind).toBe("delivery");
  });
});

describe("routing", () => {
  const recorder = (name: string, kinds?: MessageKind[]) => {
    const got: string[] = [];
    const n: Notifier = { name, send: async (m) => void got.push(m.kind), ...(kinds ? { kinds: new Set(kinds) } : {}) };
    return { n, got };
  };

  it("only sends a kind to destinations that accept it", async () => {
    const tg = recorder("telegram", ["stock", "delivery"]);
    const ha = recorder("ha_notify");
    for (const kind of ["stock", "status", "digest", "delivery", "test"] as MessageKind[]) {
      await sendAll([tg.n, ha.n], { title: kind, lines: [], kind });
    }
    expect(tg.got).toEqual(["stock", "delivery"]);
    expect(ha.got).toEqual(["stock", "status", "digest", "delivery", "test"]);
  });

  it("everywhere: true ignores the routing (for --test-notify)", async () => {
    const tg = recorder("telegram", ["stock"]);
    await sendAll([tg.n], { title: "t", lines: [], kind: "test" }, { everywhere: true });
    expect(tg.got).toEqual(["test"]);
  });

  it("buildNotifiers applies the per-destination settings", async () => {
    const cfg = loadConfig({ OPTIONS_PATH: "/nonexistent/options.json", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", HA_NOTIFY_SERVICE: "notify.x" });
    cfg.telegramMessages = ["stock", "delivery"];
    const [ha, tg] = buildNotifiers(cfg, { SUPERVISOR_TOKEN: "s" });
    expect(ha.name).toBe("ha_notify");
    expect([...(ha.kinds ?? [])].sort()).toEqual(["delivery", "digest", "status", "stock", "test"]);
    expect([...(tg.kinds ?? [])].sort()).toEqual(["delivery", "stock"]);
  });
});
