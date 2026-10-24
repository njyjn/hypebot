import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState, saveState } from "../src/state.js";
import { diffAvailability, FailureTracker } from "../src/watcher.js";
import type { Availability, WatchItem } from "../src/types.js";

const item: WatchItem = {
  id: "apple_sg:MK2G4X/A",
  source: "apple_sg",
  shop: "Apple SG",
  product: "iphone-duo",
  productName: "iPhone Duo",
  variantName: "Night Sky 512GB",
  partNumber: "MK2G4X/A",
  buyUrl: "https://www.apple.com/sg/shop/buy-iphone/iphone-duo",
  productUrl: "https://www.apple.com/sg/shop/buy-iphone/iphone-duo",
};
const at = (...names: string[]): Availability[] => [
  { itemId: item.id, stores: names.map((name) => ({ name, quote: "Available Today" })) },
];
const tmpPath = () => join(mkdtempSync(join(tmpdir(), "hb-")), "state.json");

describe("diffAvailability", () => {
  it("reports every store on the first run", () => {
    const c = diffAvailability([item], {}, at("Orchard Road", "Jewel Changi Airport"));
    expect(c.newlyInStock).toHaveLength(1);
    expect(c.newlyInStock[0].stores.map((s) => s.name)).toEqual(["Orchard Road", "Jewel Changi Airport"]);
    expect(c.next).toEqual({ [item.id]: ["Orchard Road", "Jewel Changi Airport"] });
  });

  it("reports only stores that were not in stock last time", () => {
    const c = diffAvailability([item], { [item.id]: ["Orchard Road"] }, at("Orchard Road", "Jewel Changi Airport"));
    expect(c.newlyInStock[0].stores.map((s) => s.name)).toEqual(["Jewel Changi Airport"]);
  });

  it("reports nothing when stock is unchanged", () => {
    const c = diffAvailability([item], { [item.id]: ["Orchard Road"] }, at("Orchard Road"));
    expect(c.newlyInStock).toEqual([]);
    expect(c.soldOut).toEqual([]);
  });

  it("does not re-alert after a restart while still in stock", () => {
    const path = tmpPath();
    saveState(path, diffAvailability([item], {}, at("Orchard Road")).next);
    const c = diffAvailability([item], loadState(path), at("Orchard Road"));
    expect(c.newlyInStock).toEqual([]);
  });

  it("reports a sell-out and clears the state", () => {
    const c = diffAvailability([item], { [item.id]: ["Orchard Road"] }, at());
    expect(c.soldOut).toEqual([item]);
    expect(c.next[item.id]).toEqual([]);
  });

  it("alerts again when stock comes back after selling out", () => {
    const soldOut = diffAvailability([item], { [item.id]: ["Orchard Road"] }, at()).next;
    expect(diffAvailability([item], soldOut, at("Orchard Road")).newlyInStock).toHaveLength(1);
  });
});

describe("state file", () => {
  it("starts empty when the file is missing", () => {
    expect(loadState(tmpPath())).toEqual({});
  });

  it("starts empty when the file is corrupt", () => {
    const path = tmpPath();
    writeFileSync(path, "{not json");
    expect(loadState(path)).toEqual({});
  });
});

describe("FailureTracker", () => {
  it("alerts once, on the 10th consecutive failure", () => {
    const f = new FailureTracker();
    for (let i = 0; i < 9; i++) expect(f.fail()).toBeNull();
    expect(f.fail()).toBe("alert");
    expect(f.fail()).toBeNull();
  });

  it("reports recovery only after an alert was sent", () => {
    const f = new FailureTracker();
    f.fail();
    expect(f.succeed()).toBeNull();
    for (let i = 0; i < 10; i++) f.fail();
    expect(f.succeed()).toBe("recovered");
    expect(f.succeed()).toBeNull();
  });

  it("doubles the wait after each failure up to 10 minutes, and resets on success", () => {
    const f = new FailureTracker();
    expect(f.delayMs(60_000)).toBe(60_000);
    f.fail();
    expect(f.delayMs(60_000)).toBe(120_000);
    f.fail();
    expect(f.delayMs(60_000)).toBe(240_000);
    for (let i = 0; i < 10; i++) f.fail();
    expect(f.delayMs(60_000)).toBe(600_000);
    f.succeed();
    expect(f.delayMs(60_000)).toBe(60_000);
  });

  it("never shortens an interval already longer than the cap", () => {
    const f = new FailureTracker();
    f.fail();
    expect(f.delayMs(3_600_000)).toBe(3_600_000);
  });
});
