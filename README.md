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
| `watch` | iPhone Duo ×3 | List of `{source, product, variants}`. See below. |
| `apple_sg_stores` | `[]` (all) | Limit to some stores, e.g. `["Orchard Road", "Marina Bay Sands"]`. |
| `notify_sold_out` | `false` | Also send a note when a model sells out again. |
| `send_test_alert` | `false` | Send a test alert at startup. |
| `ha_notify_service` | | e.g. `notify.mobile_app_justins_iphone`. Tapping the alert opens the buy page. |
| `slack_bot_token` / `slack_channel` | | Both needed. See "Slack bot". |
| `telegram_bot_token` / `telegram_chat_id` | | Both needed. See "Telegram bot". |

### Choosing models

```yaml
watch:
  - source: apple_sg
    product: iphone-duo          # from the URL: apple.com/sg/shop/buy-iphone/iphone-duo
    variants:
      - "Star White / 512GB"
      - "Night Sky / 512GB"
      - "white / 256"            # case-insensitive; "white"/"black" nicknames work
```

Each variant is `Colour / Capacity`. HypeBot reads Apple's buy page to find
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

## Home Assistant sensors

One sensor per model, e.g. `sensor.hypebot_iphone_duo_night_sky_512gb`:

- state: `in_stock` or `unavailable`
- attributes: `stores`, `quote` (Apple's wording, e.g. "Available Today"),
  `part_number`, `buy_url`, `last_checked`

Use them in dashboards or your own automations (flash a light, announce on a
speaker).

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

Adding a shop: implement `Source` (`src/types.ts`) in `src/sources/` and
register it in `src/main.ts`. Notifiers and sensors need no changes.

## Releasing

Bump `version` in `config.yaml` on `main`. The workflow tags the release,
builds `ghcr.io/njyjn/hypebot` for arm64, and tells
[njyjn/ha-addons](https://github.com/njyjn/ha-addons) to pick it up.

First release only:

- Add the `HA_ADDONS_PAT` repository secret (same as the other bots).
- After the first build, make the `hypebot` package public under GitHub →
  Packages → hypebot → Package settings, so Home Assistant can pull it.
