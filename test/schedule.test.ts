import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cooldownLeftMs, firstCheckDelayMs, loadSchedule, saveSchedule } from "../src/schedule.js";
import { loadModelCache, pickCachedModels, saveModelCache } from "../src/model-cache.js";
import { duoItem } from "./helpers.js";

const MIN = 60_000;
const now = Date.parse("2026-10-27T06:00:00Z");

describe("firstCheckDelayMs", () => {
  it("waits out the rest of the interval after a quick restart", () => {
    expect(firstCheckDelayMs({ lastStockCheckAt: now - 30_000 }, now, 90_000)).toBe(60_000);
  });
  it("checks straight away after a long gap or on first run", () => {
    expect(firstCheckDelayMs({ lastStockCheckAt: now - 10 * MIN }, now, 90_000)).toBe(0);
    expect(firstCheckDelayMs({}, now, 90_000)).toBe(0);
  });
  it("also waits out a cool-down saved before the restart", () => {
    expect(firstCheckDelayMs({ lastStockCheckAt: now - 10 * MIN, cooldownUntil: { apple_sg: now + 20 * MIN } }, now, 90_000)).toBe(20 * MIN);
  });
});

describe("cooldownLeftMs", () => {
  it("is the time left for that shop, or 0", () => {
    const s = { cooldownUntil: { apple_sg: now + 5 * MIN } };
    expect(cooldownLeftMs(s, "apple_sg", now)).toBe(5 * MIN);
    expect(cooldownLeftMs(s, "apple_sg", now + 6 * MIN)).toBe(0);
    expect(cooldownLeftMs(s, "other", now)).toBe(0);
  });
});

describe("schedule.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-"));
  it("round-trips and starts empty when missing or garbage", () => {
    const path = join(dir, "schedule.json");
    const s = { lastStockCheckAt: now, deliveryCheckedAt: now - MIN, cooldownUntil: { apple_sg: now + MIN }, blindAlerted: { apple_sg: true } };
    saveSchedule(path, s);
    expect(loadSchedule(path)).toEqual(s);
    expect(loadSchedule(join(dir, "nope.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{");
    expect(loadSchedule(join(dir, "bad.json"))).toEqual({});
  });
});

describe("model cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  const entries = [{ source: "apple_sg", product: "iphone-duo", variants: ["Night Sky / 512GB"] }];
  const items = [duoItem("MK2G4X/A", "Night Sky 512GB")];

  it("reuses a fresh list for the same settings", () => {
    const path = join(dir, "models.json");
    saveModelCache(path, { apple_sg: { entries, items, at: now - 60 * MIN } });
    const cache = loadModelCache(path);
    expect(pickCachedModels(cache, "apple_sg", entries, now)).toEqual({ items, at: now - 60 * MIN });
  });

  it("ignores it when the settings changed or it is over 6 hours old", () => {
    const cache = { apple_sg: { entries, items, at: now - 60 * MIN } };
    const changed = [{ ...entries[0], variants: ["Star White / 512GB"] }];
    expect(pickCachedModels(cache, "apple_sg", changed, now)).toBeUndefined();
    expect(pickCachedModels({ apple_sg: { ...cache.apple_sg, at: now - 7 * 60 * MIN } }, "apple_sg", entries, now)).toBeUndefined();
    expect(pickCachedModels(cache, "other", entries, now)).toBeUndefined();
  });

  it("starts empty when the file is missing or garbage", () => {
    expect(loadModelCache(join(dir, "nope.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "[");
    expect(loadModelCache(join(dir, "bad.json"))).toEqual({});
  });
});
