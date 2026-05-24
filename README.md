# Switchboard

> **One phone, every AI coding CLI** — drive Claude Code, Codex, Antigravity (and whatever ships next) from your phone browser. Self-hosted, plugin-based, no cloud relay.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Agents](https://img.shields.io/badge/agents-Claude%20%7C%20Codex%20%7C%20Antigravity-blue.svg)](#supported-agents)
[![Plugin API](https://img.shields.io/badge/plugin%20API-public-purple.svg)](./packages/sdk)
[![Self-hosted](https://img.shields.io/badge/self--hosted-LAN%20%2F%20Tailscale-brightgreen.svg)](#phone-access-lan--tailscale)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](./SPEC.md)

🌐 **Languages**: English · [中文](./README.zh-CN.md)

## Why Switchboard

- **One UI, every agent** — Claude Code, Codex, and Antigravity in the same PWA; no per-tool app to install.
- **Plugin-based, day-one for new CLIs** — a new agent drops in as a ~50-line adapter; even unsupported CLIs work immediately in raw PTY mode.
- **Truly self-hosted** — bytes stay on your LAN or Tailscale. No cloud relay, no account, no key escrow.
- **Wraps your existing terminal** — keep your normal `claude` / `codex` workflow on the desktop; the phone *attaches* to that live session instead of spawning a parallel one.
- **Phone never logs into the AI vendor — no ban risk** — Switchboard only relays terminal I/O between your dev box and your phone; the phone never authenticates to (or directly connects to) Anthropic / OpenAI / Google. Every API call still originates from your dev box under your normal identity, so the vendor sees the same desktop client you've always used — nothing to flag as "anomalous mobile / multi-device login."

[5-minute Quickstart →](#install) · [Architecture in 30s](#architecture-in-30-seconds) · [Full SPEC](./SPEC.md)

---

## Table of contents

- [Why Switchboard](#why-switchboard)
- [What it does](#what-it-does)
- [Architecture in 30 seconds](#architecture-in-30-seconds)
- [Install](#install)
- [Run](#run)
- [Phone access (LAN / Tailscale)](#phone-access-lan--tailscale)
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

## Project layout

```
switchboard/
├── packages/
│   ├── sdk/         # public AgentAdapter contract — what third-party adapters import
│   ├── core/        # Session, RingBuffer, WrapperBackend — agent-agnostic
│   ├── server/      # Fastify HTTP+WS server + `sw run` CLI + built-in adapters
│   └── web/         # React + xterm.js frontend
├── scripts/
│   ├── install.sh   # Linux & macOS installer
│   └── install.ps1  # Windows installer
├── SPEC.md          # full design + roadmap; source of truth for architectural decisions
└── README.md        # this file
```

## License

[MIT](./LICENSE) — do whatever you want, no warranty.

---

### Acknowledgements

The PTY-wrap architecture is parallel to [slopus/happy](https://github.com/slopus/happy) — credit to them for proving it scales. Switchboard is built around direct LAN/Tailscale connections and a browser-only client (no native app required).
