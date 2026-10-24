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
