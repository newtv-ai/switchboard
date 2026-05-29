# Switchboard

> **One phone, every AI coding CLI** — drive Claude Code, Codex, Antigravity (and whatever ships next) from your phone browser. Self-hosted, plugin-based, no cloud relay.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Agents](https://img.shields.io/badge/agents-Claude%20%7C%20Codex%20%7C%20Antigravity-blue.svg)](#supported-agents)
[![Plugin API](https://img.shields.io/badge/plugin%20API-public-purple.svg)](./packages/sdk)
[![Self-hosted](https://img.shields.io/badge/self--hosted-LAN%20%2F%20Tailscale-brightgreen.svg)](#phone-access-lan--tailscale)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-1.0.0-brightgreen.svg)](./SPEC.md)

🌐 **Languages**: English · [中文](./README.zh-CN.md)

## Why Switchboard

- **One UI, every agent** — Claude Code, Codex, and Antigravity in the same PWA; no per-tool app to install.
- **Plugin-based, day-one for new CLIs** — a new agent drops in as a ~50-line adapter; even unsupported CLIs work immediately in raw PTY mode.
- **Truly self-hosted** — bytes stay on your LAN or Tailscale. No cloud relay, no account, no key escrow.
- **Wraps your existing terminal** — keep your normal `claude` / `codex` workflow on the desktop; the phone *attaches* to that live session instead of spawning a parallel one.
- **Phone never logs into the AI vendor — no ban risk** — Switchboard only relays terminal I/O between your dev box and your phone; the phone never authenticates to (or directly connects to) Anthropic / OpenAI / Google. Every API call still originates from your dev box under your normal identity, so the vendor sees the same desktop client you've always used — nothing to flag as "anomalous mobile / multi-device login."
- **Phone ↔ dev-box file transfer** — drop files from your phone straight into a folder on the dev box (and download them back) via the in-app file manager. Great for moving a screenshot, an APK to test, or a one-off text snippet without spinning up a cloud bucket.

[5-minute Quickstart →](#install) · [Architecture in 30s](#architecture-in-30-seconds) · [Full SPEC](./SPEC.md)

---

## Table of contents

- [Why Switchboard](#why-switchboard)
- [What it does](#what-it-does)
- [Architecture in 30 seconds](#architecture-in-30-seconds)
- [Install](#install)
- [Run](#run)
- [Phone access (LAN / Tailscale)](#phone-access-lan--tailscale)
- [File transfer (phone ↔ dev box)](#file-transfer-phone--dev-box)
- [Camera (phone as webcam + remote camera viewer)](#camera-phone-as-webcam--remote-camera-viewer)
- [Alarm notifications (fall detection)](#alarm-notifications-fall-detection)
- [Firewall — opening the port](#firewall--opening-the-port)
- [Supported agents](#supported-agents)
- [FAQ](#faq)
- [Project layout](#project-layout)
- [License](#license)

---

## What it does

A typical session:

```
┌─ your dev machine ─────────────────┐         ┌─ phone ─────────────────┐
│  PowerShell / Terminal             │         │  http://192.168.x.x:5173│
│  ┌──────────────────────────────┐  │   WS    │  ┌────────────────────┐ │
│  │ $ sw run claude              │  │ ────▶   │  │ claude@my-project  │ │
│  │ │ Welcome to Claude Code     │  │ ◀────   │  │ > what should I…   │ │
│  │ │ > _                        │  │  LAN /  │  │ [Esc][Tab][↑][↓]   │ │
│  │ └──────────────────────────────┘  │ Tailsc │  └────────────────────┘ │
│  Server: switchboard listening :8787│         │                         │
└─────────────────────────────────────┘         └─────────────────────────┘
```

The wrapper spawns the CLI in a real PTY, mirrors output to **both** your local terminal and any connected phone/desktop browser, and forwards input either direction. Closing the phone browser doesn't kill the session; your desktop terminal keeps working.

**Or start cold from the phone** — if nothing is wrapped yet, tap **+ New passthrough session** in the web UI to spawn a fresh shell on the dev box, then launch `claude` / `codex` / anything in it. No SSH client on the phone, no need to wake the desktop.

## Architecture in 30 seconds

- **`sw`** (one binary): the `serve` subcommand runs a Fastify HTTP+WS server (port `8787`); the `run` subcommand wraps any command in a PTY and registers it with the local server.
- **Browser UI**: React + xterm.js, served by Vite in dev (`5173`) or any static host in prod.
- **Adapters** ship as packages — built-ins: `passthrough` (any shell), `codex`, `antigravity`. Claude works via passthrough.
- **No auth in v0.1**: bind to a trusted network (LAN, Tailscale). Auth is on the roadmap.

Full design in [SPEC.md](./SPEC.md).

## Install

You need **Node.js ≥ 18.18** (22 LTS recommended). Then clone and run the installer for your OS.

```bash
git clone https://github.com/newtv-ai/switchboard.git
cd switchboard
```

### Linux / macOS

```bash
./scripts/install.sh
```

### Windows (PowerShell)

```powershell
# If you've never run a script before, allow signed scripts for your user first:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

.\scripts\install.ps1
# or, with firewall ports pre-opened (needs admin PowerShell):
.\scripts\install.ps1 -OpenFirewall
```

What the installer does:
1. Verifies Node version.
2. `npm install` (workspaces handle every package).
3. Builds `@switchboard/sdk`, `@switchboard/core`, `@switchboard/server`.
4. `npm link` so the `sw` and `switchboard` commands are on your PATH.

**node-pty native build (Windows only):** if `npm install` fails on `node-pty`, install [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload, then re-run the installer.

## Run

Two terminals:

```bash
# Terminal A — start the Switchboard server + web UI in dev mode
npm run dev
# Server on http://0.0.0.0:8787, web on http://0.0.0.0:5173
```

> **One-click launch**: the repo ships a `start.bat` (Windows, double-click) and `start.sh` (Linux / macOS, `bash start.sh`) at the project root. They free up ports `5173` / `8787` from any prior dev process and then run `npm run dev`. Equivalent to Terminal A above — Terminal B (`sw run …`) is still separate.

```bash
# Terminal B — wrap an AI CLI so phones can attach to it
sw run claude              # Anthropic's Claude Code
sw run codex               # OpenAI Codex CLI
sw run agy                 # Google Antigravity CLI
sw run -- bash             # any other command works too
```

Then open `http://localhost:5173` (or your LAN IP) in any browser. Tap the session and you're in.

For production-style serving (no Vite), build the web bundle and serve it with any static file server:
```bash
npm run build -w @switchboard/web
# serve packages/web/dist/ behind nginx / caddy / Cloudflare Tunnel / etc.
```

## Phone access (LAN / Tailscale)

### Same Wi-Fi (LAN)

1. Find your dev box's LAN IP:
   - macOS:    `ipconfig getifaddr en0`
   - Linux:    `ip -4 addr show | awk '/inet / && !/127.0.0.1/ {print $2}'`
   - Windows:  `ipconfig` → look for IPv4 under your active adapter
2. On the phone browser, open `http://<dev-ip>:5173`.
3. If it times out, your firewall is blocking inbound `5173` (and/or `8787`). See [Firewall](#firewall--opening-the-port).

### Anywhere (Tailscale)

Install [Tailscale](https://tailscale.com) on both the dev box and the phone, log in to the same tailnet, and use the dev box's Tailscale IP (`100.x.y.z`) in place of the LAN IP. No firewall changes needed; Tailscale handles NAT traversal.

## File transfer (phone ↔ dev box)

Open the web UI and click **Upload** in the header — this opens a small file manager that lets you:

- **Phone → dev box**: pick one or more files and upload them. Files land in `<repo-root>/downloads/` on the dev box. Uploads are streamed in 5 MB chunks so multi-GB files work without holding the whole file in memory.
- **Dev box → phone**: click **Download** next to any file in the list; the browser saves it through its normal download flow.

This is intentionally a single shared folder per dev box, with no auth — same trust model as the rest of Switchboard (bind to LAN / Tailscale only).

### Mobile upload fails? It's almost always a permission issue, not a bug

On phones, the browser is sandboxed and **can't always read the file you selected** — most notably:

- Media stored inside chat apps (WhatsApp / WeChat / Telegram / QQ folders).
- Files in app-private storage (Documents folder of another app, etc.).
- Some vendor "Files" apps return a file URI the browser can't open.

The fix is the same in every case: **copy the file to your phone's public Downloads folder first**, then re-select it from there.

The folder is called slightly different things depending on phone and language — they're the same place:

| Phone                  | Folder name (English)   | Chinese system |
| ---                    | ---                     | ---            |
| Android (most)         | `Download` or `Downloads` | `下载`         |
| iOS Files app          | `Downloads`             | `下载`         |

The Switchboard upload dialog will surface this hint automatically when an upload error looks permission-related.

## Camera (phone as webcam + remote camera viewer)

Switchboard includes an optional camera module powered by [go2rtc](https://github.com/AlexxIT/go2rtc). Two directions:

| Direction | What it does | Use case |
|-----------|-------------|----------|
| **Phone → Desktop** | Use your phone camera as a webcam for Zoom/Teams/WeChat | Video calls, screen recording |
| **Desktop → Phone** | View IP cameras (RTSP) or USB webcams from your phone | NAS monitoring, baby cam, 3D printer |

### Quick start

1. Start the server normally (`start.bat` or `npm run dev`). go2rtc is downloaded automatically on first launch.
2. Open the web UI → click **Cameras**.
3. **To view an IP camera**: paste an RTSP URL (e.g. `rtsp://admin:pass@192.168.1.100:554/Streaming/Channels/1`) → click Add → click View.
4. **To use phone as webcam**: on your phone, open `https://<your-ip>:5173` → Cameras → Start Camera.
   Then on desktop, open `http://localhost:1984/stream.html?src=phone_cam` to see the stream.
   To use in Zoom/Teams: OBS → Media Source → URL `http://localhost:1984/api/stream.mp4?src=phone_cam` → Start Virtual Camera.

### Dual-port access

| Port | Protocol | Features | Recommended for |
|------|----------|----------|----------------|
| `http://<ip>:5174` | HTTP | Terminal, file transfer, camera viewer | Daily use (desktop + phone terminal control) |
| `https://<ip>:5173` | HTTPS | All of the above + phone camera push | Only when you need phone-as-webcam |

**Most users should use HTTP 5174 for daily work.** HTTPS 5173 is only needed when you want to use your phone's camera as a desktop webcam (browsers require HTTPS for `getUserMedia`). Don't keep both tabs open on your phone — use one or the other.

HTTPS certificates are auto-generated on first start (self-signed, valid 5 years, stored in `certs/`). Desktop browsers show a one-time "not secure" warning — click through once and it won't appear again. Note: phone camera push is unavailable on HTTP 5174.

### Notes

- **H.264 and H.265** both supported. go2rtc handles codec negotiation automatically.
- **Camera configs persist** across server restarts (`~/.switchboard/cameras.json`).
- **Phone camera persists** across page navigation — start streaming on the Cameras page, then switch to Terminal, the stream keeps going.
- **go2rtc auto-download**: ~15MB binary downloaded from GitHub on first use. If GitHub is blocked (e.g. mainland China), see the FAQ below for manual install.
- **Firewall**: go2rtc uses port **8555** (UDP+TCP) for WebRTC. If phone camera push doesn't connect, open this port in your firewall alongside 5173/5174/8787.

### Camera module: adding video streams

The Cameras page accepts standard streaming URLs. Common formats:

**IP cameras (RTSP)**
```
rtsp://admin:password@192.168.1.100:554/Streaming/Channels/1     # Hikvision main stream
rtsp://admin:password@192.168.1.100:554/Streaming/Channels/2     # Hikvision sub stream
rtsp://admin:password@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0  # Dahua
rtsp://admin:password@192.168.1.100:554/stream1                  # generic ONVIF
rtsp://192.168.1.100:8554/mystream                               # RTSP server (no auth)
```

**HTTP streams**
```
http://192.168.1.100:8080/video                                  # MJPEG / HTTP-FLV
https://example.com/live/stream.m3u8                             # HLS
```

**RTMP**
```
rtmp://192.168.1.100/live/stream
```

**Tips:**
- Most IP cameras use port `554` for RTSP. Check your camera's admin page for the exact URL path.
- Use the **sub stream** (lower resolution) to reduce bandwidth if the main stream is too heavy.
- If unsure about the URL, try your camera's ONVIF address: `rtsp://<ip>:554/onvif1`.
- Test the URL with VLC first (`Media > Open Network Stream`) to confirm it works before adding to Switchboard.

### Camera module: go2rtc fails to download automatically

The camera module auto-downloads [go2rtc](https://github.com/AlexxIT/go2rtc) from GitHub Releases on first use. If you're behind a firewall that blocks GitHub (common in mainland China), you can install it manually:

1. Download the correct binary for your platform from a mirror or another machine:
   - Windows x64: `go2rtc_win64.zip`
   - macOS Apple Silicon: `go2rtc_mac_arm64.zip`
   - macOS Intel: `go2rtc_mac_amd64.zip`
   - Linux x64: `go2rtc_linux_amd64`
   - Linux ARM64: `go2rtc_linux_arm64`

   Official releases: https://github.com/AlexxIT/go2rtc/releases

2. Extract and place the binary:
   ```bash
   # Windows — extract go2rtc.exe to:
   %USERPROFILE%\.switchboard\bin\go2rtc.exe

   # macOS / Linux — extract and chmod:
   mkdir -p ~/.switchboard/bin
   # (copy go2rtc binary here)
   chmod +x ~/.switchboard/bin/go2rtc
   ```

3. Alternatively, put `go2rtc` anywhere on your system PATH.

4. Restart the server. You should see `[camera] module loaded` in the logs.

## Alarm notifications (fall detection)

Switchboard can push a **Web Push** notification to your phone when an external detector fires an alarm — built for fall detection, but any source can POST the webhook. Your phone buzzes and rings **even when the PWA is closed**; tap the notification to jump straight to the camera page.

**How it works:** a detector sends `POST /api/alarm`; Switchboard signs a Web Push with its own VAPID keys and hands it to the browser vendor's push service (FCM on Android/Chrome, APNs on iOS), which wakes the PWA's service worker on your phone. No vendor account — VAPID keys are auto-generated on first start into `certs/vapid-keys.json`.

**The alert label comes from the upstream.** `/api/alarm` is the single integration point; the POST body's optional `alarm_type` field *becomes* the notification — send `{"alarm_type":"暴力"}` and the phone shows "检测到暴力，点击查看", omit it and it defaults to **跌倒** (so a detector that omits it keeps working; `alarm_type` is trimmed + length-capped server-side). Other body fields are optional and only logged; the notification uses the server's **receive time** (not the payload's video offset), and repeats collapse per `<alarm_type>-<track_id>` via the notification `tag`. To wire a real detector, point it — or any script — at `http://<host>:8787/api/alarm` (plain HTTP is fine server-to-server). When `SWITCHBOARD_ALARM_SECRET` is set, HMAC-SHA256 the **raw request body** and send it as `X-Falldown-Signature: sha256=<hex>`. *Per-type icons or sounds: extend the one notification block in `packages/server/src/alarm-handler.ts`. For time-critical production alerts, also send the push with high urgency + a short TTL (the default is normal urgency / long TTL) — the `broadcast()` call is in `packages/server/src/push.ts`.*

### HTTPS: which parts need it

Only the part that touches the **phone's browser** requires HTTPS — it's a hard browser rule (Service Worker + Push API only work in a "secure context"), not a Switchboard choice:

| Leg | HTTPS? |
|---|---|
| Phone enabling alarms / opening the PWA / service-worker registration | **Required.** Use `https://<ip>:5173`, **not** the HTTP `:5174` port. (`http://localhost` is also a secure context, but that only helps the dev box itself — a phone reaching you by IP is not localhost.) |
| The webhook `POST /api/alarm` from your detector | **Not required** — it's a server-to-server call. Plain `http://<host>:8787/api/alarm` is fine on a trusted LAN. |
| Sending the push / the phone receiving it | N/A — goes through FCM/APNs over the OS push channel, independent of how the phone reached your server. Works once subscribed, even with the app closed. |

> **Trusted-cert caveat:** the auto-generated cert is self-signed, so browsers flag it. **Android Chrome** works once you accept the warning. **iOS Safari is stricter** — it only registers a service worker behind a *trusted* cert. Getting one is independent of which VLAN you use (Tailscale, ZeroTier, Nebula, WireGuard, plain LAN, …): either **(a)** install + trust the self-signed CA on the device (iOS: Settings → General → VPN & Device Management; Android: Settings → Security → install a CA certificate), or **(b)** put a genuinely-trusted cert in front for whatever hostname the phone uses — e.g. `tailscale cert` for a `*.ts.net` name, or your own domain + Let's Encrypt behind a reverse proxy.

> **Reachability (censored networks / no Google Play):** On Android, **both Chrome and Firefox deliver Web Push through Google FCM** — Firefox for Android bridges via Firebase too ([Mozilla source](https://firefox-source-docs.mozilla.org/dom/push/index.html)), so switching browser doesn't dodge it. If the phone can't reach Google (e.g. mainland China) or has no Google Play Services, the subscription still succeeds but pushes silently never arrive. Fix: route the phone through a node that *can* reach FCM — e.g. a [Tailscale exit node](#phone-access-lan--tailscale) on a VPS outside the blocked region (`tailscale up --advertise-exit-node` on the VPS, approve it in the admin console, then pick it as **Exit Node** in the phone's Tailscale app) — or any VPN — and it must stay **on** whenever an alarm could fire: Web Push rides a persistent connection, so an alarm that fires while the phone's route to FCM is down won't arrive until that route is back (and a late fall alarm is useless). **iOS is different:** Safari PWA push uses Apple **APNs**, which *is* reachable inside mainland China, so iPhones generally work without an exit node (they still need the trusted cert above). Chinese OEM push (Huawei HMS / Xiaomi MiPush / vivo·OPPO Push) is a native-app SDK channel, **not** a path for standard browser Web Push. The **server** also needs its own outbound reach to FCM/APNs **at the moment an alarm fires** (not just during setup) to send.

**Enable on your phone:**

1. Open `https://<your-ip>:5173` (or your Tailscale `https://…ts.net` URL). On **iOS, "Add to Home Screen" first** (Safari 16.4+); Android Chrome works in a normal tab.
2. Tap the **🔕 告警** bell on the home screen → allow notifications. It becomes **🔔 告警开**.

**Test without a real fall** (server running, no alarm secret set):

```bash
curl -X POST http://localhost:8787/api/alarm \
  -H 'content-type: application/json' \
  -d '{"event":"fall_alarm","track_id":1,"stgcn_action":"Fall Down","stgcn_fall_prob":0.7,"source":"manual-test/1"}'
```

Your phone should buzz immediately.

**Server config (env vars):**

| Var | Default | Purpose |
|---|---|---|
| `SWITCHBOARD_ALARM_SECRET` | _(unset)_ | When set, `/api/alarm` requires a valid `X-Falldown-Signature: sha256=<hmac>` (HMAC-SHA256 of the raw body). **Strongly recommended when the server is exposed beyond the LAN** (e.g. Tailscale Funnel); leave unset for pure-LAN. |
| `SWITCHBOARD_VAPID_CONTACT` | `admin@example.com` | Contact identifier embedded in VAPID (protocol requirement; just an identifier). |

> Web Push transport always transits the vendor's push service (FCM/APNs) — the server needs outbound internet to send. The payload is end-to-end encrypted and there's no vendor account, but it isn't "zero cloud" in the transport sense.

### Trusted, auto-renewing HTTPS cert (for iOS / no warnings)

iOS Safari only registers the service worker behind a *trusted* cert, and the self-signed pair trips warnings everywhere else. If your dev box is on Tailscale with [HTTPS enabled](https://tailscale.com/kb/1153/enabling-https), Switchboard ships a helper that fetches and renews a real `*.ts.net` cert:

```bash
node packages/web/refresh-cert.js   # writes certs/tailscale.{crt,key}; a no-op while the cert is still fresh
```

Then point the dev server at it — these two env vars take **priority** over the self-signed pair, and Vite **hot-swaps the cert every 12 h**, so a renewal applies without restarting the server:

```powershell
# Windows (persist as user env vars; use absolute paths)
setx SWITCHBOARD_TLS_CERT "<repo>\certs\tailscale.crt"
setx SWITCHBOARD_TLS_KEY  "<repo>\certs\tailscale.key"
```

```bash
# Linux / macOS
export SWITCHBOARD_TLS_CERT=<repo>/certs/tailscale.crt
export SWITCHBOARD_TLS_KEY=<repo>/certs/tailscale.key
```

`refresh-cert.js` is best-effort — it never throws and always exits 0, skipping quietly if Tailscale isn't running or the tailnet hasn't enabled HTTPS. Tailscale renews the cert near expiry on its own; run the helper on a schedule so the fresh cert lands on disk unattended:

```powershell
# Windows — weekly Scheduled Task (or use the Task Scheduler GUI)
schtasks /create /tn "Switchboard cert renew" /sc weekly /tr "node <repo>\packages\web\refresh-cert.js" /f
```

```bash
# Linux / macOS — weekly cron
0 4 * * 0  node <repo>/packages/web/refresh-cert.js
```

## Firewall — opening the port

Switchboard binds to `0.0.0.0` so anything on the network can reach it (web on `5173`, server on `8787`). If the phone can't connect, the OS firewall is blocking inbound TCP.

### Windows

The easiest path is the bundled installer flag:
```powershell
# in an admin PowerShell
.\scripts\install.ps1 -OpenFirewall
```

Or do it by hand:
```powershell
# admin PowerShell
New-NetFirewallRule -DisplayName 'Switchboard server (8787)' -Direction Inbound `
  -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private,Domain
New-NetFirewallRule -DisplayName 'Switchboard vite dev (5173)' -Direction Inbound `
  -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Domain
```

**Important — Public vs Private network**: Windows refuses to apply firewall rules for `Private,Domain` profiles when your Wi-Fi is classified as **Public**. Symptoms: rules added, port test still fails. Fix:
- Settings → Network & Internet → Wi-Fi → click the network name → **Network profile type: Private**
- or pass `-Profile Any` in the rule (less safe).

### macOS

macOS's stock firewall is per-application, not per-port. If you've enabled it (System Settings → Network → Firewall), allow inbound connections for **node** the first time you start the server — a dialog will pop up. If you blocked it by accident:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --remove $(which node)
# next start of `sw` will re-prompt
```

For users on a custom `pf`-based firewall, allow inbound TCP `5173` and `8787` on your LAN interface.

### Linux (ufw)

```bash
sudo ufw allow from 192.168.0.0/16 to any port 5173 proto tcp   # adjust subnet
sudo ufw allow from 192.168.0.0/16 to any port 8787 proto tcp
sudo ufw reload
```

### Linux (firewalld)

```bash
sudo firewall-cmd --permanent --add-port=5173/tcp
sudo firewall-cmd --permanent --add-port=8787/tcp
sudo firewall-cmd --reload
```

### Linux (iptables, no frontend)

```bash
sudo iptables -A INPUT -p tcp --dport 5173 -s 192.168.0.0/16 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8787 -s 192.168.0.0/16 -j ACCEPT
# persist with iptables-save / netfilter-persistent
```

### Verify

From another machine on the LAN:
```bash
curl http://<dev-ip>:8787/health     # expect {"ok":true,"sessions":0}
```
If that works but the phone doesn't, the phone is on a different VLAN/SSID, or you're using a guest Wi-Fi with client isolation.

## Supported agents

| Adapter id     | CLI command | Auto-detected from | Special handling                                                            |
| ---            | ---         | ---                | ---                                                                         |
| `passthrough`  | any         | (default)          | Spawns a plain shell; `sw run claude` uses this                             |
| `codex`        | `codex`     | command name       | Injects `--no-alt-screen` + isolated `CODEX_HOME` (avoids SQLite contention)|
| `antigravity`  | `agy`       | command name       | Bare wrap; OAuth happens on first run                                       |

Override the auto-detect with `--adapter <id>`. New adapter: implement the `AgentAdapter` interface from `@switchboard/sdk` and register it in `packages/server/src/server.ts`.

## FAQ

### Phone shows "site can't be reached"
- Make sure `npm run dev` is actually running (look for `Server listening` + `vite ready`).
- `curl http://<dev-ip>:8787/health` from your dev box and from a second machine on the same Wi-Fi. If the dev-box version works but external doesn't, it's the firewall — see above.
- On Windows, double-check that the Wi-Fi profile is **Private**, not Public. Public profile blocks LAN-inbound by default no matter what rules you add.
- Some routers / guest networks have "AP isolation" or "client isolation" turned on, which forbids device-to-device traffic. Switch to your main Wi-Fi or use Tailscale.

### Phone WebSocket keeps disconnecting / screen flashes every ~10 s
Some mobile browsers (Xiaomi MIUI, iOS Safari in low-power mode) cull WebSockets they think are idle. Switchboard sends an app-level keepalive every 5 s, so this should not happen. If it does, file an issue with the phone model / browser.

### Local terminal doesn't shrink/restore when phone connects/disconnects
The wrapper sends `\x1b[8;rows;cols t` to physically resize your terminal window so it matches the PTY. **This requires "Window resize reporting" enabled** in your terminal:
- Windows Terminal: enabled by default since v1.18+.
- iTerm2 / Apple Terminal / Alacritty / WezTerm: enabled by default.
- xterm: enabled by default; some `*term` forks (`urxvt` etc.) disable it.

### Codex needs to log in but I'm on a remote machine
In the codex login screen, pick **"Sign in with Device Code"**. Codex prints a short code + URL; open the URL on any device (your phone works), paste the code, authorize. Codex on the remote machine completes the flow.

### Antigravity says "not eligible in your region"
Google blocks Antigravity at the **account level** for mainland China, Russia, Iran, etc. A VPN alone is not enough — you also need a Google account whose Country Association is set to a supported region. There is no Switchboard-side workaround.

### Can I run two `sw run` instances in parallel for the same agent?
- claude: yes, no shared state.
- codex: yes — Switchboard sets `CODEX_HOME=$(mktemp -d)` per session to avoid the SQLite-lock deadlock reported in [openai/codex#20213](https://github.com/openai/codex/issues/20213).
- agy: not currently isolated; concurrent sessions share `~/.gemini/`. If you hit issues, run them with different `HOME=$(mktemp -d)` (full workaround pending — tracked in our issues).

### Port 8787 is already in use
```bash
PORT=9000 sw         # or `switchboard`
```
Pass the same port to clients via `sw run --server ws://127.0.0.1:9000 …`.

### How do I expose this on the public internet?
**Don't, yet.** There's no auth in v0.1 — anyone reaching `:8787` can drive your terminal. Use Tailscale, a private VPN, or a reverse proxy with HTTP basic-auth on top. Auth is on the roadmap.

### How do I get verbose debug logs?
```bash
SWITCHBOARD_DEBUG=1 sw                # server side
# logs lines like:
#   [switchboard:debug] refit session=abcd1234 clients=2 ownSize={...} -> resize(47,30)
#   [switchboard:debug] /ws close code=1006 reason=… hasHandle=true …
```

### Scrolling up shows duplicate banners / status lines (scrollback pollution)
This is a known upstream issue, not a Switchboard bug. Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React-for-CLI), which performs full-screen re-renders on every state change (loading observations, dismissing dialogs, SIGWINCH, etc.). Each re-render sends `ESC[H` (cursor to viewport origin) then redraws every line with `ESC[K`. When the drawn content exceeds the viewport height, the excess overflows into the scrollback buffer. The next `ESC[H` can only reach the current viewport top -- it cannot erase the overflow already pushed into scrollback. Result: each re-render deposits one "ghost frame" in scrollback. 22 re-renders = 22 duplicates. The same artifacts exist on a desktop terminal if you scroll up; Switchboard simply makes them more visible. See [claude-code#49086](https://github.com/anthropics/claude-code/issues/49086), [claude-code#52027](https://github.com/anthropics/claude-code/issues/52027) for upstream reports. **Current mitigation:** the mobile web client auto-scrolls to the latest output so duplicate frames stay out of sight during normal use; the terminal also supports dual-mode scroll handling (native browser scroll in default mode, PgUp/PgDn translation in fullscreen mode). Feedback welcome via [Issues](https://github.com/newtv-ai/switchboard/issues).

## Project layout

```
switchboard/
├── packages/
│   ├── sdk/         # public AgentAdapter contract — what third-party adapters import
│   ├── core/        # Session, RingBuffer, WrapperBackend — agent-agnostic
│   ├── server/      # Fastify HTTP+WS server + `sw run` CLI + built-in adapters
│   ├── web/         # React + xterm.js frontend
│   └── camera/      # Optional: go2rtc sidecar for camera streaming
├── scripts/
│   ├── install.sh   # Linux & macOS installer
│   └── install.ps1  # Windows installer
├── start.sh         # one-click dev launcher (Linux / macOS)
├── start.bat        # one-click dev launcher (Windows)
├── downloads/       # phone↔dev-box file-transfer drop folder (gitignored)
├── SPEC.md          # full design + roadmap; source of truth for architectural decisions
└── README.md        # this file
```

## License

[MIT](./LICENSE) — do whatever you want, no warranty.

---

### Acknowledgements

The PTY-wrap architecture is parallel to [slopus/happy](https://github.com/slopus/happy) — credit to them for proving it scales. Switchboard is built around direct LAN/Tailscale connections and a browser-only client (no native app required).
