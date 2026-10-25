import { readFileSync } from "node:fs";
import type { MoodItem } from "./types.js";

const MAX_TEXT = 400;
const COMMENT_POSTS = 5;

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0";
  } catch {
    return "0";
  }
}
// Reddit asks scripts to identify themselves, unlike Apple which needs a browser-like UA.
const USER_AGENT = `hypebot/${version()} (Home Assistant app)`;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html: string) => html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** Feed markup to plain text: XML entities first, then the HTML inside. */
function htmlToText(escaped: string): string {
  return squash(decodeEntities(stripTags(decodeEntities(escaped))));
}

const tag = (xml: string, name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
const unCdata = (s: string) => s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");

/** Reddit's Atom feed (/r/<sub>/new/.rss). */
export function parseRedditRss(xml: string): MoodItem[] {
  if (!/<feed\b/.test(xml)) throw new Error("Reddit did not return a feed (got a web page instead)");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    // Reddit appends "submitted by /u/name [link] [comments]" to the post body.
    const body = htmlToText(tag(e, "content") ?? "").replace(/\s*submitted by\s+\/u\/[\s\S]*$/, "");
    return {
      id: `reddit:${squash(tag(e, "id") ?? "")}`,
      source: "reddit" as const,
      title: htmlToText(tag(e, "title") ?? ""),
      text: cut(body),
      url: /<link href="([^"]+)"/.exec(e)?.[1] ?? "",
      createdAt: Date.parse(tag(e, "published") ?? tag(e, "updated") ?? "") || 0,
    };
  });
}

/** Google News RSS search results. */
export function parseGoogleNews(xml: string): MoodItem[] {
  if (!/<rss\b/.test(xml)) throw new Error("Google News did not return a feed");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const title = htmlToText(unCdata(tag(it, "title") ?? ""));
    const text = htmlToText(unCdata(tag(it, "description") ?? ""));
    return {
      id: `news:${squash(tag(it, "guid") ?? tag(it, "link") ?? title)}`,
      source: "news" as const,
      title,
      text: cut(text === title ? "" : text),
      url: squash(tag(it, "link") ?? ""),
      createdAt: Date.parse(tag(it, "pubDate") ?? "") || 0,
    };
  });
}

/** A subreddit listing from the Reddit API. */
export function parseRedditListing(json: string): (MoodItem & { numComments: number })[] {
  const data = JSON.parse(json);
  return (data?.data?.children ?? []).map(({ data: p }: { data: Record<string, any> }) => ({
    id: `reddit:${p.name}`,
    source: "reddit" as const,
    title: squash(decodeEntities(String(p.title ?? ""))),
    text: cut(squash(decodeEntities(String(p.selftext ?? "")))),
    url: `https://www.reddit.com${p.permalink}`,
    createdAt: Number(p.created_utc) * 1000,
    numComments: Number(p.num_comments) || 0,
  }));
}

/** The top comments of a post (Reddit returns [post, comments]). */
export function parseRedditComments(json: string, max = 3): string[] {
  const data = JSON.parse(json);
  const children: { kind: string; data: { body?: string } }[] = data?.[1]?.data?.children ?? [];
  return children
    .filter((c) => c.kind === "t1" && c.data.body && !["[deleted]", "[removed]"].includes(c.data.body))
    .slice(0, max)
    .map((c) => cut(squash(decodeEntities(c.data.body!))));
}

export interface CollectOpts {
  subreddits: string[];
  newsQuery: string;
  reddit?: { clientId: string; clientSecret: string };
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/** Read every configured source. A source that fails is skipped and logged. */
export async function collect(opts: CollectOpts): Promise<{ items: MoodItem[]; sources: string[] }> {
  const f = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const get = async (url: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    const res = await f(url, { ...init, headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return body;
  };

  const items: MoodItem[] = [];
  const sources: string[] = [];

  if (opts.subreddits.length > 0) {
    try {
      if (opts.reddit) {
        const auth = Buffer.from(`${opts.reddit.clientId}:${opts.reddit.clientSecret}`).toString("base64");
        const tokenBody = await get(
          "https://www.reddit.com/api/v1/access_token",
          { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          { method: "POST", body: "grant_type=client_credentials" },
        );
        const token = JSON.parse(tokenBody).access_token;
        if (!token) throw new Error("no access token in reply");
        const bearer = { Authorization: `Bearer ${token}` };
        for (const sub of opts.subreddits) {
          const posts = parseRedditListing(await get(`https://oauth.reddit.com/r/${sub}/new?limit=50`, bearer));
          const busiest = [...posts].sort((a, b) => b.numComments - a.numComments).slice(0, COMMENT_POSTS).filter((p) => p.numComments > 0);
          for (const p of busiest) {
            try {
              const path = new URL(p.url).pathname.replace(/\/$/, "");
              p.comments = parseRedditComments(await get(`https://oauth.reddit.com${path}?limit=10&sort=top`, bearer));
            } catch {
              // a post without comments is still useful
            }
          }
          items.push(...posts.map(({ numComments: _, ...p }) => p));
        }
        sources.push("reddit (login)");
      } else {
        for (const sub of opts.subreddits) items.push(...parseRedditRss(await get(`https://www.reddit.com/r/${sub}/new/.rss`)));
        sources.push("reddit (rss)");
      }
    } catch (error) {
      log(`Mood: reading Reddit failed, skipping it this time: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (opts.newsQuery) {
    try {
      const q = new URLSearchParams({ q: opts.newsQuery, hl: "en-SG", gl: "SG", ceid: "SG:en" });
      items.push(...parseGoogleNews(await get(`https://news.google.com/rss/search?${q}`)));
      sources.push("news");
    } catch (error) {
      log(`Mood: reading Google News failed, skipping it this time: ${error instanceof Error ? error.message : error}`);
    }
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items, sources };
}
