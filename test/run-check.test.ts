import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadState } from "../src/state.js";
import { FailureTracker, runCheck, type Ctx } from "../src/watcher.js";
import type { AlertMessage, Availability, Source } from "../src/types.js";
import { duoItem } from "./helpers.js";

const item = duoItem("MK2G4X/A", "Night Sky 512GB");

function ctx(results: (Availability[] | Error)[], opts: { notifySoldOut?: boolean } = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), "hb-")), "state.json");
  const cfg = { ...loadConfig({ OPTIONS_PATH: "/nonexistent" }), statePath, notifySoldOut: opts.notifySoldOut ?? false };
  const sent: AlertMessage[] = [];
  const sensors = vi.fn(async () => {});
  const source: Source = {
    name: "apple_sg",
    resolve: async () => [item],
    check: async () => {
      const r = results.shift();
      if (r instanceof Error || r === undefined) throw r ?? new Error("no more results");
      return r;
    },
  };
  const c: Ctx = {
    cfg,
    source,
    items: [item],
    notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }],
    failures: new FailureTracker(),
    state: {},
    sensors,
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

  it("alerts once after 10 failures in a row and once on recovery", async () => {
    const { c, sent } = ctx([...Array.from({ length: 11 }, () => new Error("HTTP 541")), none]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 12; i++) await runCheck(c);
    err.mockRestore();
    expect(sent.map((m) => m.title)).toEqual(["⚠️ HypeBot can't reach Apple SG", "✅ HypeBot is back to normal"]);
    expect(sent[0].lines[0]).toContain("HTTP 541");
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
