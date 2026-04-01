# Chat

A desktop wrapper for Claude Code built with Electrobun + xterm.js. Runs Claude CLI in a terminal with project management, git actions, and auto-updates.

## Architecture

- **`src/bun/index.ts`** — Backend (Bun process): PTY spawning, RPC handlers, persistence, shell actions, auto-update
- **`src/mainview/index.tsx`** — Frontend (webview): xterm.js terminal setup, RPC wiring
- **`src/mainview/state.ts`** — Frontend state: thread management, status tracking (working/done indicators), signals
- **`src/mainview/components/`** — Preact components: `App.tsx`, `Sidebar.tsx`, `Settings.tsx`, `PromptPopup.tsx`
- **`src/mainview/index.html`** / **`index.css`** — UI markup and styles
- **`electrobun.config.ts`** — Build config: entrypoints, platform assets, code signing

## Tech Stack

- **Runtime**: [Electrobun](https://electrobun.dev) (Bun + native webview)
- **Terminal**: xterm.js v6 with WebGL renderer, FitAddon, Unicode11Addon
- **PTY**: bun-pty (Rust-based native PTY)
- **Build**: `bun run build:stable` / `bun run build:canary`

## Commands

- `bun run dev` — Start dev server with hot reload (`--watch`)
- `bun run start` — Start dev server without watch
- `bun run lint` / `bun run lint:fix` — ESLint
- `bun run format` / `bun run format:check` — Prettier

## Releasing

- Version in `package.json` does NOT need manual updates — the GH Action syncs it from the git tag
- Push a `v*` tag to trigger a release build (e.g. `git tag v0.0.9 && git push origin v0.0.9`)
- Tags with `-canary` suffix produce prerelease builds
- Builds run on macOS (codesigned + notarized) and Windows in parallel

## Conventions

- Pre-commit hook runs `eslint --fix` and `prettier --write` on staged `.ts`/`.tsx` files via lint-staged
- RPC schemas must match exactly between `src/bun/index.ts` and `src/mainview/index.tsx` (duplicated intentionally — do not extract to a shared file)
- Wrap addon loading in try/catch — if an addon fails to load it should not break terminal setup
- Guard `updateThread` calls with a change check — it clones the signal Map, so no-op calls cause unnecessary re-renders
- Background thread status indicators (working/done) use an output byte threshold (200 bytes) to filter terminal noise from real activity — don't set "working" status eagerly
