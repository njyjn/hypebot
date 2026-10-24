# HypeBot design

Date: 2026-10-24
Status: approved in chat, pending written review

## Goal

Get a phone alert the moment a hard-to-find product can be picked up in store,
without refreshing the shop website by hand. First target: iPhone Duo at
Apple Store Singapore.

Success means: when any watched model shows "available" for pickup at a
watched store, an alert reaches every configured destination within about one
check interval, once per restock.

## Scope

In scope (v1):

- Source: Apple Store Singapore in-store pickup (Orchard Road, Marina Bay
  Sands, Jewel Changi Airport).
- Model selection by plain names ("Star White / 512GB"), resolved to Apple
  part numbers automatically.
- Destinations: Slack bot, Telegram bot, Home Assistant notify service. Any
  combination.
- Home Assistant sensors, one per watched model.
- Runs as a Home Assistant add-on listed in `njyjn/ha-addons`, and as a plain
  Docker container.

Out of scope (v1): automatic checkout or reservation, other countries or
retailers (Tesla etc.), a web UI, online delivery dates.

The structure must let a new source be added as one module without changing
the watcher, notifiers or sensors.

## Stack and repos

- Node 24 (LTS), TypeScript, no web framework. Runtime dependencies kept
  minimal (built-in `fetch`). Tests with Vitest.
- `njyjn/hypebot`: app, `config.yaml` (add-on manifest), `Dockerfile`
  (`node:24-alpine`), `.github/workflows/release.yml` copied from ChoreBot
  (tag from `config.yaml` version, build `linux/arm64` image to
  `ghcr.io/njyjn/hypebot`, dispatch `hypebot-released` to `njyjn/ha-addons`
  using the `HA_ADDONS_PAT` secret).
- `njyjn/ha-addons`: add `hypebot` submodule, `repository.json` entry
  (arch aarch64, machines raspberrypi4/5, icon `mdi:bell-ring`), add
  `hypebot-released` to `update-submodule.yml` (dispatch types and manual
  choices), README section.

## Architecture

```
src/
  main.ts            entry: load config, resolve, start loop; --test-notify flag
  config.ts          read /data/options.json or env vars, validate, apply defaults
  watcher.ts         one check: query sources, diff with state, alert, update sensors
  state.ts           load/save /data/state.json
  sources/
    types.ts         Source interface
    apple-sg.ts      catalogue resolution + pickup availability
    aliases.ts       colour nicknames (white -> Star White, black -> Night Sky ...)
  notifiers/
    types.ts         Notifier interface
    slack.ts         chat.postMessage with bot token
    telegram.ts      sendMessage with bot token
    ha.ts            POST /services/notify/<name> via Supervisor
  ha-sensors.ts      POST /states/sensor.hypebot_* via Supervisor
  format.ts          alert message text (plain + Slack mrkdwn + Telegram HTML)
```

### Interfaces

```ts
interface WatchItem {
  id: string;            // stable, e.g. "apple_sg:MK2G4X/A"
  source: string;        // "apple_sg"
  product: string;       // "iphone-duo"
  productName: string;   // "iPhone Duo"
  variantName: string;   // "Night Sky 512GB"
  partNumber: string;
  buyUrl: string;
}

interface Availability {
  itemId: string;
  stores: { name: string; quote: string }[];   // empty = unavailable
}

interface Source {
  name: string;
  resolve(entries: WatchConfig[]): Promise<WatchItem[]>;  // throws on unmatched names
  check(items: WatchItem[]): Promise<Availability[]>;
}

interface Notifier {
  name: string;
  send(msg: AlertMessage): Promise<void>;   // throws on failure
}
```

## Apple SG source

Resolution (at startup and every 6 hours):

1. GET `https://www.apple.com/sg/shop/buy-iphone/<product>`.
2. Extract the embedded product data: for each part number
   (pattern `[A-Z0-9]{5}X/A` or generally `"partNumber":"..."`), its
   `dimensionColor` and `dimensionCapacity` codes, and the colour display
   names (`"starwhite":{"value":"Star White"...}`).
3. Match each configured variant string: split on `/`, normalise (lower case,
   strip spaces), map colour via display name or alias, capacity via
   `256gb`/`256`/`1tb`. Exactly one part must match; otherwise fail with a log
   message listing valid "Colour / Capacity" options.

If a later re-resolution fails, keep the previous part numbers and log a
warning.

Availability (every check):

- GET `https://www.apple.com/sg/shop/retail/pickup-message?pl=true&location=238859&parts.0=...&parts.N=...`
  (all watched parts in one request).
- For each store and part, `pickupDisplay == "available"` means in stock;
  keep `storeName` and `pickupSearchQuote`.
- Filter to `apple_sg_stores` if set (match on store name, case-insensitive).
- Browser-like User-Agent, 20 s timeout.

## Settings

```yaml
options:
  interval_seconds: 60
  watch:
    - source: apple_sg
      product: iphone-duo
      variants:
        - "Star White / 512GB"
        - "Night Sky / 512GB"
        - "Star White / 256GB"
  apple_sg_stores: []
  notify_sold_out: false
  send_test_alert: false
  ha_notify_service: ""
  slack_bot_token: ""
  slack_channel: ""
  telegram_bot_token: ""
  telegram_chat_id: ""
schema:
  interval_seconds: "int(30,3600)"
  watch:
    - source: "list(apple_sg)"
      product: "str"
      variants: ["str"]
  apple_sg_stores: ["str?"]
  notify_sold_out: "bool"
  send_test_alert: "bool"
  ha_notify_service: "str?"
  slack_bot_token: "password?"
  slack_channel: "str?"
  telegram_bot_token: "password?"
  telegram_chat_id: "str?"
```

Options are flat (not nested under `notify`) because the add-on schema UI
handles flat keys best. `config.yaml` also sets `homeassistant_api: true`,
`startup: application`, `boot: auto`, `arch: [aarch64]`, `init: false`.

Outside Home Assistant, the same keys are read from `OPTIONS_PATH` (default
`/data/options.json`), and scalar keys can be overridden by upper-case env vars
(`SLACK_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `INTERVAL_SECONDS` ...). `watch` comes
from the options file or a `WATCH` env var holding JSON.

A destination is active only when all its fields are set. Zero active
destinations is allowed (sensors only) and logged as a warning.

## Watch loop and state

Every `interval_seconds` + random 0-10 s:

1. Check all items (one request per source).
2. For each item: `newlyInStock` = stores now available that were not
   available in the last successful check.
3. If any item has newly available stores, send one combined alert to every
   active destination.
4. If `notify_sold_out` and an item went from some stores to none, send a
   sold-out note.
5. Update every sensor.
6. Save the current availability to `/data/state.json`.

State on first start is empty, so anything already in stock alerts once.

## Alerts

```
🟢 iPhone Duo in stock (Apple SG)
• Night Sky 512GB: Orchard Road, Jewel Changi Airport (Available Today)
Buy: https://www.apple.com/sg/shop/buy-iphone/iphone-duo
```

Slack uses mrkdwn, Telegram uses HTML parse mode, HA notify gets a `title`
and plain `message` plus `data.url` / `data.clickAction` so tapping the
notification opens the buy page in the HA companion app.

## HA sensors

Only when `SUPERVISOR_TOKEN` is set. Entity
`sensor.hypebot_<product>_<colour>_<capacity>` (slugified), state
`in_stock` / `out_of_stock` (not `unavailable`, which HA reserves for broken entities), attributes: `friendly_name`, `icon`
(`mdi:cellphone`), `stores` (list), `quote`, `part_number`, `buy_url`,
`last_checked`. Written every check, so they reappear after an HA restart.

## Errors

- Check failure: log, keep looping, do not change sensors or state. After 10
  consecutive failures send one "HypeBot can't reach Apple SG" alert; on the
  next success send one "back to normal" note.
- Resolution failure at startup: log the valid options, send one alert, retry
  every 10 minutes. Nothing is watched until it succeeds.
- Notifier failure: log with the destination name; other destinations still
  send. No retries (the next restock alerts again).
- Unreadable state file: log and start empty.

## Testing

- Vitest unit tests with recorded fixtures (`test/fixtures/`): Apple buy page
  extract, pickup-message responses (available, unavailable, mixed), name
  matching incl. aliases and errors, diff logic, failure streak alerts, config
  parsing (options file + env), message formatting.
- Notifier tests against a local HTTP server.
- Manual before release: `docker build`, one live check against Apple SG with
  `--once`, `--test-notify`.

## Release flow

1. Bump `version` in `config.yaml` on `main` of `njyjn/hypebot`.
2. Workflow tags, builds and pushes `ghcr.io/njyjn/hypebot:<version>`, then
   dispatches `hypebot-released`.
3. `njyjn/ha-addons` updates the submodule and `repository.json` version.

The ghcr package must be public (or HA must have registry credentials) for the
add-on to install; this is a one-time setting on GitHub after the first build.
