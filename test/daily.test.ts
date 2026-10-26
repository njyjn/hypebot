import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maybeSendDaily, type DailyCtx } from "../src/daily.js";
import { emptyMood } from "../src/mood/store.js";
import { emptySummary, loadSummary, recordAvailability } from "../src/summary.js";
import type { AlertMessage } from "../src/types.js";
import { duoItem } from "./helpers.js";

const at = (hhmm: string, day = "2026-10-26") => Date.parse(`${day}T${hhmm}:00+08:00`);
const white = duoItem("MK2F4X/A", "Star White 512GB");

function setup(clock: number, withMood = false) {
  const sent: AlertMessage[] = [];
  const path = join(mkdtempSync(join(tmpdir(), "daily-")), "summary.json");
  const log = emptySummary();
  const ai = vi.fn(async (): Promise<unknown> => "People worry about hinge cracks.");
  const moodState = {
    ...emptyMood(),
    batches: [{ at: at("18:00"), score: -0.5, items: 30, themes: [{ text: "Hinge cracks" }] }],
  };
  const ctx: DailyCtx = {
    time: "21:00",
    notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }],
    summary: { log, path },
    now: () => clock,
    timeZone: "Asia/Singapore",
    mood: withMood
      ? () => ({
          ctx: {
            cfg: { enabled: true, aiTaskEntity: "ai_task.claude_ai_task", subreddits: [], newsQuery: "", digestTime: "21:00", redditClientId: "", redditClientSecret: "" },
            statePath: join(path, "..", "mood.json"),
            notifiers: [],
            collect: vi.fn(),
            ai,
            sensor: vi.fn(),
            timeZone: "Asia/Singapore",
            now: () => clock,
          },
          state: moodState,
        })
      : undefined,
  };
  return { ctx, sent, log, path, ai };
}

describe("maybeSendDaily", () => {
  it("sends one combined message at the daily time with drops and mood", async () => {
    const s = setup(at("21:00"), true);
    recordAvailability(s.log, [white], [{ itemId: white.id, stores: [{ name: "Orchard Road", quote: "x" }] }], at("09:00"));
    recordAvailability(s.log, [white], [{ itemId: white.id, stores: [] }], at("09:02"));
    expect(await maybeSendDaily(s.ctx)).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].title).toBe("📊 HypeBot · Mon 26 Oct");
    expect(s.sent[0].lines).toEqual([
      "Stock: 1 drop",
      "• 09:00 Star White 512GB, Orchard Road (~2 min)",
      "Mood: -0.50 (negative) · 30 posts",
      "People worry about hinge cracks.",
    ]);
    expect(s.sent[0].urgent).toBeFalsy();
  });

  it("clears what it reported and sends only once a day", async () => {
    const s = setup(at("21:00"));
    recordAvailability(s.log, [white], [{ itemId: white.id, stores: [{ name: "Orchard Road", quote: "x" }] }], at("09:00"));
    recordAvailability(s.log, [white], [{ itemId: white.id, stores: [] }], at("09:02"));
    await maybeSendDaily(s.ctx);
    expect(loadSummary(s.path)).toEqual({ drops: [], delivery: [], lastSentDate: "2026-10-26" });
    expect(await maybeSendDaily(s.ctx)).toBe(false);
    expect(s.sent).toHaveLength(1);
  });

  it("works without mood and says when nothing dropped", async () => {
    const s = setup(at("21:03"));
    await maybeSendDaily(s.ctx);
    expect(s.sent[0].lines).toEqual(["Stock: no drops today"]);
  });

  it("waits for the daily time and skips a missed one", async () => {
    expect(await maybeSendDaily(setup(at("20:59")).ctx)).toBe(false);
    const late = setup(at("21:30"));
    expect(await maybeSendDaily(late.ctx)).toBe(false);
    expect(late.sent).toHaveLength(0);
  });

  it("keeps the stock part when the mood part fails", async () => {
    const s = setup(at("21:00"), true);
    s.ai.mockRejectedValue(new Error("timeout"));
    await maybeSendDaily(s.ctx);
    expect(s.sent[0].lines[0]).toBe("Stock: no drops today");
    expect(s.sent[0].lines).toContain("Mood: -0.50 (negative) · 30 posts");
    expect(s.sent[0].lines).toContain("Hinge cracks");
  });
});
