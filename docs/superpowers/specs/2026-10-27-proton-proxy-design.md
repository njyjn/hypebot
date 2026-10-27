# Proton Proxy app + HypeBot `proxy_url`: design

Date: 2026-10-27. Status: draft for review.

## Goal

Send HypeBot's requests to Apple through a Proton VPN exit, so a block from
Apple lands on that IP and not on the household's home IP (which is also
used to buy when a drop happens).

Agreed with the user:

- **Isolation, not rotation.** One fixed Proton server. HypeBot does not
  switch IPs to get around a 541; the 0.9.0 cool-down still applies.
- **Our own app.** A thin wrapper around the official Gluetun image,
  instead of the third-party Xornop app.
- **It lives in `njyjn/ha-addons`** as a plain folder that Home Assistant
  builds on the Pi. It gets no repository of its own: there's no code to
  test and no image to publish.

Success:

- HypeBot's Apple traffic leaves through Proton, and the Proton app's log
  shows the exit IP and country.
- If the VPN is down, HypeBot does not quietly go back to the home IP.
- Telegram, Slack, Home Assistant and Reddit keep going direct.
- Before switching over for good, one check shows whether Apple accepts
  Proton's IP.

Not in scope:

- Rotating or randomising IPs.
- VPN providers other than Proton. Gluetun supports them, so another
  provider could be added later as a setting.
- SOCKS or Shadowsocks proxies.
- Routing other apps through the VPN.

## Part 1: the "Proton Proxy" app (`njyjn/ha-addons/proton-proxy/`)

### Files

- `config.yaml`, with these settings:
  - name "Proton Proxy", slug `proton-proxy`, `arch: [aarch64, amd64]`.
  - `privileged: [NET_ADMIN]` and `devices: [/dev/net/tun]`, which every
    VPN app needs.
  - No `ports:` mapping. The proxy is reachable only on Home Assistant's
    internal network (other apps), not from the home LAN.
  - `init: false`.
- `Dockerfile`:
  ```
  ARG GLUETUN_VERSION=<pinned, latest stable at build time>
  FROM qmcgaw/gluetun:${GLUETUN_VERSION}
  RUN apk add --no-cache jq
  COPY run.sh /run.sh
  ENTRYPOINT ["/run.sh"]
  ```
  Implementation must confirm that the official image is Alpine-based and
  that its entrypoint is `/gluetun-entrypoint`.
- `run.sh`: reads `/data/options.json` with `jq`, exports Gluetun's
  environment variables, and runs `exec /gluetun-entrypoint`. It never
  echoes the private key.
- `README.md`: where to get the Proton key, which settings to use, and
  how to find the app's hostname.
- `icon.png`.
- A `repository.json` entry for the new app.

### Settings → Gluetun environment

| App option | Default | Gluetun variable |
|---|---|---|
| `wireguard_private_key` (password) | | `WIREGUARD_PRIVATE_KEY` |
| `wireguard_address` | `10.2.0.2/32` | `WIREGUARD_ADDRESSES` |
| `server_countries` | `Singapore` | `SERVER_COUNTRIES` |
| `server_cities` (optional) | | `SERVER_CITIES` |
| `free_only` | `false` | `FREE_ONLY` (`on`/`off`) |

The app always sets:

- `VPN_SERVICE_PROVIDER=protonvpn`
- `VPN_TYPE=wireguard`
- `HTTPPROXY=on`
- `HTTPPROXY_LISTENING_ADDRESS=:8888`
- `SHADOWSOCKS=off`
- `TZ` from the Supervisor.

Gluetun's firewall stays on (its default). If the tunnel drops, the proxy
stops working rather than sending traffic out over the home connection.

Implementation must confirm the exact variable names and the Proton
WireGuard support in the pinned Gluetun version's docs before writing
`run.sh`.

### Startup

- If the key is empty, the app logs "Set wireguard_private_key (from a
  Proton WireGuard config)" and exits with an error, so Home Assistant
  shows it as stopped.
- Gluetun's own log reports the server and public IP once connected.
  That's how the user confirms the exit (e.g. "Public IP address is
  x.x.x.x (Singapore …)").

## Part 2: HypeBot `proxy_url`

### Setting

`proxy_url`: optional, empty by default.

- Must be an `http://host:port` URL, e.g. `http://<app-hostname>:8888`.
- Anything else (another scheme, or an unparsable URL) is a startup
  warning, and requests go direct.

### Behaviour

- Only Apple requests go through the proxy: the stock check, delivery
  dates and the buy page (model list). That's every call of `fetchText`
  in `src/http.ts`, which only `src/sources/apple-sg.ts` uses.
- Notifiers, Home Assistant, the AI Task, Reddit and Google News are
  unchanged.
- `fetchText` uses an undici `ProxyAgent` dispatcher when `proxy_url` is
  set. This adds the `undici` package, pinned to a version matching
  Node 24's bundled undici major.
- **No fallback to direct.** If the proxy refuses or times out, the check
  fails like any other failed check: normal backoff, and the "HypeBot is
  blind" alert after 30 minutes. The error message names the proxy, e.g.
  "Apple SG check failed: proxy http://…:8888 unreachable
  (ECONNREFUSED)", so it's clear the VPN is the problem and not Apple.
- The startup log says "Apple requests go through proxy http://host:8888".
  The proxy URL never contains credentials in this design; if it did, they
  would be masked.

### Trying Proton before switching over

The README describes a single procedure:

1. Install and start Proton Proxy, and check its log for the exit IP.
2. Set `proxy_url`, then restart HypeBot once.
3. Watch the health sensor for the next hour. If Proton's IP is refused
   (541 or "Page Not Found") more often than the home IP was, clear
   `proxy_url` and restart.

No extra request to a "what's my IP" service: Gluetun already logs the IP.

## Testing

HypeBot (Vitest):

- `loadConfig`: `proxy_url` empty → undefined. A valid http URL is kept.
  `socks5://…` or garbage → warning and undefined.
- `fetchText` with a proxy: a local fake HTTP proxy (CONNECT for https, or
  plain http for a local test server) receives the request.
- Without a proxy, the request goes direct.
- Proxy unreachable → `fetchText` rejects with a message that names the
  proxy. `runCheck` treats it as a normal failure, so no cool-down starts
  (it's not a 541).
- Schema test: `proxy_url` is optional (`url?` or `str?`).

Proton Proxy app:

- No unit tests: it's configuration only.
- Validate `config.yaml` against the Supervisor schema rules, as done for
  HypeBot.
- Build the Docker image for arm64 and amd64 in CI or locally.
- Run it once locally with a dummy key to confirm that `run.sh` maps the
  options and that Gluetun starts and fails for the expected reason (bad
  key), without echoing the key.
- First real connection: the user's Pi, with their key.

## Release

- HypeBot 0.10.0 through the normal release workflow.
- Proton Proxy 1.0.0 as a new folder in `ha-addons`. The user installs it
  from the same repository.

## Risks

- **Apple may block Proton's shared IPs.** The trial procedure above
  catches this cheaply.
- **Proton's free plan** limits countries, and Singapore needs a paid plan.
  Use `free_only` plus a country the free plan offers, if needed.
- **The key is a credential.** It's stored as a `password` option. The
  user never pastes it into chat.
- **NET_ADMIN lowers the app's security rating in Home Assistant.** That's
  expected for any VPN app.
