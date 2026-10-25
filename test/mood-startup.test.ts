import { describe, expect, it, vi } from "vitest";
import { startMoodWhenReady, type ReadyCheck } from "../src/mood/startup.js";

function harness(results: ReadyCheck[]) {
  const slept: number[] = [];
  const alerts: string[] = [];
  const start = vi.fn();
  let i = 0;
  const opts = {
    check: vi.fn(async () => results[Math.min(i++, results.length - 1)]),
    start,
    alert: async (title: string, detail: string) => void alerts.push(`${title} | ${detail}`),
    sleep: async (ms: number) => void slept.push(ms),
  };
  return { opts, slept, alerts, start };
}

const missing: ReadyCheck = { ok: false, problem: "ai_task.claude_ai_task doesn't exist" };

describe("startMoodWhenReady", () => {
  it("starts straight away when the entity is there", async () => {
    const h = harness([{ ok: true }]);
    await startMoodWhenReady(h.opts);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.slept).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("keeps checking every minute while Home Assistant is still starting, without alerting", async () => {
    const h = harness([missing, missing, missing, { ok: true }]);
    await startMoodWhenReady(h.opts);
    expect(h.slept).toEqual([60_000, 60_000, 60_000]);
    expect(h.alerts).toEqual([]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("alerts once after 10 minutes, then checks every 30 minutes and says when it's on", async () => {
    const h = harness([...Array(14).fill(missing), { ok: true }]);
    await startMoodWhenReady(h.opts);
    expect(h.slept.slice(0, 10)).toEqual(Array(10).fill(60_000));
    expect(h.slept.slice(10)).toEqual(Array(4).fill(30 * 60_000));
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[0]).toMatch(/^⚠️ HypeBot mood is off \| ai_task.claude_ai_task doesn't exist/);
    expect(h.alerts[1]).toMatch(/^✅ HypeBot mood is on/);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("gives up at once on a problem that can't fix itself", async () => {
    const h = harness([{ ok: false, problem: "no Supervisor token", permanent: true }]);
    await startMoodWhenReady(h.opts);
    expect(h.slept).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("treats a check that throws like a failed check", async () => {
    const h = harness([{ ok: true }]);
    h.opts.check.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await startMoodWhenReady(h.opts);
    expect(h.slept).toEqual([60_000]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
