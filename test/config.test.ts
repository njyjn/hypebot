import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
});
