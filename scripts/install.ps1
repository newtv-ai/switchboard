# Switchboard one-shot installer for Windows (PowerShell 5.1+ / PowerShell 7).
#
# Usage:
#   .\scripts\install.ps1                # install, build, link `sw` globally
#   .\scripts\install.ps1 -NoLink        # install + build only, skip the global link
#   .\scripts\install.ps1 -OpenFirewall  # also add a Windows Defender Firewall rule
#                                          for inbound TCP 8787 + 5173 (needs admin)
#
# What it does:
#   1. Verifies Node.js >= 18.18 (errors with install hint if missing/too old).
#   2. `npm install` at the repo root (workspaces pull every sub-package).
#   3. Builds @switchboard/sdk + core + server.
#   4. `npm link` inside packages/server so the `sw` / `switchboard` binaries
#      are on your PATH. Skip with -NoLink.
#   5. (optional) Opens TCP 8787 (server) and 5173 (vite dev) in the firewall
#      so a phone on the same LAN can reach the web UI.
#
# Note on execution policy: if the script is blocked, run:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
# or in an admin window once:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
[CmdletBinding()]
param(
  [switch]$NoLink,
  [switch]$OpenFirewall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$msg)   { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)     { Write-Host "[OK] $msg"  -ForegroundColor Green }
function Write-Warn2([string]$msg)  { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err2([string]$msg)   { Write-Host "[ERR] $msg"  -ForegroundColor Red }

# --- 1. Node check ----------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Err2 'node is not installed.'
  Write-Host 'Install Node.js >= 18.18 (22 LTS recommended) from https://nodejs.org'
  Write-Host 'Or via winget:  winget install OpenJS.NodeJS.LTS'
  exit 1
}
$nodeVer = (node -v).TrimStart('v')
$parts = $nodeVer.Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt 18 -or ($major -eq 18 -and $minor -lt 18)) {
  Write-Err2 "node $nodeVer is too old. Need >= 18.18."
  exit 1
}
Write-Ok "node v$nodeVer"

# --- 1b. node-pty native-build prerequisite hint ---------------------------
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -and
    -not (Test-Path "$env:LOCALAPPDATA\node-gyp")) {
  Write-Warn2 'No MSVC compiler detected. If npm install fails on node-pty,'
  Write-Warn2 'install "Visual Studio Build Tools 2022" with the "Desktop development'
  Write-Warn2 'with C++" workload, then re-run this script.'
  Write-Warn2 'https://visualstudio.microsoft.com/visual-cpp-build-tools/'
}

# --- 2. Install deps --------------------------------------------------------
Write-Step 'Installing npm dependencies...'
npm install
if ($LASTEXITCODE -ne 0) { Write-Err2 'npm install failed.'; exit 1 }

# --- 3. Build ---------------------------------------------------------------
Write-Step 'Building workspace libraries...'
npm run build -w @switchboard/sdk
if ($LASTEXITCODE -ne 0) { exit 1 }
npm run build -w @switchboard/core
if ($LASTEXITCODE -ne 0) { exit 1 }
npm run build -w @switchboard/server
if ($LASTEXITCODE -ne 0) { exit 1 }

# --- 4. Link `sw` globally --------------------------------------------------
if (-not $NoLink) {
  Write-Step 'Linking sw / switchboard binaries to your global npm prefix...'
  Push-Location packages/server
  try {
    npm link
    if ($LASTEXITCODE -ne 0) {
      Write-Warn2 'npm link failed. You can still run the server directly:'
      Write-Warn2 '  node packages/server/dist/index.js'
      exit 1
    }
    Write-Ok 'sw / switchboard are now on your PATH (new shell required to pick it up).'
  } finally {
    Pop-Location
  }
} else {
  Write-Warn2 'Skipped global link (-NoLink). Run with:  node packages/server/dist/index.js'
}

# --- 5. Firewall (optional) -------------------------------------------------
if ($OpenFirewall) {
  Write-Step 'Adding Windows Defender Firewall rules for ports 8787 + 5173...'
  $isAdmin = ([Security.Principal.WindowsPrincipal] `
              [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
              [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Err2 '-OpenFirewall requires an elevated PowerShell. Re-run as admin.'
    exit 1
  }
  try {
    New-NetFirewallRule -DisplayName 'Switchboard server (8787)' -Direction Inbound `
      -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private,Domain `
      -ErrorAction Stop | Out-Null
    Write-Ok 'Opened TCP 8787 (private + domain networks).'
  } catch {
    Write-Warn2 "Port 8787 rule may already exist or could not be added: $($_.Exception.Message)"
  }
  try {
    New-NetFirewallRule -DisplayName 'Switchboard vite dev (5173)' -Direction Inbound `
      -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Domain `
      -ErrorAction Stop | Out-Null
    Write-Ok 'Opened TCP 5173 (private + domain networks).'
  } catch {
    Write-Warn2 "Port 5173 rule may already exist or could not be added: $($_.Exception.Message)"
  }
  Write-Warn2 'If your Wi-Fi is classified "Public", the rules above will not apply.'
  Write-Warn2 'Switch the network profile to Private in Settings -> Network -> Properties.'
}

Write-Host ''
Write-Step 'Done.'
Write-Host 'Start the server:   sw' -ForegroundColor White
Write-Host 'Wrap a CLI:         sw run claude         # or codex / agy' -ForegroundColor White
Write-Host 'Open the web UI:    http://localhost:5173 (dev mode: npm run dev)' -ForegroundColor White
Write-Host ''
Write-Host "If the phone can't reach the server over your LAN, see README -> 'Firewall' section." -ForegroundColor White
