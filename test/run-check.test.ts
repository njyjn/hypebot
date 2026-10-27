import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadState } from "../src/state.js";
import { FailureTracker, runCheck, type Ctx } from "../src/watcher.js";
import { emptySummary, loadSummary } from "../src/summary.js";
import { loadSchedule } from "../src/schedule.js";
import type { AlertMessage, Availability, Source } from "../src/types.js";
import { duoItem } from "./helpers.js";

const item = duoItem("MK2G4X/A", "Night Sky 512GB");

function ctx(results: (Availability[] | Error)[], opts: { notifySoldOut?: boolean; notifyMode?: "instant" | "daily_summary" } = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), "hb-")), "state.json");
  const cfg = { ...loadConfig({ OPTIONS_PATH: "/nonexistent" }), statePath, notifySoldOut: opts.notifySoldOut ?? false, remindEveryMinutes: 1, notifyMode: opts.notifyMode ?? "instant" };
  const sent: AlertMessage[] = [];
  const sensors = vi.fn(async () => {});
  const source: Source = {
    name: "apple_sg",
    label: "Apple SG",
    resolve: async () => [item],
    check: async () => {
      const r = results.shift();
      if (r instanceof Error || r === undefined) throw r ?? new Error("no more results");
      return r;
    },
  };
  const c: Ctx = {
    cfg,
    groups: [{ source, items: [item], failures: new FailureTracker() }],
    notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }],
    state: {},
    sensors,
    summary: { log: emptySummary(), path: join(statePath, "..", "summary.json") },
    schedule: { data: {}, path: join(statePath, "..", "schedule.json") },
  };
  return { c, sent, sensors, statePath };
}

const inStock: Availability[] = [{ itemId: item.id, stores: [{ name: "Orchard Road", quote: "Available Today" }] }];
const none: Availability[] = [{ itemId: item.id, stores: [] }];

describe("runCheck", () => {
  it("alerts on new stock, saves state and updates sensors", async () => {
    const { c, sent, sensors, statePath } = ctx([inStock]);
    await runCheck(c);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("🟢 iPhone Duo in stock (Apple SG)");
    expect(loadState(statePath)).toEqual({ [item.id]: ["Orchard Road"] });
    expect(sensors).toHaveBeenCalledWith([item], inStock);
  });

  it("does not alert twice for the same stock", async () => {
    const { c, sent } = ctx([inStock, inStock]);
    await runCheck(c);
    await runCheck(c);
    expect(sent).toHaveLength(1);
  });

  it("leaves state and sensors alone when the check fails", async () => {
    const { c, sent, sensors, statePath } = ctx([new Error("HTTP 541")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    err.mockRestore();
    expect(sent).toEqual([]);
    expect(sensors).not.toHaveBeenCalled();
    expect(loadState(statePath)).toEqual({});
  });

  it("alerts once when no check has worked for 30 minutes, and once on recovery", async () => {
    const { c, sent } = ctx([...Array.from({ length: 8 }, () => new Error("timeout")), none]);
    let clock = Date.parse("2026-10-27T06:00:00Z");
    c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 8; i++) {
      await runCheck(c);
      clock += 5 * 60_000; // 0, 5, ... 35 minutes of failures
    }
    await runCheck(c);
    err.mockRestore();
    const titles = sent.map((m) => m.title);
    expect(titles.filter((t) => t.startsWith("⚠️ HypeBot is blind"))).toHaveLength(1);
    expect(titles.at(-1)).toBe("✅ HypeBot is back to normal");
    const blind = sent.find((m) => m.title.startsWith("⚠️ HypeBot is blind"))!;
    expect(blind.title).toBe("⚠️ HypeBot is blind: Apple SG has refused every check for 30 minutes");
    expect(blind.lines[0]).toContain("timeout");
  });

  it("keeps counting the 30 minutes across a restart", async () => {
    const first = ctx([new Error("timeout")]);
    let clock = Date.parse("2026-10-27T06:00:00Z");
    first.c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(first.c);

    const second = ctx([new Error("timeout")]);
    second.c.schedule = first.c.schedule; // new process, same saved schedule
    clock += 31 * 60_000;
    second.c.now = () => clock;
    await runCheck(second.c);
    err.mockRestore();
    expect(second.sent.map((m) => m.title)).toContain("⚠️ HypeBot is blind: Apple SG has refused every check for 30 minutes");
  });

  it("does not re-send the blind alert after a restart", async () => {
    const first = ctx([new Error("timeout"), new Error("timeout")]);
    let clock = Date.parse("2026-10-27T06:00:00Z");
    first.c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(first.c);
    clock += 31 * 60_000;
    await runCheck(first.c);
    expect(first.sent.filter((m) => m.title.startsWith("⚠️ HypeBot is blind"))).toHaveLength(1);

    // Same schedule and health, new process.
    const second = ctx([new Error("timeout")]);
    second.c.now = () => clock + 5 * 60_000;
    second.c.schedule = first.c.schedule;
    second.c.groups[0].health = first.c.groups[0].health;
    await runCheck(second.c);
    err.mockRestore();
    expect(second.sent.filter((m) => m.title.startsWith("⚠️ HypeBot is blind"))).toHaveLength(0);
  });

  it("stays quiet on a sell-out unless notify_sold_out is on", async () => {
    const quiet = ctx([inStock, none]);
    await runCheck(quiet.c);
    await runCheck(quiet.c);
    expect(quiet.sent).toHaveLength(1);

    const loud = ctx([inStock, none], { notifySoldOut: true });
    await runCheck(loud.c);
    await runCheck(loud.c);
    expect(loud.sent.map((m) => m.title)).toEqual(["🟢 iPhone Duo in stock (Apple SG)", "⚪ iPhone Duo sold out (Apple SG)"]);
  });
});

describe("runCheck with several shops", () => {
  it("keeps alerting for one shop while another is failing, and keeps the failing shop's state", async () => {
    const other = { ...duoItem("X1", "Red 128GB", "phone-x", "Phone X"), id: "other:X1", source: "other", shop: "Other Shop" };
    const statePath = join(mkdtempSync(join(tmpdir(), "hb-")), "state.json");
    const cfg = { ...loadConfig({ OPTIONS_PATH: "/nonexistent" }), statePath };
    const sent: AlertMessage[] = [];
    const ok: Source = { name: "apple_sg", label: "Apple SG", resolve: async () => [item], check: async () => inStock };
    const broken: Source = { name: "other", label: "Other Shop", resolve: async () => [other], check: async () => Promise.reject(new Error("down")) };
    const c: Ctx = {
      cfg,
      groups: [
        { source: ok, items: [item], failures: new FailureTracker() },
        { source: broken, items: [other], failures: new FailureTracker() },
      ],
      notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }],
      state: { [other.id]: ["Somewhere"] },
      sensors: async () => {},
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    err.mockRestore();
    expect(sent.map((m) => m.title)).toEqual(["🟢 iPhone Duo in stock (Apple SG)"]);
    expect(loadState(statePath)).toEqual({ [item.id]: ["Orchard Road"], [other.id]: ["Somewhere"] });
  });
});

describe("reminders while still in stock", () => {
  function remindCtx(remindEveryMinutes: number, results: Availability[][]) {
    const base = ctx(results as (Availability[] | Error)[]);
    base.c.cfg = { ...base.c.cfg, remindEveryMinutes };
    let clock = 0;
    base.c.now = () => clock;
    return { ...base, advance: (minutes: number) => (clock += minutes * 60_000) };
  }

  it("re-alerts once the reminder interval has passed and the model is still in stock", async () => {
    const r = remindCtx(5, [inStock, inStock, inStock]);
    await runCheck(r.c);
    r.advance(3);
    await runCheck(r.c);
    r.advance(2);
    await runCheck(r.c);
    expect(r.sent.map((m) => m.title)).toEqual(["🟢 iPhone Duo in stock (Apple SG)", "🔁 Still in stock: iPhone Duo (Apple SG)"]);
    expect(r.sent[1].urgent).toBe(true);
    expect(r.sent[1].url).toBe(item.buyUrl);
  });

  it("stops reminding once it sells out", async () => {
    const r = remindCtx(1, [inStock, none, none]);
    await runCheck(r.c);
    r.advance(1);
    await runCheck(r.c);
    r.advance(1);
    await runCheck(r.c);
    expect(r.sent).toHaveLength(1);
  });

  it("never reminds when reminders are off", async () => {
    const r = remindCtx(0, [inStock, inStock]);
    await runCheck(r.c);
    r.advance(30);
    await runCheck(r.c);
    expect(r.sent).toHaveLength(1);
  });
});

describe("health reporting", () => {
  it("publishes health after both successful and failed checks", async () => {
    const { c } = ctx([inStock, new Error("Apple SG returned HTTP 541")]);
    const published: { state: string; failures: number }[] = [];
    c.healthSensor = async (_g, s) => void published.push({ state: s.state, failures: s.failures });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    await runCheck(c);
    err.mockRestore();
    expect(published).toEqual([
      { state: "ok", failures: 0 },
      { state: "ok", failures: 1 },
    ]);
  });

  it("alerts once when Apple refuses a large share of checks, and once when it clears", async () => {
    const results: (Availability[] | Error)[] = [];
    for (let i = 0; i < 10; i++) results.push(i % 2 === 0 ? none : new Error("Apple SG did not return stock data (got a web page instead)"));
    for (let i = 0; i < 70; i++) results.push(none);
    const { c, sent } = ctx(results);
    let clock = 0;
    c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 80; i++) {
      await runCheck(c);
      clock += 60_000;
    }
    err.mockRestore();
    expect(sent.map((m) => m.title)).toEqual(["⚠️ Apple SG is refusing some checks", "✅ Apple SG checks are healthy again"]);
    expect(sent[0].lines[0]).toMatch(/50% of checks in the last hour failed/);
  });
});

describe("health persistence in runCheck", () => {
  it("saves health at most every 5 minutes, including after failed checks", async () => {
    const { loadHealth } = await import("../src/health.js");
    const { c } = ctx([new Error("Apple SG did not return stock data (got a web page instead)"), none, none]);
    const healthPath = join(mkdtempSync(join(tmpdir(), "hb-")), "health.json");
    c.healthStatePath = healthPath;
    let clock = 0;
    c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    err.mockRestore();
    expect(loadHealth(healthPath).apple_sg.summary(clock, 1).failures).toBe(1);

    clock += 60_000;
    await runCheck(c);
    expect(loadHealth(healthPath).apple_sg.summary(clock, 0).checks).toBe(1); // not saved again yet

    clock += 5 * 60_000;
    await runCheck(c);
    expect(loadHealth(healthPath).apple_sg.summary(clock, 0).checks).toBe(3);
  });
});


describe("runCheck in daily_summary mode", () => {
  it("logs drops instead of alerting, and sends no reminders or sold-out notes", async () => {
    const { c, sent, sensors, statePath } = ctx([inStock, inStock, none], { notifyMode: "daily_summary", notifySoldOut: true });
    let clock = Date.parse("2026-10-26T13:53:37Z");
    c.now = () => clock;
    await runCheck(c);
    clock += 2 * 60_000; // past remind_every_minutes
    await runCheck(c);
    clock += 90_000;
    await runCheck(c);
    expect(sent).toEqual([]);
    expect(sensors).toHaveBeenCalledTimes(3); // data collection carries on
    const saved = loadSummary(join(statePath, "..", "summary.json"));
    expect(saved.drops).toEqual([{ itemId: item.id, label: "Night Sky 512GB", store: "Orchard Road", start: Date.parse("2026-10-26T13:53:37Z"), end: clock }]);
  });

  it("still sends the blind alert instantly", async () => {
    const { c, sent } = ctx(Array(3).fill(new Error("timeout")), { notifyMode: "daily_summary" });
    let clock = 0;
    c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      await runCheck(c);
      clock += 16 * 60_000;
    }
    err.mockRestore();
    expect(sent.map((m) => m.title)).toContain("⚠️ HypeBot is blind: Apple SG has refused every check for 30 minutes");
  });
});

describe("cool-down after Apple's 541", () => {
  it("pauses that shop for 30 minutes and saves it", async () => {
    const { c, statePath } = ctx([new Error("Apple SG returned HTTP 541"), inStock]);
    const check = vi.spyOn(c.groups[0].source, "check");
    let clock = Date.parse("2026-10-27T06:00:00Z");
    c.now = () => clock;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    expect(loadSchedule(join(statePath, "..", "schedule.json")).cooldownUntil).toEqual({ apple_sg: clock + 30 * 60_000 });

    clock += 10 * 60_000;
    await runCheck(c); // still cooling down: Apple is not asked
    expect(check).toHaveBeenCalledTimes(1);

    clock += 21 * 60_000;
    await runCheck(c);
    err.mockRestore();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps the normal backoff for other errors", async () => {
    const { c } = ctx([new Error("Apple SG did not return stock data (got a web page instead)")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCheck(c);
    err.mockRestore();
    expect(c.schedule!.data.cooldownUntil ?? {}).toEqual({});
  });

  it("records when the last stock check ran", async () => {
    const { c } = ctx([none]);
    c.now = () => 1_000_000;
    await runCheck(c);
    expect(c.schedule!.data.lastStockCheckAt).toBe(1_000_000);
  });
});
