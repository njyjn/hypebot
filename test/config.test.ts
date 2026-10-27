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

  it("keeps health state next to the stock state", () => {
    expect(loadConfig({ OPTIONS_PATH: missing, STATE_PATH: "/tmp/x/state.json" }).healthStatePath).toBe("/tmp/x/health.json");
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

describe("mood settings", () => {
  it("defaults to off with the spec's defaults", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.mood).toEqual({
      enabled: false,
      aiTaskEntity: "ai_task.claude_ai_task",
      subreddits: ["iPhoneDuo"],
      newsQuery: "iPhone Duo",
      digestTime: "21:00",
      redditClientId: "",
      redditClientSecret: "",
    });
    expect(cfg.moodStatePath).toBe("/data/mood.json");
  });

  it("reads the options and strips r/ from subreddit names", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({
        mood_enabled: true,
        mood_ai_task_entity: "ai_task.openai_ai_task",
        mood_subreddits: ["r/iPhoneDuo", "/r/apple/", "  "],
        mood_news_query: "iPhone Duo Singapore",
        mood_digest_time: "07:30",
        reddit_client_id: "id",
        reddit_client_secret: "sec",
      }),
    });
    expect(cfg.mood).toEqual({
      enabled: true,
      aiTaskEntity: "ai_task.openai_ai_task",
      subreddits: ["iPhoneDuo", "apple"],
      newsQuery: "iPhone Duo Singapore",
      digestTime: "07:30",
      redditClientId: "id",
      redditClientSecret: "sec",
    });
  });

  it("falls back to 21:00 for a bad digest time, with a warning", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ mood_digest_time: "9pm" }) });
    expect(cfg.mood.digestTime).toBe("21:00");
    expect(cfg.warnings.join(" ")).toMatch(/mood_digest_time/);
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ mood_digest_time: "25:00" }) }).mood.digestTime).toBe("21:00");
  });

  it("warns and uses RSS when only one Reddit field is set, without printing it", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ reddit_client_id: "abc123" }) });
    expect(cfg.mood.redditClientId).toBe("");
    expect(cfg.mood.redditClientSecret).toBe("");
    expect(cfg.warnings.join(" ")).toMatch(/reddit_client_secret/);
    expect(cfg.warnings.join(" ")).not.toContain("abc123");
  });

  it("mood_news_enabled: false turns news off", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ mood_news_enabled: false, mood_news_query: "iPhone Duo" }) }).mood.newsQuery).toBe("");
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ mood_news_enabled: true }) }).mood.newsQuery).toBe("iPhone Duo");
  });

  it("an empty news query turns news off", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ mood_news_query: "" }) }).mood.newsQuery).toBe("");
  });

  it("config.yaml has every mood option with matching defaults", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    for (const line of ["mood_enabled: false", "mood_news_enabled: true", "mood_news_enabled: \"bool?\"", "mood_ai_task_entity: ai_task.claude_ai_task", "mood_news_query: \"iPhone Duo\"", "mood_digest_time: \"21:00\"", "reddit_client_secret: \"password?\""]) {
      expect(yaml).toContain(line);
    }
    expect(yaml).toMatch(/mood_subreddits:\n    - iPhoneDuo/);
  });
});

describe("notify_mode", () => {
  it("defaults to instant and reads daily_summary", () => {
    expect(loadConfig({ OPTIONS_PATH: missing }).notifyMode).toBe("instant");
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ notify_mode: "daily_summary" }) }).notifyMode).toBe("daily_summary");
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ notify_mode: "loud" }) }).notifyMode).toBe("instant");
  });

  it("is in config.yaml", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    expect(yaml).toContain("notify_mode: instant");
    expect(yaml).toContain('notify_mode: "list(instant|daily_summary)?"');
  });

  it("puts summary.json next to the state file", () => {
    expect(loadConfig({ OPTIONS_PATH: missing }).summaryStatePath).toBe("/data/summary.json");
  });
});

describe("config.yaml schema", () => {
  // Options added after the first release must be optional: settings saved
  // before they existed don't have them, and Home Assistant then refuses to save.
  it("marks every option added after 0.1 as optional", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    const schema = yaml.slice(yaml.indexOf("\nschema:"));
    for (const key of ["remind_every_minutes", "track_delivery_dates", "ha_notify_priority", "notify_mode", "mood_enabled", "mood_ai_task_entity", "mood_news_enabled", "mood_digest_time"]) {
      expect(schema).toMatch(new RegExp(`\\n  ${key}: "[^"]*\\?"`));
    }
  });

  it("falls back to defaults when those options are missing", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ interval_seconds: 75 }) });
    expect(cfg.notifyMode).toBe("instant");
    expect(cfg.haNotifyPriority).toBe("time_sensitive");
    expect(cfg.trackDeliveryDates).toBe(true);
    expect(cfg.remindEveryMinutes).toBe(0);
    expect(cfg.mood).toMatchObject({ enabled: false, aiTaskEntity: "ai_task.claude_ai_task", newsQuery: "iPhone Duo", digestTime: "21:00" });
  });
});

describe("message routing settings", () => {
  const ALL = ["stock", "delivery", "digest", "status", "test"];

  it("defaults every destination to every kind", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.telegramMessages).toEqual(ALL);
    expect(cfg.slackMessages).toEqual(ALL);
    expect(cfg.haNotifyMessages).toEqual(ALL);
  });

  it("treats an empty list as every kind", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ telegram_messages: [] }) }).telegramMessages).toEqual(ALL);
  });

  it("reads the lists and drops unknown kinds", () => {
    const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ telegram_messages: ["stock", "delivery", "bogus"] }) });
    expect(cfg.telegramMessages).toEqual(["stock", "delivery"]);
  });

  it("warns when a kind reaches no configured destination", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({ telegram_bot_token: "t", telegram_chat_id: "-100123", telegram_messages: ["stock", "delivery"] }),
    });
    const w = cfg.warnings.join(" | ");
    expect(w).toMatch(/status messages go to no destination/);
    expect(w).toMatch(/digest messages go to no destination/);
    expect(w).not.toMatch(/stock messages go to no destination/);
  });

  it("does not warn when another destination takes the kind", () => {
    const cfg = loadConfig({
      OPTIONS_PATH: optionsFile({ telegram_bot_token: "t", telegram_chat_id: "-100123", telegram_messages: ["stock"], ha_notify_service: "notify.x" }),
    });
    expect(cfg.warnings.join(" | ")).not.toMatch(/go to no destination/);
  });

  it("are optional in config.yaml", () => {
    const yaml = readText(new URL("../config.yaml", import.meta.url), "utf8");
    for (const key of ["telegram_messages", "slack_messages", "ha_notify_messages"]) {
      expect(yaml).toMatch(new RegExp(`\\n  ${key}:\\n    - "list\\(stock\\|delivery\\|digest\\|status\\|test\\)\\?"`));
    }
  });
});

describe("restart state files", () => {
  it("live next to the state file", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.schedulePath).toBe("/data/schedule.json");
    expect(cfg.modelCachePath).toBe("/data/models.json");
  });
});

describe("proxy_url", () => {
  it("keeps a valid http proxy and normalises it", () => {
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ proxy_url: "http://abc-proton-proxy:8888" }) }).proxyUrl).toBe("http://abc-proton-proxy:8888");
    expect(loadConfig({ OPTIONS_PATH: optionsFile({ proxy_url: "HTTP://abc-proton-proxy:8888/" }) }).proxyUrl).toBe("http://abc-proton-proxy:8888");
  });

  it("ignores other schemes and garbage with a warning", () => {
    for (const bad of ["socks5://x:1080", "not a url", "http://abcd-proton-proxy"]) {
      const cfg = loadConfig({ OPTIONS_PATH: optionsFile({ proxy_url: bad }) });
      expect(cfg.proxyUrl).toBeUndefined();
      expect(cfg.warnings.join(" ")).toMatch(/proxy_url/);
    }
  });

  it("is off and quiet when missing, and optional in config.yaml", () => {
    const cfg = loadConfig({ OPTIONS_PATH: missing });
    expect(cfg.proxyUrl).toBeUndefined();
    expect(cfg.warnings.join(" ")).not.toMatch(/proxy_url/);
    expect(readText(new URL("../config.yaml", import.meta.url), "utf8")).toContain('proxy_url: "str?"');
  });
});
