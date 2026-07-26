# Switchboard — Agent Guide (AGENTS.md)

Project-level instructions for **any** AI coding CLI working in this repo.
Codex reads `AGENTS.md`; Claude Code reads `CLAUDE.md` (which points here); Gemini CLI reads
`GEMINI.md` (add one as a pointer if/when Gemini is used). Keep shared guidance **here only** so
the agents don't drift.

## What this project is
Switchboard ("总机") — a self-hostable web app that lets you drive AI coding CLIs (Claude Code,
Codex, Antigravity, …) on your dev machine from a phone browser over LAN / Tailscale.
Agent-agnostic **PTY-relay core** + plugin **adapter** system. MIT.

## Source of truth
**`SPEC.md` is the design source of truth.** Any new feature, scope change, or architectural
decision must be reflected in `SPEC.md` before/during implementation (see SPEC §11). If code and
SPEC diverge, fix one — never let them drift silently.

## Repo layout (monorepo, npm workspaces)
- `packages/sdk`    — public `AgentAdapter` contract (what 3rd-party adapters import)
- `packages/core`   — `Session`, `RingBuffer`, backends — agent-agnostic PTY relay
- `packages/server` — Fastify HTTP+WS server + `sw run` CLI + built-in adapters
- `packages/web`    — React + xterm.js frontend (the PWA)
- `packages/camera` — optional go2rtc sidecar for camera streaming

## Commands (from repo root)
- `npm run dev`       — start server + web in dev mode (concurrently)
- `npm run build`     — build all workspaces
- `npm run typecheck` — TypeScript typecheck across workspaces
- `npm test`          — run TypeScript tests with Node's built-in test runner via `tsx`
- `npm run lint`      — Biome check (lint + format)
- `npm run lint:fix`  — Biome safe auto-fix

## Conventions
- **Linter/formatter: Biome.** Run `npm run lint` before committing; `lint:fix` for safe fixes.
- **Line endings: LF** (Biome-enforced).
- **`docs/` is gitignored** — local working notes only (`planning/`, `audit/`, `architecture/`).
  Anything that must reach GitHub goes in tracked files (README, SPEC, source).
- **Adapters** live in `packages/server/src/adapters/`. A new agent works in raw ("passthrough")
  mode on day one; add an adapter for structured UX. See SPEC §4.3.
- **Don't build an LLM API proxy / gateway** — Switchboard drives existing CLIs, it doesn't
  replace them (SPEC §1.2).

## Current direction
A multi-AI "workgroup" feature is planned (shared context, task dispatch, workflow templates,
manual handoff). Phased P0–P5 — see `项目改进优化方案.md` (local planning doc).
