import { afterEach, describe, expect, it, vi } from "vitest";
import { sensorId, updateDeliverySensor, updateHealthSensor, updateSensors } from "../src/ha-sensors.js";
import { duoItem, fakeServer } from "./helpers.js";

const nightSky = duoItem("MK2G4X/A", "Night Sky 512GB");
const white = duoItem("MK2D4X/A", "Star White 256GB");
const checkedAt = new Date("2026-10-24T05:00:00Z");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("sensorId", () => {
  it("slugifies product and variant", () => {
    expect(sensorId(nightSky)).toBe("sensor.hypebot_iphone_duo_night_sky_512gb");
  });
});

describe("updateSensors", () => {
  it("writes one sensor per item with stock details", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateSensors(
      [nightSky, white],
      [
        { itemId: nightSky.id, stores: [{ name: "Orchard Road", quote: "Available Today" }] },
        { itemId: white.id, stores: [] },
      ],
      { token: "sup", apiBase: s.base, checkedAt },
    );
    expect(s.requests.map((r) => r.url)).toEqual([
      "/states/sensor.hypebot_iphone_duo_night_sky_512gb",
      "/states/sensor.hypebot_iphone_duo_star_white_256gb",
    ]);
    expect(s.requests[0].headers.authorization).toBe("Bearer sup");
    expect(s.requests[0].body).toEqual({
      state: "in_stock",
      attributes: {
        friendly_name: "HypeBot iPhone Duo Night Sky 512GB",
        icon: "mdi:cellphone",
        stores: ["Orchard Road"],
        quote: "Available Today",
        part_number: "MK2G4X/A",
        buy_url: nightSky.buyUrl,
        last_checked: "2026-10-24T05:00:00.000Z",
      },
    });
    expect(s.requests[1].body.state).toBe("out_of_stock");
    expect(s.requests[1].body.attributes.stores).toEqual([]);
    expect(s.requests[1].body.attributes.quote).toBe("");
  });

  it("does nothing outside Home Assistant", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateSensors([nightSky], [], { apiBase: s.base, checkedAt });
    expect(s.requests).toEqual([]);
  });

  it("never rejects when Home Assistant errors", async () => {
    const s = await fakeServer(() => ({ status: 500 }));
    close = s.close;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateSensors([nightSky], [], { token: "t", apiBase: s.base, checkedAt })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("updateHealthSensor", () => {
  it("writes the shop's health sensor", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateHealthSensor(
      "apple_sg",
      "Apple SG",
      { state: "degraded", checks: 10, failures: 5, failureRate: 0.5, lastError: "Apple SG returned HTTP 541", lastSuccess: Date.parse("2026-10-24T05:00:00Z") },
      { token: "sup", apiBase: s.base, waitSeconds: 120 },
    );
    expect(s.requests[0].url).toBe("/states/sensor.hypebot_apple_sg_health");
    expect(s.requests[0].body).toEqual({
      state: "degraded",
      attributes: {
        friendly_name: "HypeBot Apple SG health",
        icon: "mdi:heart-pulse",
        failure_rate_percent: 50,
        failures_last_hour: 5,
        checks_last_hour: 10,
        last_error: "Apple SG returned HTTP 541",
        last_success: "2026-10-24T05:00:00.000Z",
        wait_seconds: 120,
      },
    });
  });

  it("does nothing outside Home Assistant", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateHealthSensor("apple_sg", "Apple SG", { state: "ok", checks: 0, failures: 0, failureRate: 0 }, { apiBase: s.base, waitSeconds: 60 });
    expect(s.requests).toEqual([]);
  });
});

describe("updateDeliverySensor", () => {
  it("shows the earliest delivery date with each model's date", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateDeliverySensor(
      "apple_sg",
      "Apple SG",
      [nightSky, white],
      new Map([
        [nightSky.id, { date: "2027-01-25", label: "Mon 25/01/2027" }],
        [white.id, { date: "2027-01-18", label: "Mon 18/01/2027" }],
      ]),
      { token: "sup", apiBase: s.base },
    );
    expect(s.requests[0].url).toBe("/states/sensor.hypebot_apple_sg_delivery");
    expect(s.requests[0].body).toEqual({
      state: "2027-01-18",
      attributes: {
        friendly_name: "HypeBot Apple SG earliest delivery",
        icon: "mdi:truck-delivery",
        device_class: "date",
        earliest_model: "iPhone Duo Star White 256GB",
        models: { "iPhone Duo Night Sky 512GB": "2027-01-25", "iPhone Duo Star White 256GB": "2027-01-18" },
      },
    });
  });

  it("does nothing outside Home Assistant or without dates", async () => {
    const s = await fakeServer();
    close = s.close;
    await updateDeliverySensor("apple_sg", "Apple SG", [nightSky], new Map(), { token: "t", apiBase: s.base });
    await updateDeliverySensor("apple_sg", "Apple SG", [nightSky], new Map([[nightSky.id, { date: "2027-01-25", label: "x" }]]), { apiBase: s.base });
    expect(s.requests).toEqual([]);
  });
});

