import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/http.js", () => ({ USER_AGENT: "test", fetchText: vi.fn() }));

import { fetchText } from "../src/http.js";
import { createAppleSg, parsePickup, pickupUrl } from "../src/sources/apple-sg.js";
import type { WatchItem } from "../src/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const item = (partNumber: string, variantName = "Night Sky 512GB"): WatchItem => ({
  id: `apple_sg:${partNumber}`,
  source: "apple_sg",
  shop: "Apple SG",
  product: "iphone-duo",
  productName: "iPhone Duo",
  variantName,
  partNumber,
  buyUrl: "https://www.apple.com/sg/shop/buy-iphone/iphone-duo",
});

const nightSky512 = item("MK2G4X/A");
const duoItems = [item("MK2F4X/A", "Star White 512GB"), nightSky512, item("MK2D4X/A", "Star White 256GB")];

describe("pickupUrl", () => {
  it("asks for every part in one request near an SG postcode", () => {
    const url = decodeURIComponent(pickupUrl(["A/A", "B/A"]));
    expect(url).toMatch(/^https:\/\/www\.apple\.com\/sg\/shop\/retail\/pickup-message\?/);
    expect(url).toContain("pl=true");
    expect(url).toContain("location=238859");
    expect(url).toContain("parts.0=A/A");
    expect(url).toContain("parts.1=B/A");
  });
});

describe("parsePickup", () => {
  it("lists every store that has the item, with Apple's wording", () => {
    const [a] = parsePickup(fixture("pickup-available.json"), [nightSky512], []);
    expect(a.itemId).toBe("apple_sg:MK2G4X/A");
    expect(a.stores.map((s) => s.name)).toEqual(["Orchard Road", "Marina Bay Sands", "Jewel Changi Airport"]);
    expect(a.stores[0]).toEqual({ name: "Orchard Road", quote: "Available Today" });
  });

  it("reports no stores when nothing is available", () => {
    const result = parsePickup(fixture("pickup-unavailable.json"), duoItems, []);
    expect(result).toHaveLength(3);
    for (const a of result) expect(a.stores).toEqual([]);
  });

  it("keeps only the stores in the filter, ignoring case", () => {
    const [a] = parsePickup(fixture("pickup-available.json"), [nightSky512], ["orchard road"]);
    expect(a.stores.map((s) => s.name)).toEqual(["Orchard Road"]);
  });

  it("treats a part missing from one store as unavailable there", () => {
    const [a] = parsePickup(fixture("pickup-missing-part.json"), [nightSky512], []);
    expect(a.stores.map((s) => s.name)).toEqual(["Orchard Road", "Jewel Changi Airport"]);
  });

  it("returns every watched item even when Apple leaves one out", () => {
    const result = parsePickup(fixture("pickup-available.json"), [nightSky512, item("MK2F4X/A")], []);
    expect(result.map((a) => a.itemId)).toEqual(["apple_sg:MK2G4X/A", "apple_sg:MK2F4X/A"]);
    expect(result[1].stores).toEqual([]);
  });

  it("throws on Apple's HTML refusal page instead of stock data", () => {
    expect(() => parsePickup(fixture("pickup-blocked.html"), [nightSky512], [])).toThrow();
  });

  it("throws on JSON without a store list", () => {
    expect(() => parsePickup('{"head":{"status":"200"},"body":{"content":{}}}', [nightSky512], [])).toThrow();
  });
});

describe("appleSg.check", () => {
  beforeEach(() => vi.mocked(fetchText).mockReset());

  it("makes one request for all items and parses it", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 200, body: fixture("pickup-unavailable.json") });
    const result = await createAppleSg({ stores: [] }).check(duoItems);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
  });

  it("rejects when Apple answers with an error status", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 541, body: "" });
    await expect(createAppleSg({ stores: [] }).check(duoItems)).rejects.toThrow(/541/);
  });

  it("applies the store filter it was created with", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 200, body: fixture("pickup-available.json") });
    const [a] = await createAppleSg({ stores: ["Jewel Changi Airport"] }).check([nightSky512]);
    expect(a.stores.map((s) => s.name)).toEqual(["Jewel Changi Airport"]);
  });
});

describe("store filter typos", () => {
  beforeEach(() => vi.mocked(fetchText).mockReset());

  it("warns once, listing real store names, when a filter entry matches no store", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 200, body: fixture("pickup-available.json") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = createAppleSg({ stores: ["Orchard", "Jewel Changi Airport"] });
    await source.check([nightSky512]);
    await source.check([nightSky512]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/"Orchard"[\s\S]*Orchard Road, Marina Bay Sands, Jewel Changi Airport/);
    warn.mockRestore();
  });

  it("does not warn when every filter entry matches", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 200, body: fixture("pickup-available.json") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createAppleSg({ stores: ["orchard road"] }).check([nightSky512]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
