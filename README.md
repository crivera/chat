# Chat

A native macOS app for managing multiple Claude Code sessions across projects. Built with [Electrobun](https://electrobun.dev) and [xterm.js](https://xtermjs.org).

## Features

- Open multiple project folders, each with its own terminal running Claude Code
- Sidebar with activity indicators for background sessions
- Quick actions: open in VS Code, reveal in Finder, git status/pull/commit
- Sessions persist and restore on relaunch
- Settings page with session management
- Auto-updates via GitHub Releases

## Development

```bash
bun install
bun run dev
```

## Building

```bash
bun run build:stable    # stable release
bun run build:canary    # canary release
```

## Releasing

Releases are automated via GitHub Actions. Push a version tag to trigger a build:

```bash
# bump version in package.json, then:
git tag v0.1.0
git push origin v0.1.0
```

Canary releases use a `-canary` suffix:

```bash
git tag v0.1.0-canary.1
git push origin v0.1.0-canary.1
```

### Required secrets

Add these to your GitHub repo settings under **Settings > Secrets and variables > Actions**:

| Secret | Description |
|---|---|
| `ELECTROBUN_DEVELOPER_ID` | Developer ID Application certificate name |
| `ELECTROBUN_TEAMID` | Apple Developer Team ID |
| `ELECTROBUN_APPLEID` | Apple ID email for notarization |
| `ELECTROBUN_APPLEIDPASS` | App-specific password for notarization |
