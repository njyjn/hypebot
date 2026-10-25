import { describe, expect, it } from "vitest";
import { HealthTracker } from "../src/health.js";

const MIN = 60_000;

describe("HealthTracker", () => {
  it("is ok with no failures", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 10; i++) h.record(true, i * MIN);
    expect(h.summary(10 * MIN, 0)).toMatchObject({ state: "ok", checks: 10, failures: 0, failureRate: 0 });
  });

  it("is degraded when over 30% of the last hour's checks fail and at least 5 failed", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 10; i++) h.record(i % 2 === 0, i * MIN, i % 2 === 0 ? undefined : "Apple SG returned HTTP 541");
    expect(h.summary(10 * MIN, 1)).toMatchObject({ state: "degraded", checks: 10, failures: 5, failureRate: 0.5, lastError: "Apple SG returned HTTP 541" });
  });

  it("stays ok with a few scattered failures", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 4; i++) h.record(false, i * MIN, "x");
    expect(h.summary(4 * MIN, 1).state).toBe("ok");
  });

  it("is blocked after 10 failures in a row", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 10; i++) h.record(false, i * MIN, "x");
    expect(h.summary(10 * MIN, 10).state).toBe("blocked");
  });

  it("forgets checks older than an hour", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 6; i++) h.record(false, i * MIN, "x");
    h.record(true, 70 * MIN);
    expect(h.summary(70 * MIN, 0)).toMatchObject({ state: "ok", checks: 1, failures: 0 });
  });

  it("remembers the last successful check", () => {
    const h = new HealthTracker();
    h.record(true, 5 * MIN);
    h.record(false, 6 * MIN, "x");
    expect(h.summary(6 * MIN, 1).lastSuccess).toBe(5 * MIN);
  });

  it("raises a degraded alert once and clears it once", () => {
    const h = new HealthTracker();
    const changes: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      h.record(i % 2 === 0, i * MIN, "x");
      changes.push(h.transition(h.summary(i * MIN, i % 2 === 0 ? 0 : 1)));
    }
    for (let i = 0; i < 70; i++) {
      h.record(true, (61 + i) * MIN);
      changes.push(h.transition(h.summary((61 + i) * MIN, 0)));
    }
    expect(changes.filter(Boolean)).toEqual(["degraded", "cleared"]);
  });
});

describe("HealthTracker persistence", () => {
  it("round-trips its history, last error, last success and alert state", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 10; i++) {
      h.record(i % 2 === 0, i * MIN, "Apple SG returned HTTP 541");
      h.transition(h.summary(i * MIN, i % 2 === 0 ? 0 : 1));
    }
    const restored = HealthTracker.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    expect(restored.summary(10 * MIN, 0)).toEqual(h.summary(10 * MIN, 0));
    // the degraded alert was already sent, so recovery after restart still clears it once
    for (let i = 0; i < 70; i++) restored.record(true, (61 + i) * MIN);
    expect(restored.transition(restored.summary(131 * MIN, 0))).toBe("cleared");
  });

  it("starts empty from missing or malformed data", () => {
    expect(HealthTracker.fromJSON(undefined).summary(0, 0)).toMatchObject({ checks: 0, failures: 0, state: "ok" });
    expect(HealthTracker.fromJSON({ events: "nope" }).summary(0, 0).checks).toBe(0);
  });
});

describe("health file", () => {
  it("saves and loads trackers per shop", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { loadHealth, saveHealth } = await import("../src/health.js");
    const path = join(mkdtempSync(join(tmpdir(), "hb-")), "health.json");
    const h = new HealthTracker();
    h.record(false, MIN, "x");
    saveHealth(path, { apple_sg: h });
    expect(loadHealth(path).apple_sg.summary(2 * MIN, 1)).toMatchObject({ checks: 1, failures: 1, lastError: "x" });
    expect(loadHealth(join(path, "..", "missing.json"))).toEqual({});
  });
});
