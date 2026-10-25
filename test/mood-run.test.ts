import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeSendDigest, runMoodCycle, startMood, type MoodCtx } from "../src/mood/index.js";
import { emptyMood, loadMood } from "../src/mood/store.js";
import type { MoodItem, MoodState } from "../src/mood/types.js";
import type { AlertMessage } from "../src/types.js";

const H = 3_600_000;
// 2026-10-25 20:59 in Singapore (UTC+8)
const at = (hhmm: string, day = "2026-10-25") => Date.parse(`${day}T${hhmm}:00+08:00`);

const item = (n: number): MoodItem => ({
  id: `reddit:t3_${n}`,
  source: "reddit",
  title: `Post ${n}`,
  text: "",
  url: `https://www.reddit.com/r/iPhoneDuo/comments/${n}/`,
  createdAt: 1000 + n, // larger n = newer
});

function makeCtx(over: Partial<MoodCtx> & { items?: MoodItem[]; clock?: number } = {}) {
  const sent: AlertMessage[] = [];
  let clock = over.clock ?? at("12:00");
  const items = over.items ?? [item(1), item(2), item(3)];
  const ai = vi.fn(async (_body: any): Promise<unknown> => ({ score: 0.5, themes: "Cracks [1]" }));
  const sensor = vi.fn(async () => {});
  const ctx: MoodCtx = {
    cfg: { enabled: true, aiTaskEntity: "ai_task.claude_ai_task", subreddits: ["iPhoneDuo"], newsQuery: "iPhone Duo", digestTime: "21:00", redditClientId: "", redditClientSecret: "" },
    statePath: join(mkdtempSync(join(tmpdir(), "moodrun-")), "mood.json"),
    notifiers: [{ name: "fake", send: async (m) => void sent.push(m) }],
    collect: vi.fn(async () => ({ items: [...items].sort((a, b) => b.createdAt - a.createdAt), sources: ["reddit (rss)"] })),
    ai,
    sensor,
    now: () => clock,
    timeZone: "Asia/Singapore",
    ...over,
  };
  return { ctx, sent, ai, sensor, setClock: (t: number) => (clock = t) };
}

describe("runMoodCycle", () => {
  it("analyses new items once, saves a batch and marks them seen", async () => {
    const { ctx, ai, sensor } = makeCtx();
    const state = emptyMood();
    await runMoodCycle(ctx, state);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(state.batches).toEqual([{ at: at("12:00"), score: 0.5, items: 3, themes: [{ text: "Cracks", url: "https://www.reddit.com/r/iPhoneDuo/comments/3/" }] }]);
    expect(Object.keys(state.seen).sort()).toEqual(["reddit:t3_1", "reddit:t3_2", "reddit:t3_3"]);
    expect(sensor).toHaveBeenCalledWith(state, at("12:00"), ["reddit (rss)"]);
    expect(loadMood(ctx.statePath).batches).toHaveLength(1);

    await runMoodCycle(ctx, state);
    expect(ai).toHaveBeenCalledTimes(1); // nothing new
    expect(sensor).toHaveBeenCalledTimes(2); // sensor still refreshed
  });

  it("sends at most the 60 newest items and leaves the rest for next time", async () => {
    const many = Array.from({ length: 70 }, (_, i) => item(i));
    const { ctx, ai } = makeCtx({ items: many });
    const state = emptyMood();
    await runMoodCycle(ctx, state);
    expect(ai.mock.calls[0][0].instructions).toContain("[60] reddit: Post 10");
    expect(ai.mock.calls[0][0].instructions).not.toContain("[61]");
    expect(state.seen["reddit:t3_69"]).toBeDefined();
    expect(state.seen["reddit:t3_9"]).toBeUndefined();
    expect(state.batches[0].items).toBe(60);
  });

  it("keeps items unseen when the AI call fails, and alerts once after 6 failures in a row", async () => {
    const { ctx, ai, sent } = makeCtx();
    ai.mockRejectedValue(new Error("HTTP 500"));
    const state = emptyMood();
    for (let i = 0; i < 5; i++) await runMoodCycle(ctx, state);
    expect(state.batches).toHaveLength(0);
    expect(state.seen).toEqual({});
    expect(sent).toHaveLength(0);
    await runMoodCycle(ctx, state);
    await runMoodCycle(ctx, state);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/mood/i);
    expect(sent[0].lines.join(" ")).toContain("HTTP 500");

    ai.mockResolvedValue({ score: 0.1, themes: "" });
    await runMoodCycle(ctx, state);
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toMatch(/working again/);
    expect(state.failuresInARow).toBe(0);
  });

  it("treats a reply without a score as a failure", async () => {
    const { ctx, ai } = makeCtx();
    ai.mockResolvedValue({ themes: "x" });
    const state = emptyMood();
    await runMoodCycle(ctx, state);
    expect(state.batches).toHaveLength(0);
    expect(state.failuresInARow).toBe(1);
  });
});

function dayState(): MoodState {
  return {
    ...emptyMood(),
    batches: [
      { at: at("20:00", "2026-10-24"), score: 0.1, items: 10, themes: [] },
      { at: at("10:00"), score: 0.5, items: 10, themes: [{ text: "Love the screen", url: "https://r/1" }] },
      { at: at("18:00"), score: -0.5, items: 30, themes: [{ text: "Hinge cracks", url: "https://r/2" }] },
    ],
  };
}

describe("maybeSendDigest", () => {
  it("waits for the digest time, sends once, with the header computed by HypeBot", async () => {
    const { ctx, ai, sent, setClock } = makeCtx({ clock: at("20:59") });
    ai.mockResolvedValue("People love the screen but worry about hinge cracks.");
    const state = dayState();
    expect(await maybeSendDigest(ctx, state)).toBe(false);

    setClock(at("21:00"));
    expect(await maybeSendDigest(ctx, state)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("📊 iPhone Duo mood: -0.25 (negative), was +0.10 yesterday · 40 posts");
    expect(sent[0].lines).toEqual(["People love the screen but worry about hinge cracks."]);
    expect(sent[0].urgent).toBeFalsy();
    expect(state.lastDigestDate).toBe("2026-10-25");

    setClock(at("21:05"));
    expect(await maybeSendDigest(ctx, state)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("sends only one digest when two checks overlap", async () => {
    const { ctx, ai, sent } = makeCtx({ clock: at("21:01") });
    let release!: () => void;
    ai.mockImplementation(() => new Promise((r) => (release = () => r("ok"))));
    const state = dayState();
    const first = maybeSendDigest(ctx, state);
    const second = await maybeSendDigest(ctx, state);
    release();
    expect(await first).toBe(true);
    expect(second).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("falls back to the theme list when the digest AI call fails", async () => {
    const { ctx, ai, sent } = makeCtx({ clock: at("21:00") });
    ai.mockRejectedValue(new Error("timeout"));
    await maybeSendDigest(ctx, dayState());
    expect(sent[0].title).toMatch(/^📊 iPhone Duo mood: -0.25/);
    expect(sent[0].lines).toEqual(["Love the screen: https://r/1", "Hinge cracks: https://r/2"]);
  });

  it("says so when there were no posts today", async () => {
    const { ctx, ai, sent } = makeCtx({ clock: at("21:00") });
    const state = { ...emptyMood(), batches: [{ at: at("20:00", "2026-10-24"), score: 0.1, items: 10, themes: [] }] };
    expect(await maybeSendDigest(ctx, state)).toBe(true);
    expect(ai).not.toHaveBeenCalled();
    expect(sent[0].title).toBe("📊 iPhone Duo mood: no new posts today");
  });

  it("skips a digest missed while HypeBot was off", async () => {
    const { ctx, sent } = makeCtx({ clock: at("21:30") });
    const state = { ...dayState(), lastDigestDate: "2026-10-24" };
    expect(await maybeSendDigest(ctx, state)).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("startMood", () => {
  afterEach(() => vi.useRealTimers());

  it("runs a cycle straight away and every 30 minutes, without throwing on errors", async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx();
    (ctx.collect as any).mockRejectedValueOnce(new Error("network down"));
    const stop = startMood(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(ctx.collect).toHaveBeenCalledTimes(2);
    expect(loadMood(ctx.statePath).batches).toHaveLength(1); // second run worked and saved
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(ctx.collect).toHaveBeenCalledTimes(2);
  });
});
