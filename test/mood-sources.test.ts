import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, parseGoogleNews, parseRedditComments, parseRedditListing, parseRedditRss } from "../src/mood/sources.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseRedditRss", () => {
  it("reads entries with stripped, decoded text", () => {
    const items = parseRedditRss(fx("reddit-new.rss"));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      id: "reddit:t3_abc",
      source: "reddit",
      title: "Inner screen cracked after 2 days",
      url: "https://www.reddit.com/r/iPhoneDuo/comments/abc/inner_screen_cracked/",
      createdAt: Date.parse("2026-10-25T05:30:00Z"),
    });
    expect(items[0].text).toContain("Apple swapped it & no questions asked.");
    expect(items[0].text).not.toMatch(/<|submitted by|&amp;/);
    expect(items[1].text).toContain("I've owned");
  });

  it("cuts text to 400 characters", () => {
    const long = fx("reddit-new.rss").replace("Honestly", "x".repeat(900));
    expect(parseRedditRss(long)[1].text.length).toBeLessThanOrEqual(400);
  });
});

describe("parseGoogleNews", () => {
  it("reads items as news with the publisher in the title", () => {
    const items = parseGoogleNews(fx("google-news.rss"));
    expect(items).toHaveLength(3);
    expect(items[0].source).toBe("news");
    expect(items[0].id).toMatch(/^news:CBM/);
    expect(items[0].title).toContain("AsiaOne");
    expect(items[0].url).toMatch(/^https:\/\/news\.google\.com\//);
    expect(items[0].createdAt).toBe(Date.parse("Fri, 23 Oct 2026 04:06:22 GMT"));
  });
});

describe("parseRedditListing / parseRedditComments", () => {
  it("reads posts with comment counts", () => {
    const posts = parseRedditListing(fx("reddit-new.json"));
    expect(posts.map((p) => p.numComments)).toEqual([40, 3, 12]);
    expect(posts[0]).toMatchObject({
      id: "reddit:t3_abc",
      url: "https://www.reddit.com/r/iPhoneDuo/comments/abc/inner_screen_cracked/",
      createdAt: 1792906200 * 1000,
    });
  });

  it("returns at most 3 comment bodies, skipping deleted ones", () => {
    expect(parseRedditComments(fx("reddit-comments.json"))).toEqual(["Same here, Night Sky too.", "Mine is fine after a week.", "Get AppleCare."]);
  });
});

/** A fetch stub answering by URL prefix. */
function stubFetch(routes: [string, number, string][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const hit = routes.find(([prefix]) => u.startsWith(prefix));
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(hit[2], { status: hit[1] });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const NEWS = "https://news.google.com/rss/search?";
const RSS = "https://www.reddit.com/r/iPhoneDuo/new/.rss";

describe("collect", () => {
  it("without a login reads Reddit RSS and news, newest first", async () => {
    const f = stubFetch([[RSS, 200, fx("reddit-new.rss")], [NEWS, 200, fx("google-news.rss")]]);
    const r = await collect({ subreddits: ["iPhoneDuo"], newsQuery: "iPhone Duo", fetch: f.fetch });
    expect(f.calls.map((c) => c.url.split("?")[0])).toEqual([RSS, "https://news.google.com/rss/search"]);
    expect(f.calls[1].url).toContain("q=iPhone+Duo");
    expect(r.sources).toEqual(["reddit (rss)", "news"]);
    expect(r.items).toHaveLength(6);
    const times = r.items.map((i) => i.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((f.calls[0].init?.headers as Record<string, string>)["User-Agent"]).toMatch(/^hypebot\//);
  });

  it("with a login uses OAuth and fetches comments for the 5 busiest posts", async () => {
    const f = stubFetch([
      ["https://www.reddit.com/api/v1/access_token", 200, JSON.stringify({ access_token: "tok", expires_in: 86400 })],
      ["https://oauth.reddit.com/r/iPhoneDuo/new", 200, fx("reddit-new.json")],
      ["https://oauth.reddit.com/r/iPhoneDuo/comments/", 200, fx("reddit-comments.json")],
      [NEWS, 200, fx("google-news.rss")],
    ]);
    const r = await collect({ subreddits: ["iPhoneDuo"], newsQuery: "iPhone Duo", reddit: { clientId: "id", clientSecret: "sec" }, fetch: f.fetch });
    const token = f.calls[0];
    expect(token.init?.method).toBe("POST");
    expect(String(token.init?.body)).toBe("grant_type=client_credentials");
    expect((token.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(f.calls[1].url).toBe("https://oauth.reddit.com/r/iPhoneDuo/new?limit=50");
    expect((f.calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(f.calls.filter((c) => c.url.includes("/comments/"))).toHaveLength(3); // only 3 posts exist, all within the top 5
    expect(r.sources).toEqual(["reddit (login)", "news"]);
    expect(r.items.find((i) => i.id === "reddit:t3_abc")?.comments).toEqual(["Same here, Night Sky too.", "Mine is fine after a week.", "Get AppleCare."]);
  });

  it("only fetches comments for the 5 posts with the most comments", async () => {
    const listing = JSON.parse(fx("reddit-new.json"));
    const base = listing.data.children[0];
    listing.data.children = Array.from({ length: 8 }, (_, i) => ({
      kind: "t3",
      data: { ...base.data, name: `t3_p${i}`, permalink: `/r/iPhoneDuo/comments/p${i}/x/`, num_comments: i },
    }));
    const f = stubFetch([
      ["https://www.reddit.com/api/v1/access_token", 200, JSON.stringify({ access_token: "tok" })],
      ["https://oauth.reddit.com/r/iPhoneDuo/new", 200, JSON.stringify(listing)],
      ["https://oauth.reddit.com/r/iPhoneDuo/comments/", 200, fx("reddit-comments.json")],
    ]);
    await collect({ subreddits: ["iPhoneDuo"], newsQuery: "", reddit: { clientId: "id", clientSecret: "sec" }, fetch: f.fetch });
    const fetched = f.calls.filter((c) => c.url.includes("/comments/")).map((c) => c.url.match(/comments\/(p\d)/)?.[1]);
    expect(fetched.sort()).toEqual(["p3", "p4", "p5", "p6", "p7"]);
  });

  it("skips Reddit when it answers 429 and keeps the news", async () => {
    const log = vi.fn();
    const f = stubFetch([[RSS, 429, ""], [NEWS, 200, fx("google-news.rss")]]);
    const r = await collect({ subreddits: ["iPhoneDuo"], newsQuery: "iPhone Duo", fetch: f.fetch, log });
    expect(r.sources).toEqual(["news"]);
    expect(r.items).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("429");
  });

  it("skips Reddit when RSS returns a web page instead of a feed", async () => {
    const log = vi.fn();
    const f = stubFetch([[RSS, 200, "<html><body>blocked</body></html>"], [NEWS, 200, fx("google-news.rss")]]);
    const r = await collect({ subreddits: ["iPhoneDuo"], newsQuery: "iPhone Duo", fetch: f.fetch, log });
    expect(r.sources).toEqual(["news"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("does not read news when the query is empty", async () => {
    const f = stubFetch([[RSS, 200, fx("reddit-new.rss")]]);
    const r = await collect({ subreddits: ["iPhoneDuo"], newsQuery: "", fetch: f.fetch });
    expect(f.calls).toHaveLength(1);
    expect(r.sources).toEqual(["reddit (rss)"]);
  });
});
