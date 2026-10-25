import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyMood, loadMood, moodLabel, prune, saveMood, score24h } from "../src/mood/store.js";

const H = 3_600_000;
const now = Date.parse("2026-10-25T12:00:00Z");
const batch = (hoursAgo: number, score: number, items: number) => ({ at: now - hoursAgo * H, score, items, themes: [] });

describe("score24h", () => {
  it("weights each batch by its item count and ignores batches older than 24h", () => {
    const s = { ...emptyMood(), batches: [batch(25, 1, 100), batch(10, 0.5, 10), batch(1, -0.5, 30)] };
    expect(score24h(s, now)).toEqual({ score: -0.25, items: 40 });
  });

  it("is undefined when nothing was analysed in the last 24h", () => {
    expect(score24h({ ...emptyMood(), batches: [batch(30, 0.5, 10)] }, now)).toBeUndefined();
    expect(score24h(emptyMood(), now)).toBeUndefined();
  });
});

describe("moodLabel", () => {
  it("uses ±0.2 as the boundaries", () => {
    expect(moodLabel(-0.21)).toBe("negative");
    expect(moodLabel(-0.2)).toBe("mixed");
    expect(moodLabel(0.2)).toBe("mixed");
    expect(moodLabel(0.21)).toBe("positive");
  });
});

describe("prune", () => {
  it("keeps 48h of batches and 7 days of seen ids", () => {
    const s = { ...emptyMood(), batches: [batch(49, 0, 1), batch(47, 0, 1)], seen: { old: now - 8 * 24 * H, fresh: now - 6 * 24 * H } };
    prune(s, now);
    expect(s.batches.map((b) => b.at)).toEqual([now - 47 * H]);
    expect(Object.keys(s.seen)).toEqual(["fresh"]);
  });
});

describe("loadMood / saveMood", () => {
  const dir = mkdtempSync(join(tmpdir(), "mood-"));

  it("round-trips the state", () => {
    const path = join(dir, "mood.json");
    const s = { ...emptyMood(), batches: [batch(1, 0.3, 4)], seen: { a: now }, lastDigestDate: "2026-10-24", failuresInARow: 2, alerted: true };
    saveMood(path, s);
    expect(loadMood(path)).toEqual(s);
  });

  it("starts empty when the file is missing or garbage", () => {
    expect(loadMood(join(dir, "nope.json"))).toEqual(emptyMood());
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(loadMood(bad)).toEqual(emptyMood());
  });
});
