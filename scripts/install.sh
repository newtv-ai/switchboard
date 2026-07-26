#!/usr/bin/env bash
# Switchboard one-shot installer for Linux & macOS.
#
# Usage:
#   ./scripts/install.sh                # install, build, link `sw` globally via npm
#   ./scripts/install.sh --no-link      # install + build only, skip the global link
#
# What it does:
#   1. Verifies Node.js >= 22 (errors with install hint if missing/too old).
#   2. `npm install` at the repo root (workspaces pulls every sub-package).
#   3. Builds all runtime packages, including the optional Camera module
#      (web is built separately when serving production; dev uses `vite dev`).
#   4. `npm link` inside packages/server so the `sw` and `switchboard`
#      binaries are on your PATH. Skip with --no-link.
#
# After install:
#   sw                                  # start the server
#   sw run claude                       # wrap claude code in any other terminal
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

LINK=1
for arg in "$@"; do
  case "$arg" in
    --no-link) LINK=0 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) red "unknown flag: $arg"; exit 2 ;;
  esac
done

# ─── 1. Node check ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  red "node is not installed."
  echo "Install Node.js >= 22. On macOS:  brew install node"
  echo "On Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "On Arch:           sudo pacman -S nodejs npm"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  red "node $(node -v) is too old. Need >= 22."
  exit 1
fi
green "✓ node $(node -v)"

# ─── 2. Install deps ──────────────────────────────────────────────────────────
bold "Installing npm dependencies…"
npm install

# ─── 3. Build ─────────────────────────────────────────────────────────────────
bold "Building runtime packages…"
npm run build:runtime

# ─── 4. Link `sw` globally ────────────────────────────────────────────────────
if [ "$LINK" -eq 1 ]; then
  bold "Linking sw / switchboard binaries to your global npm prefix…"
  ( cd packages/server && npm link ) || {
    yellow "npm link failed (often needs sudo on system-installed node)."
    yellow "Either rerun with: sudo ./scripts/install.sh"
    yellow "or run without linking and invoke directly:"
    yellow "  ./scripts/install.sh --no-link"
    yellow "  node packages/server/dist/index.js"
    exit 1
  }
  green "✓ sw / switchboard are now on your PATH"
else
  yellow "Skipped global link (--no-link). Run with:  node packages/server/dist/index.js"
fi

echo
bold "Done."
echo "Start the server:   sw"
echo "Wrap a CLI:         sw run claude            # or codex / agy"
echo "Open the web UI:    http://localhost:5173 (dev) or build & serve packages/web/dist for prod"
echo
echo "If the phone can't reach the server over your LAN, see README → 'Firewall' section."
