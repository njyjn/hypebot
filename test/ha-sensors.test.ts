import { afterEach, describe, expect, it, vi } from "vitest";
import { sensorId, updateSensors } from "../src/ha-sensors.js";
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
