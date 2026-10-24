import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync as readText } from "node:fs";
import { loadConfig } from "../src/config.js";
import { APPLE_SG_MODELS } from "../src/sources/apple-sg-models.js";

function optionsFile(options: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "hb-")), "options.json");
  writeFileSync(path, JSON.stringify(options));
  return path;
}

const missing = join(tmpdir(), "hb-does-not-exist", "options.json");

describe("loadConfig", () => {
  it("uses defaults when there is no options file", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.intervalSeconds).toBe(60);
    expect(cfg.watch).toEqual([]);
    expect(cfg.appleSgStores).toEqual([]);
    expect(cfg.notifySoldOut).toBe(false);
    expect(cfg.statePath).toBe("/data/state.json");
  });

  it("reads options.json keys into camelCase fields", () => {
    const watch = [{ source: "apple_sg", product: "iphone-duo", variants: ["Star White / 512GB"] }];
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({
        interval_seconds: 45,
        watch,
        apple_sg_stores: ["Orchard Road"],
        notify_sold_out: true,
        send_test_alert: true,
        ha_notify_service: "notify.mobile_app_x",
        slack_bot_token: "xoxb-1",
        slack_channel: "#stock",
        telegram_bot_token: "123:abc",
        telegram_chat_id: "42",
      }),
    });
    expect(cfg).toMatchObject({
      intervalSeconds: 45,
      watch,
      appleSgStores: ["Orchard Road"],
      notifySoldOut: true,
      sendTestAlert: true,
      haNotifyService: "notify.mobile_app_x",
      slackBotToken: "xoxb-1",
      slackChannel: "#stock",
      telegramBotToken: "123:abc",
      telegramChatId: "42",
    });
  });

  it("lets env vars override scalar options and supply watch as JSON", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({ slack_bot_token: "from-file", interval_seconds: 60 }),
      SLACK_BOT_TOKEN: "x",
      INTERVAL_SECONDS: "90",
      WATCH: '[{"source":"apple_sg","product":"iphone-duo","variants":["Star White / 512GB"]}]',
      STATE_PATH: "/tmp/hb-state.json",
    });
    expect(cfg.slackBotToken).toBe("x");
    expect(cfg.intervalSeconds).toBe(90);
    expect(cfg.watch).toEqual([{ source: "apple_sg", product: "iphone-duo", variants: ["Star White / 512GB"] }]);
    expect(cfg.statePath).toBe("/tmp/hb-state.json");
  });

  it("clamps the interval to 30..3600 seconds", () => {
    expect(loadConfig({ OPTIONS_PATH: missing, INTERVAL_SECONDS: "10" }).intervalSeconds).toBe(30);
    expect(loadConfig({ OPTIONS_PATH: missing, INTERVAL_SECONDS: "99999" }).intervalSeconds).toBe(3600);
  });

  it("warns about a half-configured Slack or Telegram destination", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({ slack_bot_token: "xoxb-1", slack_channel: "", telegram_chat_id: "42" }),
    });
    expect(cfg.warnings.some((w) => /slack/i.test(w))).toBe(true);
    expect(cfg.warnings.some((w) => /telegram/i.test(w))).toBe(true);
  });

  it("warns when no alert destination is configured", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.warnings.some((w) => /no alert destination/i.test(w))).toBe(true);
  });

  it("does not warn about destinations when one is fully set", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ telegram_bot_token: "t", telegram_chat_id: "1" }) });
    expect(cfg.warnings).toEqual([]);
  });

  it("turns picked models into watch entries alongside typed ones", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({
        models: ["iPhone Duo / Night Sky / 1TB", "iPhone Duo / Star White / 256GB"],
        watch: [{ source: "apple_sg", product: "iphone-duo", variants: ["white / 512"] }],
      }),
    });
    expect(cfg.watch).toEqual([
      { source: "apple_sg", product: "iphone-duo", variants: ["white / 512"] },
      { source: "apple_sg", product: "iphone-duo", variants: ["Night Sky / 1TB", "Star White / 256GB"] },
    ]);
  });

  it("warns about and skips a picked model it does not know", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ models: ["iPhone Duo / Gold / 1TB"] }) });
    expect(cfg.watch).toEqual([]);
    expect(cfg.warnings.some((w) => w.includes("iPhone Duo / Gold / 1TB"))).toBe(true);
  });

  it("defaults the buy link base to the public SG store", () => {
    expect(loadConfig({ OPTIONS_PATH: missing }).buyLinkBase).toBe("https://www.apple.com/sg");
  });

  it("accepts an Apple store front such as an EPP store as the buy link base", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ buy_link_base: "https://www.apple.com/sg_epp_abc/" }) });
    expect(cfg.buyLinkBase).toBe("https://www.apple.com/sg_epp_abc");
  });

  it("rejects a buy link base that is not on apple.com", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ buy_link_base: "https://evil.example/sg" }) });
    expect(cfg.buyLinkBase).toBe("https://www.apple.com/sg");
    expect(cfg.warnings.some((w) => /buy_link_base/.test(w))).toBe(true);
  });
});

describe("alert loudness and reminders", () => {
  it("defaults to time-sensitive phone alerts and no reminders", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.haNotifyPriority).toBe("time_sensitive");
    expect(cfg.remindEveryMinutes).toBe(0);
  });

  it("reads the priority and reminder interval", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ ha_notify_priority: "critical", remind_every_minutes: 5 }) });
    expect(cfg.haNotifyPriority).toBe("critical");
    expect(cfg.remindEveryMinutes).toBe(5);
  });

  it("falls back to time-sensitive for an unknown priority", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ ha_notify_priority: "loud" }) }).haNotifyPriority).toBe("time_sensitive");
  });

  it("keeps the reminder interval within 0..60 minutes", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ remind_every_minutes: -3 }) }).remindEveryMinutes).toBe(0);
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ remind_every_minutes: 500 }) }).remindEveryMinutes).toBe(60);
  });
});

describe("delivery date tracking", () => {
  it("is on by default and can be turned off", () => {
    expect(loadConfig({ OPTIONS_PATH: missing }).trackDeliveryDates).toBe(true);
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ track_delivery_dates: false }) }).trackDeliveryDates).toBe(false);
  });

  it("keeps delivery state next to the stock state", () => {
    expect(loadConfig({ OPTIONS_PATH: missing, STATE_PATH: "/tmp/x/state.json" }).deliveryStatePath).toBe("/tmp/x/delivery.json");
  });
});

describe("model dropdown", () => {
  it("offers exactly the generated models in config.yaml", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    const choices = /\n  models:\n    - "list\(([^\n]*)\)\?"/.exec(yaml)?.[1].split("|");
    expect(choices).toEqual(Object.keys(APPLE_SG_MODELS));
  });

  it("has every default model in the dropdown", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    const defaults = [...yaml.split("\nschema:")[0].split("\n  models:\n")[1].matchAll(/^    - "([^"]+)"$/gm)].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) expect(Object.keys(APPLE_SG_MODELS)).toContain(d);
  });
});
