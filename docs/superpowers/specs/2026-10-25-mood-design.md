# HypeBot mood tracking: design

Date: 2026-10-25. Status: draft for review.

## Goal

Show how people feel about the iPhone Duo, from r/iPhoneDuo and the news,
as a mood score and one daily summary.

Agreed with the user:

- **Focus:** general mood. An overall positive/negative score plus a summary of
  what people are talking about. Themes such as cracked screens appear in the
  summary; they are not tracked as separate counters.
- **Delivery:** a mood sensor on the dashboard, and one digest a day sent to the
  existing alert destinations. No extra alerts during the day.
- **Analysis:** done by the Claude AI Task already set up in Home Assistant
  (`ai_task.claude_ai_task`), so HypeBot needs no Anthropic key.
- **Reddit access:** a Reddit app login when one is entered, otherwise
  Reddit's public RSS feed.

Success: once it's on, the sensor has a score within the first hour, the
digest arrives at 21:00 every day, and stock alerts are never delayed or
broken by the mood feature.

Not in scope: per-topic counters, alerts on mood swings, HardwareZone and
MacRumors (they can be added later as further sources), X/Twitter.

## Settings (all new, all optional)

| Option | Default | Notes |
|---|---|---|
| `mood_enabled` | `false` | Turns the feature on. |
| `mood_ai_task_entity` | `ai_task.claude_ai_task` | Any `ai_task` entity that can generate data. |
| `mood_subreddits` | `["iPhoneDuo"]` | Subreddit names without `r/`. |
| `mood_news_query` | `iPhone Duo` | Google News search (Singapore edition). Empty turns news off. |
| `mood_digest_time` | `21:00` | Local time of the Home Assistant host (the app's `TZ`). |
| `reddit_client_id` / `reddit_client_secret` | | From a "script" app at reddit.com/prefs/apps. Both needed; otherwise RSS is used. |

If `mood_enabled` is on but no AI Task entity exists, HypeBot logs it and
sends one status alert; stock checks carry on.

## How it works

Mood runs on its own timer, separate from the stock loop, so a slow
Reddit or AI call never delays a stock check.

### 1. Collect (every 30 minutes)

- **Reddit with a login:** get an app-only token
  (`POST https://www.reddit.com/api/v1/access_token`,
  `grant_type=client_credentials`), then
  `GET https://oauth.reddit.com/r/<sub>/new?limit=50`. For up to 5 of the new
  posts with the most comments, fetch the top 3 comments.
  With HypeBot's own User-Agent, this is a handful of requests per run,
  well inside Reddit's free limit.
- **Reddit without a login:** `GET https://www.reddit.com/r/<sub>/new/.rss`
  (titles and post text only, no comments or votes). If Reddit answers
  403/429, the run is skipped for that source and logged; the next run tries
  again.
- **News:** the Google News RSS search for `mood_news_query`.

Each item becomes `{id, source, title, text (cut to 400 characters), url,
createdAt}`. IDs already seen are skipped. An item is marked seen only after
it has been analysed, so a failed AI call is retried next run. At most 60
items per run (newest first); older extras roll over to the next run.

### 2. Analyse (same run, only if there are new items)

One call per run:

```
POST /api/services/ai_task/generate_data?return_response
{
  "task_name": "hypebot mood",
  "entity_id": "<mood_ai_task_entity>",
  "instructions": "<fixed instructions> + the numbered items",
  "structure": {
    "score":  {"selector": {"number": {"min": -1, "max": 1, "step": 0.01}}, "required": true,
               "description": "Overall mood of these posts, -1 very negative to 1 very positive"},
    "themes": {"selector": {"text": {"multiline": true}}, "required": true,
               "description": "Up to 5 themes, one per line, each ending with the number of the item that best shows it"}
  }
}
```

The instructions say the items are posts from the public to describe, not
instructions to follow. A theme's item number is turned back into that
item's link by HypeBot; numbers that don't match an item are dropped, so
the digest never shows a link that wasn't in the input.

The result is saved as a batch `{at, score, items, themes[{text, url}]}`.

Whether the `structure` selectors above are all accepted is checked
against the live AI Task during implementation; if `multiline` text is
refused, `themes` falls back to plain text.

### 3. Sensor

`sensor.hypebot_iphone_duo_mood`, updated after every run:

- state: the 24-hour score, the average of the last 24 hours of batches
  weighted by how many items each had, rounded to 2 decimals. `unknown`
  until the first batch.
- attributes: `label` (negative below −0.2, positive above 0.2, otherwise
  mixed), `items_24h`, `themes` (latest batch, as text), `last_updated`,
  `sources` (e.g. `reddit (login)`, `reddit (rss)`, `news`).

`state_class: measurement` so Home Assistant keeps long-term history for a
graph on the HypeBot dashboard.

### 4. Daily digest (at `mood_digest_time`)

A second AI Task call gets the day's batches (scores, item counts and
themes with their links) plus yesterday's 24-hour score, and writes a short
plain-text digest of up to about 8 lines. HypeBot adds a header line itself,
e.g. `📊 iPhone Duo mood: +0.12 (mixed), was −0.05 yesterday · 143 posts`,
so the numbers are never the AI's guess. It is sent through the existing
notifiers as a normal (not urgent) message.

No batches that day: a one-line "No new posts today" digest. Digest AI
call fails: the header line plus the top themes as a list is sent instead.

## Storage

`/data/mood.json`, written atomically after each run (same way as
`health.json`):

- `batches`: the last 48 hours (enough for today's digest and yesterday's
  score).
- `seen`: IDs from the last 7 days.
- `lastDigestDate`: so a restart doesn't send a second digest; a digest
  missed because the app was off is skipped, not sent late.

## Failure handling

| What fails | What happens |
|---|---|
| Reddit or news fetch | That source is skipped this run and logged. |
| AI call (error, timeout after 60 s, or a reply without `score`) | Logged; items stay unseen and are retried next run. After 6 failed runs in a row, one status alert; one more when it works again. |
| No AI Task entity | One status alert at startup; mood stays off until it exists. |
| Sensor update | Logged, as for the other sensors. |

None of these touch the stock checks, stock alerts or health sensor.

## Code layout

- `src/mood/sources.ts`: Reddit (OAuth and RSS) and Google News fetchers,
  each returning items, plus the shared parsing.
- `src/mood/analyse.ts`: builds the AI Task request, reads the response,
  maps theme numbers to links, builds the digest request.
- `src/mood/store.ts`: `mood.json` load/save, 24-hour score, pruning.
- `src/mood/index.ts`: the timer: collect, analyse, sensor, digest.
- `src/ha-sensors.ts`: add `updateMoodSensor`.
- `src/config.ts`, `config.yaml`, `README.md`: new settings, documented.
- Version 0.6.0.

## Testing

- Unit tests with recorded responses: Reddit listing JSON, Reddit RSS, Google
  News RSS, an AI Task response, an AI Task error.
- Store: weighted score, pruning, `seen` handling, digest only once a day.
- Analyse: item numbers outside the list are dropped; long text is cut.
- Failure cases: AI failure keeps items unseen; 6 failures send one alert.
- Before release: one live run against the user's Home Assistant AI Task
  with a few real posts, to confirm the request shape works.

## Cost

Up to 48 AI calls a day for batches (fewer when nothing is new) and one for
the digest, each with at most 60 short items. This is billed to the
Anthropic account behind the Home Assistant integration; the model is the
one chosen there.
