import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearReported, emptySummary, formatSummary, loadSummary, recordAvailability, recordDeliveryChanges, saveSummary } from "../src/summary.js";
import { duoItem } from "./helpers.js";

const tz = "Asia/Singapore";
const at = (hhmmss: string, day = "2026-10-26") => Date.parse(`${day}T${hhmmss}+08:00`);
const white = duoItem("MK2F4X/A", "Star White 512GB");
const black = duoItem("MK2G4X/A", "Night Sky 512GB");
const avail = (item: typeof white, ...stores: string[]) => ({ itemId: item.id, stores: stores.map((name) => ({ name, quote: "Available Today" })) });

describe("recordAvailability", () => {
  it("opens a drop per new store and closes it when the store sells out", () => {
    const log = emptySummary();
    expect(recordAvailability(log, [white, black], [avail(white, "Orchard Road"), avail(black)], at("21:53:37"))).toBe(true);
    expect(log.drops).toEqual([{ itemId: white.id, label: "Star White 512GB", store: "Orchard Road", start: at("21:53:37") }]);

    expect(recordAvailability(log, [white, black], [avail(white, "Orchard Road"), avail(black)], at("21:54:20"))).toBe(false);
    expect(log.drops).toHaveLength(1);

    recordAvailability(log, [white, black], [avail(white), avail(black)], at("21:55:03"));
    expect(log.drops[0].end).toBe(at("21:55:03"));
  });

  it("tracks each store on its own", () => {
    const log = emptySummary();
    recordAvailability(log, [white], [avail(white, "Orchard Road", "Marina Bay Sands")], at("10:00:00"));
    recordAvailability(log, [white], [avail(white, "Marina Bay Sands")], at("10:02:00"));
    expect(log.drops.map((d) => [d.store, d.end])).toEqual([
      ["Orchard Road", at("10:02:00")],
      ["Marina Bay Sands", undefined],
    ]);
  });

  it("ignores items that were not checked this time", () => {
    const log = emptySummary();
    recordAvailability(log, [white], [avail(white, "Orchard Road")], at("10:00:00"));
    recordAvailability(log, [], [], at("10:02:00")); // the shop failed to answer
    expect(log.drops[0].end).toBeUndefined();
  });
});

describe("formatSummary", () => {
  it("lists drops with time, store and how long they lasted", () => {
    const log = emptySummary();
    recordAvailability(log, [white, black], [avail(white, "Orchard Road"), avail(black, "Jewel Changi Airport")], at("21:53:37"));
    recordAvailability(log, [white, black], [avail(white), avail(black, "Jewel Changi Airport")], at("21:55:03"));
    recordDeliveryChanges(log, [{ item: black, from: { date: "2027-01-25", label: "Mon 25/01/2027" }, to: { date: "2027-01-18", label: "Mon 18/01/2027" } }], at("12:00:00"));
    expect(formatSummary(log, at("21:00:00", "2026-10-27"), tz)).toEqual([
      "Stock: 2 drops",
      "• 26 Oct 21:53 Star White 512GB, Orchard Road (~1 min)",
      "• 26 Oct 21:53 Night Sky 512GB, Jewel Changi Airport (still in stock)",
      "Delivery: Night Sky 512GB now Mon 18/01/2027 (was Mon 25/01/2027)",
    ]);
  });

  it("leaves out the date for today's drops and shows long drops in hours", () => {
    const log = emptySummary();
    recordAvailability(log, [white], [avail(white, "Orchard Road")], at("09:00:00"));
    recordAvailability(log, [white], [avail(white)], at("11:05:00"));
    expect(formatSummary(log, at("21:00:00"), tz)).toEqual(["Stock: 1 drop", "• 09:00 Star White 512GB, Orchard Road (~2 h 5 min)"]);
  });

  it("says so when nothing dropped", () => {
    expect(formatSummary(emptySummary(), at("21:00:00"), tz)).toEqual(["Stock: no drops today"]);
  });

  it("lists at most 20 drops", () => {
    const log = emptySummary();
    for (let i = 0; i < 25; i++) {
      recordAvailability(log, [white], [avail(white, "Orchard Road")], at("10:00:00") + i * 120_000);
      recordAvailability(log, [white], [avail(white)], at("10:01:00") + i * 120_000);
    }
    const lines = formatSummary(log, at("21:00:00"), tz);
    expect(lines[0]).toBe("Stock: 25 drops");
    expect(lines).toHaveLength(22);
    expect(lines[21]).toBe("…and 5 more");
  });
});

describe("clearReported", () => {
  it("drops reported events but keeps drops still in stock", () => {
    const log = emptySummary();
    recordAvailability(log, [white, black], [avail(white, "Orchard Road"), avail(black, "Orchard Road")], at("10:00:00"));
    recordAvailability(log, [white, black], [avail(white), avail(black, "Orchard Road")], at("10:02:00"));
    recordDeliveryChanges(log, [{ item: black, from: { date: "2027-01-25", label: "a" }, to: { date: "2027-01-18", label: "b" } }], at("12:00:00"));
    clearReported(log);
    expect(log.drops.map((d) => d.label)).toEqual(["Night Sky 512GB"]);
    expect(log.delivery).toEqual([]);
  });
});

describe("loadSummary / saveSummary", () => {
  const dir = mkdtempSync(join(tmpdir(), "summary-"));

  it("round-trips the log", () => {
    const path = join(dir, "summary.json");
    const log = emptySummary();
    recordAvailability(log, [white], [avail(white, "Orchard Road")], at("10:00:00"));
    log.lastSentDate = "2026-10-25";
    saveSummary(path, log);
    expect(loadSummary(path)).toEqual(log);
  });

  it("starts empty when the file is missing or garbage", () => {
    expect(loadSummary(join(dir, "nope.json"))).toEqual(emptySummary());
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "[1,2");
    expect(loadSummary(bad)).toEqual(emptySummary());
  });
});
