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

When it leaves `ok` you get one "⚠️ Apple SG is refusing some checks" alert,
and one "✅ healthy again" when it recovers. If it happens, raise
`interval_seconds` (e.g. 90) for a while.

## When things go wrong

- **Apple refuses or fails a check:** HypeBot logs it, backs off, and keeps
  going. After 10 failures in a row you get one "can't reach Apple SG" alert,
  and one "back to normal" when it recovers. Apple occasionally answers a
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
