import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { diffDelivery, formatDeliveryAlert, loadDeliveryState, runDeliveryCheck } from "../src/delivery.js";
import { deliveryUrl, parseDelivery } from "../src/sources/apple-sg.js";
import type { AlertMessage, DeliveryDate, Source } from "../src/types.js";
import { duoItem } from "./helpers.js";

const fixture = readFileSync(new URL("./fixtures/delivery-message.json", import.meta.url), "utf8");
const nightSky = duoItem("MK2G4X/A", "Night Sky 512GB");
const white = duoItem("MK2F4X/A", "Star White 512GB");
const withDate = (part: string, upper: string, label: string) => {
  const d = JSON.parse(fixture);
  const r = d.body.content.deliveryMessage[part].regular;
  r.deliveryOptionMessages[0].encodedUpperDateString = upper;
  r.deliveryOptions[0].date = label;
  return JSON.stringify(d);
};

describe("Apple SG delivery dates", () => {
  it("asks for every part's standard delivery quote in one request", () => {
    const url = decodeURIComponent(deliveryUrl(["A/A", "B/A"]));
    expect(url).toMatch(/^https:\/\/www\.apple\.com\/sg\/shop\/delivery-message\?/);
    expect(url).toContain("parts.0=A/A");
    expect(url).toContain("parts.1=B/A");
    expect(url).toContain("mt=regular");
  });

  it("reads the latest promised date and Apple's wording per model", () => {
    const dates = parseDelivery(fixture, [nightSky, white]);
    expect(dates.get(nightSky.id)).toEqual({ date: "2027-01-25", label: "Mon 25/01/2027" });
    expect(dates.get(white.id)).toEqual({ date: "2027-01-25", label: "Mon 25/01/2027" });
  });

  it("uses the end of a date range", () => {
    const dates = parseDelivery(withDate("MK2G4X/A", "20270118-20270125", "18/01 - 25/01/2027"), [nightSky]);
    expect(dates.get(nightSky.id)?.date).toBe("2027-01-25");
  });

  it("skips models Apple gives no date for", () => {
    expect(parseDelivery(fixture, [duoItem("ZZZZ1X/A", "Nope")]).size).toBe(0);
  });

  it("throws on a web page instead of data", () => {
    expect(() => parseDelivery("<!doctype html>Page Not Found", [nightSky])).toThrow();
  });
});

describe("diffDelivery", () => {
  const was: Record<string, DeliveryDate> = { [nightSky.id]: { date: "2027-01-25", label: "Mon 25/01/2027" } };

  it("reports a model whose date moved earlier", () => {
    const now = new Map([[nightSky.id, { date: "2027-01-18", label: "Mon 18/01/2027" }]]);
    expect(diffDelivery([nightSky], was, now)).toEqual([{ item: nightSky, from: was[nightSky.id], to: now.get(nightSky.id) }]);
  });

  it("ignores dates that stay the same or slip later", () => {
    expect(diffDelivery([nightSky], was, new Map([[nightSky.id, was[nightSky.id]]]))).toEqual([]);
    expect(diffDelivery([nightSky], was, new Map([[nightSky.id, { date: "2027-02-01", label: "Mon 01/02/2027" }]]))).toEqual([]);
  });

  it("does not alert on the first date it sees", () => {
    expect(diffDelivery([nightSky], {}, new Map([[nightSky.id, was[nightSky.id]]]))).toEqual([]);
  });
});

describe("formatDeliveryAlert", () => {
  it("lists each model's new date and the old one", () => {
    const m = formatDeliveryAlert([
      { item: nightSky, from: { date: "2027-01-25", label: "Mon 25/01/2027" }, to: { date: "2027-01-18", label: "Mon 18/01/2027" } },
    ]);
    expect(m.title).toBe("📦 iPhone Duo delivery moved earlier (Apple SG)");
    expect(m.lines).toEqual(["Night Sky 512GB: Mon 18/01/2027 (was Mon 25/01/2027)"]);
    expect(m.url).toBe(nightSky.buyUrl);
    expect(m.urgent).toBeFalsy();
  });
});

describe("runDeliveryCheck", () => {
  function setup() {
    const statePath = join(mkdtempSync(join(tmpdir(), "hb-")), "delivery.json");
    const sent: AlertMessage[] = [];
    const sensor = vi.fn(async () => {});
    let next: Map<string, DeliveryDate> | Error = new Map();
    const source: Source = {
      name: "apple_sg",
      label: "Apple SG",
      resolve: async () => [nightSky],
      check: async () => [],
      deliveryDates: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const run = (dates: Map<string, DeliveryDate> | Error) => {
      next = dates;
      return runDeliveryCheck({ groups: [{ source, items: [nightSky] }], notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }], statePath, sensor });
    };
    return { statePath, sent, sensor, run };
  }

  it("remembers dates, alerts when one moves earlier, and publishes the sensor", async () => {
    const s = setup();
    await s.run(new Map([[nightSky.id, { date: "2027-01-25", label: "Mon 25/01/2027" }]]));
    expect(s.sent).toEqual([]);
    expect(loadDeliveryState(s.statePath)).toEqual({ [nightSky.id]: { date: "2027-01-25", label: "Mon 25/01/2027" } });

    await s.run(new Map([[nightSky.id, { date: "2027-01-18", label: "Mon 18/01/2027" }]]));
    expect(s.sent.map((m) => m.title)).toEqual(["📦 iPhone Duo delivery moved earlier (Apple SG)"]);
    expect(loadDeliveryState(s.statePath)[nightSky.id].date).toBe("2027-01-18");
    expect(s.sensor).toHaveBeenCalledTimes(2);
  });

  it("logs and carries on when Apple refuses the request", async () => {
    const s = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(s.run(new Error("Apple SG returned HTTP 541"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(s.sent).toEqual([]);
    expect(s.sensor).not.toHaveBeenCalled();
  });
});
