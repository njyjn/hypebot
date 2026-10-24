import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/http.js", () => ({ USER_AGENT: "test", fetchText: vi.fn() }));

import { fetchText } from "../src/http.js";
import { createAppleSg, matchVariant, parseCatalogue, variantLabel } from "../src/sources/apple-sg.js";

const html = readFileSync(new URL("./fixtures/apple-sg-duo-buy.html", import.meta.url), "utf8");
const cat = parseCatalogue(html);

describe("parseCatalogue", () => {
  it("finds all 8 iPhone Duo models with colour names and capacities", () => {
    expect(cat.productName).toBe("iPhone Duo");
    expect(cat.entries).toHaveLength(8);
    expect(cat.entries.find((e) => e.partNumber === "MK2G4X/A")).toEqual({
      partNumber: "MK2G4X/A",
      colourCode: "nightsky",
      colourName: "Night Sky",
      capacity: "512gb",
    });
  });

  it("formats a readable variant label", () => {
    const e = cat.entries.find((x) => x.partNumber === "MK2J4X/A")!;
    expect(variantLabel(e)).toBe("Night Sky 1TB");
  });
});

describe("matchVariant", () => {
  it.each([
    ["Star White / 512GB", "MK2F4X/A"],
    ["night sky/512", "MK2G4X/A"],
    ["White / 256GB", "MK2D4X/A"],
    ["black / 1TB", "MK2J4X/A"],
    ["Night Sky / 2 TB", "MK2L4X/A"],
  ])("matches %s to %s", (variant, part) => {
    expect(matchVariant(cat, variant).partNumber).toBe(part);
  });

  it("rejects an unknown colour and lists the valid options", () => {
    expect(() => matchVariant(cat, "Gold / 512GB")).toThrowError(/Star White \/ 256GB[\s\S]*Night Sky \/ 2TB/);
  });

  it("rejects a variant without a colour", () => {
    expect(() => matchVariant(cat, "512GB")).toThrow();
  });
});

describe("appleSg.resolve", () => {
  beforeEach(() => {
    vi.mocked(fetchText).mockReset();
    vi.mocked(fetchText).mockResolvedValue({ status: 200, body: html });
  });

  it("builds watch items with ids, names and buy URL", async () => {
    const items = await createAppleSg({ stores: [] }).resolve([
      { source: "apple_sg", product: "iphone-duo", variants: ["Night Sky / 512GB"] },
    ]);
    expect(fetchText).toHaveBeenCalledWith("https://www.apple.com/sg/shop/buy-iphone/iphone-duo");
    expect(items).toEqual([
      {
        id: "apple_sg:MK2G4X/A",
        source: "apple_sg",
        product: "iphone-duo",
        productName: "iPhone Duo",
        variantName: "Night Sky 512GB",
        partNumber: "MK2G4X/A",
        buyUrl: "https://www.apple.com/sg/shop/buy-iphone/iphone-duo",
      },
    ]);
  });

  it("collapses the same model listed twice into one item", async () => {
    const items = await createAppleSg({ stores: [] }).resolve([
      { source: "apple_sg", product: "iphone-duo", variants: ["Star White / 512GB", "Star White / 512GB", "white/512"] },
    ]);
    expect(items.map((i) => i.partNumber)).toEqual(["MK2F4X/A"]);
  });

  it("fails when the product page cannot be loaded", async () => {
    vi.mocked(fetchText).mockResolvedValue({ status: 404, body: "<!doctype html>Page Not Found" });
    await expect(
      createAppleSg({ stores: [] }).resolve([{ source: "apple_sg", product: "iphone-nope", variants: ["White / 256GB"] }]),
    ).rejects.toThrow(/iphone-nope/);
  });
});
