# HypeBot

Get a phone alert the moment a hard-to-find product can be picked up in
store, without refreshing the shop website.

HypeBot checks Apple Store Singapore (Orchard Road, Marina Bay Sands, Jewel
Changi Airport) about once a minute for the models you pick. When any of them
becomes available for pickup, it sends one alert to Slack, Telegram and/or a
Home Assistant notify service, and updates a Home Assistant sensor per model.

It only alerts. It never logs in, reserves or checks out.

## Install (Home Assistant add-on)

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
   `https://github.com/njyjn/ha-addons`.
2. Install **HypeBot**, open **Configuration**, set your models and at least
   one alert destination (below), then start it.
3. Turn on `send_test_alert` once and restart to check your phone buzzes,
   then turn it off.

## Options

| Option | Default | Notes |
|---|---|---|
| `interval_seconds` | `60` | Seconds between checks, 30–3600. Up to 10 s of random delay is added. After failed checks the wait doubles, up to 10 minutes, and resets after a success. |
| `models` | iPhone Duo ×3 | Pick models from the dropdown (add one entry per model). See below. |
| `watch` | `[]` | Optional: type models that aren't in the dropdown. See below. |
| `buy_link_base` | `https://www.apple.com/sg` | Apple store front used for buy links, e.g. your EPP store `https://www.apple.com/sg_epp_…`. Stock is always checked on the public store. |
| `apple_sg_stores` | `[]` (all) | Limit to some stores, e.g. `["Orchard Road", "Marina Bay Sands"]`. |
| `notify_sold_out` | `false` | Also send a note when a model sells out again. |
| `track_delivery_dates` | `true` | Check Apple's online delivery date every 30 minutes and alert when it moves earlier. |
| `remind_every_minutes` | `0` (off) | Re-alert every N minutes (1–60) while a model stays in stock. |
| `send_test_alert` | `false` | Send a test alert at startup. |
| `ha_notify_service` | | e.g. `notify.mobile_app_justins_iphone`. Tapping the alert opens the buy page. |
| `notify_mode` | `instant` | `instant`: alert the moment stock appears. `daily_summary`: no stock pings; one message a day instead (see below). |
| `ha_notify_priority` | `time_sensitive` | How loudly stock alerts arrive via the HA companion app: `normal`, `time_sensitive` (breaks through Focus modes) or `critical` (rings even on silent). Status messages always arrive normally. |
| `slack_bot_token` / `slack_channel` | | Both needed. See "Slack bot". |
| `telegram_bot_token` / `telegram_chat_id` | | Both needed. See "Telegram bot". |

### Choosing models

Add an entry under `models` for each model and pick it from the dropdown,
e.g. `iPhone Duo / Night Sky / 1TB`.

The dropdown is a fixed list built from Apple's site when HypeBot is
released (`npm run gen:models`), because Home Assistant can't fill an
add-on's settings form at runtime. For anything not listed yet, type it
under `watch`:

```yaml
watch:
  - source: apple_sg
    product: iphone-duo          # from the URL: apple.com/sg/shop/buy-iphone/iphone-duo
    variants:
      - "Star White / 512GB"
      - "Night Sky / 512GB"
      - "white / 256"            # case-insensitive; "white"/"black" nicknames work
```

Each typed variant is `Colour / Capacity`. HypeBot reads Apple's buy page to find
the part numbers, so new models work without an update. If a name matches
nothing, the add-on log lists every valid option and you get one alert.

### Slack bot

1. <https://api.slack.com/apps> → Create New App → From scratch.
2. OAuth & Permissions → Bot Token Scopes → add `chat:write`.
3. Install to Workspace and copy the **Bot User OAuth Token** (`xoxb-…`) into
   `slack_bot_token`.
4. In Slack, invite the bot to your channel (`/invite @YourApp`) and put the
   channel name or ID in `slack_channel`.

### Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
   into `telegram_bot_token`.
2. Send your new bot any message, then open
   `https://api.telegram.org/bot<token>/getUpdates` and copy
   `message.chat.id` into `telegram_chat_id`.

### Buy links

It's first come, first served, so every alert links straight to the model's
own page (colour and capacity already chosen), e.g.
`…/shop/buy-iphone/iphone-duo/7.6-inch-display-1tb-night-sky`. When several
models restock at once, Slack and Telegram get one link per model and tapping
the phone notification opens the product page. Apple has no link that puts a
phone straight in the bag, so you still answer trade-in and AppleCare, then
choose store pickup.

Set `buy_link_base` to your EPP store address to land in that store instead
(open the EPP store once in your browser so its Shopping Agreement is
accepted).

### Choosing which messages go where

Each destination can take only some kinds of message, e.g. a Telegram
channel that should only hear "it's in stock" while problems go to your
phone. Pick the kinds under `telegram_messages`, `slack_messages` and
`ha_notify_messages`; leave a list empty to send that destination everything.

| Kind | Messages |
|---|---|
| `stock` | 🟢 in stock, 🔁 still in stock, ⚪ sold out |
| `delivery` | 📦 delivery date moved earlier |
| `digest` | 📊 daily mood digest or daily summary (in `daily_summary` mode this carries the day's drops) |
| `status` | ⚠️/✅ problems and recoveries: HypeBot is blind, Apple refusing checks, can't find models, mood off |
| `test` | the startup test alert |

For example, a Telegram channel with `telegram_messages: [stock, delivery]`
and your phone left on everything. If a kind ends up going nowhere, the log
says so at startup. `--test-notify` always tests every destination.

### Daily summary instead of instant alerts

With `notify_mode: daily_summary`, stock drops, still-in-stock reminders,
sold-out notes and earlier delivery dates are not sent as they happen.
Sensors and the dashboard still update live. Instead you get one message a
day at `mood_digest_time` (21:00 by default), e.g.

```
📊 HypeBot · Mon 26 Oct
Stock: 2 drops
• 21:53 Star White 512GB, Orchard Road (~1 min)
• 21:53 Night Sky 256GB, Jewel Changi Airport (~1 min)
Delivery: Night Sky 512GB now Mon 18/01/2027 (was Mon 25/01/2027)
Mood: -0.25 (negative), was +0.10 yesterday · 40 posts
<summary of the day's discussion>
```

Durations are as precise as `interval_seconds`. The mood part appears when
mood tracking is on. Problems ("HypeBot is blind", Apple refusing
checks, mood being off) are still sent straight away. The day's events are
kept in `/data/summary.json`, so a restart doesn't lose them; a message
missed while the app was off is skipped, not sent late.

### Loud phone alerts

Restocks can be gone within a minute, so stock alerts sent through
`ha_notify_service` are marked urgent:

- `time_sensitive` (default): shown immediately, even in a Focus mode. On
  iPhone, check Settings → Notifications → Home Assistant → Time Sensitive
  Notifications is on.
- `critical`: plays a sound even when the phone is on silent or in Do Not
  Disturb. iOS asks once for permission to allow Critical Alerts for the Home
  Assistant app; allow it (Settings → Notifications → Home Assistant →
  Critical Alerts). On Android it uses the alarm channel.

With `remind_every_minutes` set, you get a "🔁 Still in stock" alert every N
minutes until the model sells out.

### Upgrading from 0.1.x

Your old `watch` entries keep working. To switch to the dropdown, pick the
same models under `models` and empty `watch` (`watch: []`), otherwise both
are watched (the same model is only watched once).

## Home Assistant sensors

One sensor per model, e.g. `sensor.hypebot_iphone_duo_night_sky_512gb`:

- state: `in_stock` or `out_of_stock`
- attributes: `stores`, `quote` (Apple's wording, e.g. "Available Today"),
  `part_number`, `buy_url`, `last_checked`

Use them in dashboards or your own automations (flash a light, announce on a
speaker).

## Online delivery dates

Every 30 minutes HypeBot reads Apple SG's standard-shipping date for each
watched model (the date the buy page shows for delivery).

- `sensor.hypebot_apple_sg_delivery`: the earliest date across your models
  (a date sensor, so its history graphs nicely), with each model's date in
  the `models` attribute.
- "📦 iPhone Duo delivery moved earlier" when a model's date comes forward,
  e.g. `Night Sky 512GB: Mon 18/01/2027 (was Mon 25/01/2027)`. Dates slipping
  later are logged but not alerted.

A date moving earlier usually means supply is improving, which is also when
stores tend to get bigger batches for pickup.

## Is Apple refusing checks?

`sensor.hypebot_apple_sg_health` shows how HypeBot is getting on with Apple:

- state: `ok`, `degraded` (more than 30% of the last hour's checks failed,
  and at least 5) or `blocked` (10 failures in a row)
- attributes: `failure_rate_percent`, `failures_last_hour`,
  `checks_last_hour`, `last_error` (e.g. `Apple SG returned HTTP 541`, Apple's
  "too many requests" answer), `last_success`, `wait_seconds` (current gap
  between checks, longer while backing off)

The last hour of checks is kept in `/data/health.json` (saved every 5 minutes
and when the app stops), so restarts don't reset these numbers.

- `cooling_down_until`: set while HypeBot is pausing after Apple's HTTP 541
  ("too many requests"). A 541 pauses stock and delivery checks for 30
  minutes instead of retrying every few minutes, and the pause survives
  restarts.

If no check has worked for 30 minutes you get one "⚠️ HypeBot is blind"
alert, and one "✅ back to normal" on the next success.

Restarting HypeBot doesn't add requests to Apple: it reuses the model list
from the last 6 hours (`/data/models.json`), and waits out the rest of the
interval since the last check (`/data/schedule.json`) before checking again.

When it leaves `ok` you get one "⚠️ Apple SG is refusing some checks" alert,
and one "✅ healthy again" when it recovers. If it happens, raise
`interval_seconds` (e.g. 90) for a while.

## iPhone Duo mood (optional)

Turn on `mood_enabled` to get a feel for how people find the iPhone Duo,
from Reddit and the news, scored by the AI Task already set up in your
Home Assistant (e.g. the Anthropic integration's `ai_task.claude_ai_task`).
HypeBot needs no AI key of its own.

| Option | Default | Notes |
|---|---|---|
| `mood_enabled` | `false` | Turns mood tracking on. |
| `mood_ai_task_entity` | `ai_task.claude_ai_task` | Any AI Task entity that can generate data. |
| `mood_subreddits` | `[iPhoneDuo]` | Subreddit names, without `r/`. |
| `mood_news_enabled` | `true` | Also read Google News. |
| `mood_news_query` | `iPhone Duo` | Google News search (Singapore edition). |
| `mood_digest_time` | `21:00` | When the daily message is sent (mood digest, or the daily summary), in Home Assistant's local time. |
| `reddit_client_id` / `reddit_client_secret` | | Optional Reddit login (see below). |

Every 30 minutes HypeBot reads new posts and headlines and sends them, in
one batch, to the AI Task, which returns a mood score from −1 (negative) to
+1 (positive) and the main themes. Posts are passed as data to describe,
never as instructions.

- `sensor.hypebot_iphone_duo_mood`: the last 24 hours' score (weighted by
  how many posts each batch had), with `label` (negative below −0.2,
  positive above 0.2, otherwise mixed), `items_24h`, the latest `themes`
  and the `sources` read.
- At `mood_digest_time`, one message to your alert destinations, e.g.
  `📊 iPhone Duo mood: -0.25 (negative), was +0.10 yesterday · 40 posts`,
  followed by a short AI-written summary. HypeBot works out the numbers
  itself; the AI only writes the summary.

**Reddit:** without a login HypeBot reads the subreddit's public feed (titles
and post text). Reddit may refuse it at times; that run then uses the news
only. A Reddit login adds the top comments of the busiest posts, but new
Reddit apps now need Reddit's approval under its
[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy).
If you're approved, create a "script" app and enter its ID and secret.

**Cost:** at most 48 small AI calls a day plus one for the digest, billed to
the account behind your AI Task integration.

Mood runs separately from stock checks; if Reddit, the news or the AI Task
fails, stock alerts are not affected. After 6 failed AI calls in a row you
get one "⚠️ HypeBot mood can't reach the AI Task" alert. If the AI Task
entity doesn't exist yet when HypeBot starts (e.g. Home Assistant is still
loading after a reboot), HypeBot keeps checking and starts mood once it
appears, alerting only if it's still missing after 10 minutes. History is kept in
`/data/mood.json`.

## When things go wrong

- **Apple refuses or fails a check:** HypeBot logs it, backs off (30 minutes
  after a 541), and keeps going. After 30 minutes without a working check you
  get one "HypeBot is blind" alert, and one "back to normal" when it recovers. Apple occasionally answers a
  scripted request with its "Page Not Found" page; that counts as a failed
  check, not "out of stock".
- **An alert destination fails:** logged; the others still get the message.
- **Restarts:** the last seen stock is kept in `/data/state.json`, so a
  restart does not re-send an alert for stock you already heard about.

## Run with plain Docker

```bash
docker run -d --name hypebot -v "$PWD/data:/data" \
  -e TELEGRAM_BOT_TOKEN=123:abc -e TELEGRAM_CHAT_ID=42 \
  -e WATCH='[{"source":"apple_sg","product":"iphone-duo","variants":["Night Sky / 512GB"]}]' \
  -e BUY_LINK_BASE=https://www.apple.com/sg \
  ghcr.io/njyjn/hypebot
```

Settings are read from `/data/options.json` (same keys as above) and any
scalar option can be overridden by its upper-case env var
(`INTERVAL_SECONDS`, `SLACK_BOT_TOKEN`, …). `WATCH` takes JSON.

## Development

```bash
npm install
npm test                       # unit tests (Vitest, recorded Apple responses)
npm run build
WATCH='[...]' OPTIONS_PATH=/nonexistent STATE_PATH=/tmp/hb.json node dist/main.js --once
node dist/main.js --test-notify   # send a test alert and exit
```

Updating the model dropdown: `npm run gen:models` reads Apple SG's buy pages
for the products in `scripts/gen-models.mjs` and rewrites
`src/sources/apple-sg-models.ts` and the `models` list in `config.yaml`; then
bump the version.

Adding a shop: implement `Source` (`src/types.ts`) in `src/sources/` and
add it to `SOURCES` in `src/main.ts` (and to the `source` list in `config.yaml`). Notifiers and sensors need no changes.

## Releasing

Bump `version` in `config.yaml` on `main`. The workflow tags the release,
builds `ghcr.io/njyjn/hypebot` for arm64, and tells
[njyjn/ha-addons](https://github.com/njyjn/ha-addons) to pick it up.

First release only:

- Add the `HA_ADDONS_PAT` repository secret (same as the other bots).
- After the first build, make the `hypebot` package public under GitHub →
  Packages → hypebot → Package settings, so Home Assistant can pull it.
