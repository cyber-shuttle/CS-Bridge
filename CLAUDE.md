# CS-Bridge (CyberShuttle VS Code Extension)

VS Code extension enabling local development with remote HPC computation. Mounts local workspace on remote machines via SSH tunneling, manages SLURM jobs, and orchestrates linkspan agents on compute nodes.

## Prerequisites

- Node.js 20.x, VS Code ^1.98.0, TypeScript ^5.7

```bash
npm install          # Install dependencies first
```

## Commands

```bash
npm run compile      # TypeScript -> JS (out/)
npm run watch        # Auto-compile on save
npm run lint         # ESLint on src/**/*.ts
npm run test         # VS Code extension tests
npm run package      # Generate .vsix
npm run dev          # Install + compile + package + install into VS Code
```

Press F5 in VS Code to launch Extension Development Host for testing.

## Architecture

```
src/
  extension.ts                    # Entry point: command registration, activation
  CybershuttleViewProvider.ts     # Core orchestrator (~5600 lines): SSH, SLURM, webview logic
  SshManager.ts                   # SSH connection pooling via ControlMaster
  TunnelManager.ts                # Tunnel provider abstraction (devtunnel vs FRP)
  StorageBrowserManager.ts        # Remote file browser state
  LocalLinkspan.ts                # Local linkspan process lifecycle + persistence
  csstorage.ts                    # VS Code SecretStorage wrapper
  instrumentation/                # Telemetry: sql.js SQLite metrics collection
  vfs/                            # Virtual filesystem: mutagen sync, sshfs mount
webview-ui/
  sessions/sessions.js            # Sessions sidebar (plain JS, no TS compilation)
  storages/storages.js            # Storages sidebar
webview-dashboard/                # Metrics dashboard webview panel
```

## Key Patterns

- **CybershuttleViewProvider** is the main orchestrator — nearly all user-facing logic lives here
- **Webview UIs** are plain JS/CSS (not compiled TypeScript). Communication via `postMessage`/`onDidReceiveMessage`
- All webviews use nonce-based Content Security Policy
- Manager classes: `FooManager` pattern. Private fields: `_fieldName` prefix
- Metrics/instrumentation wrapped in try-catch to never crash the extension
- SLURM query failures fall back to "plain SSH" mode (no job scheduling)

## External Tools (auto-downloaded to ~/.cybershuttle/bin/)

- **linkspan** — VS Code Server + tunnel management on compute nodes
- **mutagen** — Bidirectional file sync
- **devtunnel** — Microsoft Dev Tunnels CLI
- **sshfs** — FUSE-based SSH filesystem

## Persistence

| Data | Location | Notes |
|------|----------|-------|
| Access tokens | VS Code SecretStorage | OS-encrypted |
| Sessions | ~/.cybershuttle/sessions.json | Survives reloads |
| Metrics | ~/.cybershuttle/metrics.db | sql.js SQLite, 90-day TTL |
| Local linkspan | ~/.cybershuttle/local-linkspan-state.json | Running instances |

## Gotchas

- SSH ControlMaster socket paths have 104-byte limit — uses SHA256 hash prefix for compliance
- `sessions.js` is ~43KB of plain JS — not TypeScript, changes require manual testing
- Metrics use WASM-based sql.js (no native binaries), auto-save every 30s with dirty flag
- Workspace state includes `windowId` to disambiguate multi-window sessions
- Telemetry consent is version-based — bumping version forces re-consent

## Configuration (VS Code settings)

- `cybershuttle.tunnelProvider`: `"devtunnel"` (default) or `"frp"`
- `cybershuttle.frpServerUrl` / `cybershuttle.frpApiKey`: FRP server config
- `cybershuttle.enableFilesystemSync`: Experimental FUSE + mutagen (default false)
- `cybershuttle.adminServerUrl`: Admin server for metrics reporting
