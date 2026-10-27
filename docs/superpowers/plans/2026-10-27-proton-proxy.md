# Proton Proxy + proxy_url Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HypeBot sends its Apple requests through a Proton VPN exit run by a new "Proton Proxy" Home Assistant app. If that exit is unavailable, HypeBot never falls back to the home IP.

**Architecture:**
- **HypeBot:** a `proxy_url` setting. Only `fetchText` (Apple requests) uses an undici `ProxyAgent` dispatcher.
- **Proton Proxy:** a folder in `njyjn/ha-addons` that wraps the official Gluetun image. A small `run.sh` maps the app's options to Gluetun environment variables.

**Tech Stack:**
- HypeBot: TypeScript, Node 24, Vitest, `undici`.
- Proton Proxy: Gluetun `qmcgaw/gluetun:v3.41.3` (Alpine), bash plus `jq`, a Home Assistant app `config.yaml`.

**Spec:** `docs/superpowers/specs/2026-10-27-proton-proxy-design.md`

## Global Constraints

- Isolation, not rotation: one fixed server; the 0.9.0 541 cool-down stays as is.
- Only Apple requests go through the proxy. Notifiers, Home Assistant, the AI Task, Reddit and Google News stay direct.
- No fallback to a direct connection when the proxy fails.
- `proxy_url` is optional and accepts only `http://host:port`. Anything else gives a startup warning and requests go direct.
- Proton Proxy:
  - `VPN_SERVICE_PROVIDER=protonvpn`, `VPN_TYPE=wireguard`, `HTTPPROXY=on`, `HTTPPROXY_LISTENING_ADDRESS=:8888`, `SHADOWSOCKS=off`.
  - Gluetun's firewall stays on.
  - No `ports:` mapping.
  - `privileged: [NET_ADMIN]`, `devices: [/dev/net/tun]`.
- Gluetun is pinned to `v3.41.3`. Verified: the image is Alpine-based with `ENTRYPOINT ["/gluetun-entrypoint"]`, and Proton WireGuard defaults the address to `10.2.0.2/32`.
- The private key is a `password` option and is never echoed or logged.
- Versions: HypeBot 0.10.0, Proton Proxy 1.0.0.

## Review Focus

1. **The proxy is down (VPN app stopped):** HypeBot logs an error naming the proxy, uses the normal backoff, starts no 541 cool-down, and sends the blind alert after 30 minutes. Test in Task 1.
2. **`proxy_url` has a trailing slash or uppercase scheme** (`HTTP://host:8888/`): accepted and normalised. Test in Task 1.
3. **The proxy answers CONNECT with 403 or 502** (Gluetun up, tunnel not ready): treated as a failed check whose message names the proxy, not reported as an Apple HTTP status. Test in Task 1.
4. **Proton Proxy is started without a key:** it exits with a clear message and does not loop starting Gluetun. Test in Task 2.
5. **The key contains `+`, `/` or `=`:** passed through to Gluetun unchanged (base64), and never printed. Test in Task 2.

---

### Task 1: HypeBot `proxy_url`

**Files:**
- Modify: `src/http.ts`, `src/config.ts`, `src/main.ts`, `config.yaml`, `package.json` (add `undici`, version 0.10.0), `README.md`.
- Test: `test/http.test.ts` (new), `test/config.test.ts`.

**Interfaces:**
- Produces:
  - `Config.proxyUrl?: string`, already normalised (e.g. `http://host:8888`).
  - `setProxy(url: string | undefined): void` in `src/http.ts`, which sets the module-level dispatcher `fetchText` uses.
  - `fetchText(url, timeoutMs?)` keeps its signature. On a proxy failure it rejects with `Error("proxy <url> unreachable (<cause code or message>)")`.

- [ ] **Step 1: Write the failing tests**
  - `config.test.ts`:
    - `proxy_url: "http://abc-proton-proxy:8888"` gives `proxyUrl === "http://abc-proton-proxy:8888"`.
    - `"HTTP://abc-proton-proxy:8888/"` gives the same value (Review Focus 2).
    - `"socks5://x:1080"` and `"not a url"` give `undefined`, plus a warning matching `/proxy_url/`.
    - Missing gives `undefined` with no warning.
    - `config.yaml` contains `proxy_url: "str?"`.
  - `http.test.ts`, using a local `net`/`http` fake proxy on port 0:
    - With `setProxy(fake)`, `fetchText("http://127.0.0.1:<target>/x")` goes through the proxy: the fake receives the absolute-URI request and forwards a canned 200 `"ok"`. The result is `{status: 200, body: "ok"}`.
    - With `setProxy(fake)`, `fetchText("https://www.apple.com/sg/shop/x")` makes the fake receive `CONNECT www.apple.com:443`. The fake answers 502, so it rejects with `/proxy http:\/\/127\.0\.0\.1:\d+ unreachable/` (Review Focus 3).
    - `setProxy("http://127.0.0.1:1")` (nothing listening) rejects with `/proxy .* unreachable \(ECONNREFUSED\)/` (Review Focus 1).
    - `setProxy(undefined)` restores direct fetches: the target server gets the request directly.
  - `run-check.test.ts`: a check rejecting with `"proxy http://x:8888 unreachable (ECONNREFUSED)"` leaves `schedule.data.cooldownUntil` empty (Review Focus 1).
- [ ] **Step 2: Run** `npx vitest run test/http.test.ts test/config.test.ts test/run-check.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `npm i undici@<major matching node -p "process.versions.undici">`.
  - `setProxy` creates `new ProxyAgent(url)` or clears it. `fetchText` passes `dispatcher` when one is set.
  - Proxy errors are told apart from Apple's HTTP responses: undici rejects CONNECT failures and connection errors before any Response exists. Those are caught in `fetchText` and re-thrown with the proxy message whenever a proxy is set.
  - `loadConfig` validates with `new URL()`: protocol `http:`, a host present. It normalises to `${protocol}//${host}`.
  - `main.ts` calls `setProxy(cfg.proxyUrl)` before resolving models, and logs `Apple requests go through proxy <url>`.
  - `config.yaml`: add `proxy_url: ""` to options and `proxy_url: "str?"` to the schema. Bump to `0.10.0`.
  - README section "Sending Apple requests through a VPN": what it does, no fallback, and the one-hour trial procedure from the spec.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: optional proxy_url for Apple requests (0.10.0)`.

### Task 2: Proton Proxy app (`njyjn/ha-addons/proton-proxy/`)

**Files:**
- Create in `ha-addons`:
  - `proton-proxy/config.yaml`
  - `proton-proxy/Dockerfile`
  - `proton-proxy/run.sh`
  - `proton-proxy/README.md`
  - `proton-proxy/icon.png` (reuse an MDI shield-lock icon rendered to 128px, or copy an existing app's icon)
  - `proton-proxy/test-run.sh` (a local check, not shipped)
- Modify in `ha-addons`: `repository.json` (add the app entry), `README.md`.

**Interfaces:**
- Consumes: nothing from Task 1. HypeBot only needs the hostname, which the user copies into `proxy_url`.
- Produces: an HTTP proxy at `http://<repo-hash>-proton-proxy:8888` on the Supervisor's internal network.

- [ ] **Step 1: Write `test-run.sh` first.** It builds the image locally (`docker build --build-arg BUILD_ARCH=amd64 -t proton-proxy-test proton-proxy`) and runs two cases, with `/data/options.json` mounted from a temp file and `--entrypoint /run.sh` plus `GLUETUN_ENTRYPOINT=/bin/env` so Gluetun itself is not started:
  - Empty key: exit code non-zero, output contains `Set wireguard_private_key`, and Gluetun is not started (Review Focus 4).
  - Key `abc+/def=`: the environment printed by the stand-in entrypoint contains:
    - `WIREGUARD_PRIVATE_KEY=abc+/def=` (Review Focus 5)
    - `VPN_SERVICE_PROVIDER=protonvpn`, `VPN_TYPE=wireguard`
    - `SERVER_COUNTRIES=Singapore`
    - `HTTPPROXY=on`, `HTTPPROXY_LISTENING_ADDRESS=:8888`
    - `SHADOWSOCKS=off`, `FREE_ONLY=off`
    - no `WIREGUARD_ADDRESSES` (left empty, so Gluetun's Proton default applies)

    Apart from that captured env dump, the script's own output never contains `abc+/def=`.
- [ ] **Step 2: Run** `bash proton-proxy/test-run.sh`. Expected: FAIL (no Dockerfile yet).
- [ ] **Step 3: Implement.**
  - `Dockerfile`: `FROM qmcgaw/gluetun:v3.41.3`, `RUN apk add --no-cache jq bash`, `COPY run.sh /run.sh`, `ENTRYPOINT ["/run.sh"]`.
  - `run.sh`:
    - `set -euo pipefail`.
    - Read each option with `jq -r '.<key> // empty' /data/options.json`.
    - Export the variables from Global Constraints. Set `SERVER_CITIES` and `WIREGUARD_ADDRESSES` only when they're set.
    - Map `FREE_ONLY` true/false to on/off. Pass `TZ` through from the environment.
    - End with `exec "${GLUETUN_ENTRYPOINT:-/gluetun-entrypoint}"`.
  - `config.yaml`:
    - name `Proton Proxy`, version `1.0.0`, slug `proton-proxy`, `arch: [aarch64, amd64]`.
    - `startup: system`, so it starts before other apps. `boot: auto`. `init: false`.
    - `privileged: [NET_ADMIN]`, `devices: [/dev/net/tun]`. No `ports`.
    - options: `wireguard_private_key: ""`, `wireguard_address: ""`, `server_countries: "Singapore"`, `server_cities: ""`, `free_only: false`.
    - schema: `password`, `str?`, `str?`, `str?`, `bool`.
  - `README.md`:
    - Where to get the key: account.protonvpn.com → Downloads → WireGuard configuration, `PrivateKey = …` line.
    - The free-plan note.
    - How to find the hostname (app info page), and the `proxy_url` to set in HypeBot.
    - That the log shows "Public IP address is …".
- [ ] **Step 4: Run** `bash proton-proxy/test-run.sh`. Expected: both cases PASS.
  - Also build for arm64 with `docker buildx build --platform linux/arm64 proton-proxy`. Expected: success.
  - Validate `config.yaml` against the Supervisor schema rules, as done for HypeBot.
- [ ] **Step 5: Commit** in `ha-addons` on a branch: `feat: Proton Proxy app (Gluetun, HTTP proxy for other apps)`. Open a draft PR.

### Task 3: Trial on the Pi (user + Claude)

- [ ] The user:
  1. installs Proton Proxy;
  2. pastes the key into its settings;
  3. starts it.

  Claude reads its log through the HA connector. Expected: `Public IP address is … (Singapore …)` and `http proxy listening on :8888`.
- [ ] The user sets `proxy_url` in HypeBot to `http://<hostname>:8888` and restarts it once. Expected HypeBot log: `Apple requests go through proxy …`, then `checked 8 item(s)`.
- [ ] After an hour, Claude compares `sensor.hypebot_apple_sg_health` failures with the home-IP baseline and recommends keeping or clearing `proxy_url`.
