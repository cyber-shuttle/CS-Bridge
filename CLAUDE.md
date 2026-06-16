# CS-Bridge (CyberShuttle VS Code Extension)

VS Code extension for remote HPC development. Connects to SSH hosts that have SLURM, submits a job that runs the **linkspan** agent on the allocated compute node, opens a Microsoft Dev Tunnel, forwards the remote SSH server to a local port in-process, writes a per-session entry to `~/.cybershuttle/ssh_config`, and ends by opening a `vscode-remote://ssh-remote+cshost-<sessionId>/...` URI that any remote-SSH URI handler (typically `ms-vscode-remote.remote-ssh`) dispatches to the OS `ssh` binary. CyberShuttle does not bundle, depend on, or call into Remote-SSH itself — the OS native `ssh` is the actual transport, with a CyberShuttle-managed ControlMaster pool. There is no local-filesystem mounting today.

## Prerequisites

- Node.js 20.x, VS Code ^1.98.0, TypeScript ^5.7

```bash
npm install          # Install dependencies first
```

## Commands

```bash
npm run compile      # esbuild bundle src/extension.ts -> out/extension.js (+ copies codicons -> out/codicons/)
npm run watch        # esbuild watch mode
npm run check-types  # tsc --noEmit type check
npm run lint         # ESLint on src/**/*.ts
npm run package      # vsce package -> .vsix (triggers vscode:prepublish: check-types + production esbuild)
npm run dev          # Install + package + install into VS Code
```

Press F5 in VS Code to launch Extension Development Host for testing.

## Build pipeline

`esbuild.js` does two things: copies `node_modules/@vscode/codicons/dist/codicon.{css,ttf}` into `out/codicons/`, then bundles `src/extension.ts` into a single CJS `out/extension.js` (externals: `vscode`, `node-rsa`). `tsc` is used only for type-checking (`noEmit: true`). The .vsix ships `out/`, `resources/`, `scripts/`, README/LICENSE/CHANGELOG, and the extension manifest — no `node_modules/`.

## Source Layout

```
src/
  extension.ts                       # Entry point; registers the three view providers + commands
  baseWebviewProvider.ts             # Shared webview wiring (options, html, message/visibility/dispose) for the providers below
  sessionProvider.ts                 # Webview provider for the Sessions view; handles session commands + monitoring
  sshHostProvider.ts                 # Webview provider for the SSH Hosts view (add/refresh/remove; reads ssh configs)
  statsProvider.ts                   # Webview provider for the Stats view (skeleton; renders a "Coming Soon" placeholder)
  extensionStore.ts                  # Sessions persistence (~/.cybershuttle/sessions.json) + cross-window file watcher
  models.ts                          # SlurmSession + status type definitions
  logger.ts                          # Output-channel logger (+ errMsg helper)
  webviews/
    sessionWebview.ts                # HTML/CSP generation for the sidebar webview
  modules/
    sshSupport.ts                    # OS-ssh ControlMaster pool, askpass IPC, ~/.cybershuttle/ssh_config writer, ~/.ssh/config Include patcher
    sessionSupport.ts                # Session lifecycle composition (prepareLaunch/launchSession/cancelSession; throw on failure) + JobStatusMonitor (provider-owned)
    slurmSupport.ts                  # SLURM queries over SSH (job status/output via sacct, cluster info via sinfo/sacctmgr)
    slurmParse.ts                    # Pure SLURM text helpers (sinfo + sacct parsing, sbatch script generation); vscode-free, unit-tested
    slurmLaunch.ts                   # Pure-ish launch steps (slurm check / linkspan install / sbatch submit) over an injected RemoteRunner + LogSink; vscode-free, unit-tested
    sessionMachine.ts                # Pure SLURM-status -> session-status transition table for the poll loop; vscode-free, unit-tested
    tunnelSupport.ts                 # Dev Tunnels SDK integration (in-process); Microsoft auth via vscode.authentication('microsoft')
    linkspanSupport.ts               # linkspan tunnel health check
    fsSupport.ts                     # Filesystem helpers (PID liveness check)

resources/
  webviews/
    js/sessions.js                   # Plain JS sidebar UI (~31KB; not compiled)
    css/{common,info,sessions}.css   # Webview styling

scripts/
  askpass.{js,sh,cmd}                # SSH_ASKPASS helpers (cross-platform)
  info.sh                            # SLURM capabilities probe (sinfo + sacctmgr; exits 0 even if SLURM is missing — but the launch path still requires it)
```

## Key Patterns

- **One provider per view, over a shared base.** All three extend `BaseWebviewProvider` (`baseWebviewProvider.ts`), which owns the common wiring — enabling scripts, rendering the view bundle via `getWebviewContent`, routing messages to `handleMessage`, re-pushing on (re)visibility via `pushState`, and tracking/clearing the resolved `_view`. Subclasses set `viewKind` and override `handleMessage`/`pushState`/`onResolved` as needed. `sessionProvider.ts` serves the Sessions view (session-command dispatch + monitoring lifecycle in `onResolved`→`_ensureShared`); `sshHostProvider.ts` serves the SSH Hosts view (its own `addSshHost`/`refreshSshHosts`/`removeSshHost`, reading/writing the SSH config files); `statsProvider.ts` serves the Stats view (skeleton). The providers are decoupled; the only handoff is the SSH Hosts "Connect" action, which calls `csbridge.newSessionOnHost` to start a session draft on the Sessions view. Capability logic lives in `modules/`.
- **Webview UI is plain JS/CSS** (`resources/webviews/`) — not compiled from TypeScript. Communicates via `postMessage` / `onDidReceiveMessage`. All webviews use nonce-based CSP.
- **Microsoft auth** uses `vscode.authentication.getSession('microsoft', [DEV_TUNNELS_SCOPE], ...)`. There is no OAuth/device-flow against any CyberShuttle-hosted endpoint.
- **OS-native ssh + ControlMaster** — every remote command (info.sh, linkspan deploy, status polling, sbatch) goes through the system `ssh` binary multiplexed over a ControlMaster socket. CyberShuttle does not bundle an SSH client. Socket name = SHA-256 hash of host name to stay under the 104-byte Unix socket path limit (`modules/sshSupport.ts:118-131`). ControlMaster is skipped on Windows (no Unix-socket ControlMaster support).
- **Per-session SSH config** — `modules/sshSupport.ts` writes `cshost-<sessionId>` Host entries to `~/.cybershuttle/ssh_config`, and prepends `Include ~/.cybershuttle/ssh_config` to `~/.ssh/config` so the system `ssh` resolves the aliases (`_ensureSshInclude`, `createSSHConfigEntry`).
- **Tunnel forwarding is in-process** — `@microsoft/dev-tunnels-management` opens a `TunnelRelayTunnelClient` that forwards the remote SSH port to `127.0.0.1:<localPort>`. No separate `devtunnel` CLI binary is downloaded or invoked.
- **Final attach** — `vscode.commands.executeCommand('vscode.openFolder', vscode-remote://ssh-remote+cshost-<sessionId>/..., { forceNewWindow: true })`. CyberShuttle does not call Remote-SSH APIs or commands; it relies on whichever extension registers the `ssh-remote+` authority resolver.
- **Cross-window session sync** via `fs.watch` on `sessions.json` in `extensionStore.ts:101+` — multiple VS Code windows share session state. The `fsSupport` lock keeps concurrent writes safe; don't propose removing it.
- **SLURM is required for launch** — `checkSlurmAvailability` (`modules/sessionSupport.ts`) runs `sinfo` and throws if it exits non-zero; the launch helpers all throw on failure and `sessionProvider._launchSession`'s catch owns the failed-status transition + the single error dialog. The `info.sh` script handles missing SLURM gracefully (exits 0 with no output) for the capabilities probe, but the launch path itself has no plain-SSH fallback yet. See README Roadmap.
- **Job status polling** uses `sacct -j <jobid>` (not `squeue`).
- **Testability seam = vscode-free extraction, not DI/hooks.** Tests run under `node --import tsx --test` with NO vscode shim, and most `modules/*` import `vscode` at load (directly or via `Logger.getInstance()`), so those files cannot be imported in a test — injecting fakes into them is inert. To make logic testable, extract the pure/effect-light part into a vscode-free module (`slurmParse`, `sessionMachine`, `slurmLaunch`, `ui/logic/*`) and test that. `slurmLaunch` is the pattern for I/O-bearing logic: take an injected `RemoteRunner`/`LogSink`, mutate only the in-memory session, and let the caller (`sessionSupport`) persist + report progress. Do NOT add optional/pluggable hooks or deps-objects to the vscode-importing modules — they add scaffolding without unblocking tests.

## External Processes / Binaries

- **linkspan** — runs on the remote at `~/.cybershuttle/bin/linkspan`. Downloaded by `sessionSupport.ts:353` via `curl -fsSL ... | tar -xz` from the latest GitHub release if missing or out of date.
- **OpenSSH (`ssh`, `ssh-add`)** — system binary; CyberShuttle invokes it for every remote command and for ControlMaster multiplexing. SSH_ASKPASS bridge in `scripts/askpass.{js,sh,cmd}` routes password/passphrase prompts to VS Code dialogs.
- **`@microsoft/dev-tunnels-*` npm packages** — used in-process to manage Dev Tunnels; no external `devtunnel` CLI.

## Persistence

- **Microsoft account token** — managed by VS Code's built-in authentication provider; not stored by the extension.
- **Sessions** — `~/.cybershuttle/sessions.json` (JSON list of `SlurmSession`; cross-window file watcher reloads on external writes).
- **Generated SSH config** — `~/.cybershuttle/ssh_config` (composed config that OS `ssh` consumes via `Include` in `~/.ssh/config`).
- **Generated SSH keys** — `~/.cybershuttle/ssh_keys/id_cshost-<sessionId>` (per-session, 0600).
- **SSH ControlMaster sockets** — `~/.cybershuttle/ssh_control/` (hashed socket names).
- **linkspan binary** — (remote) `~/.cybershuttle/bin/linkspan`.
- **linkspan logs** — (remote) `~/.cybershuttle/logs/linkspan-session-<jobid>.{out,err}` — tailed during the connect loop to discover the tunnel.

## Unimplemented (do not document as features)

The following are referenced in older docs but **do not exist in code** (see README Roadmap):

- FRP tunnel provider — `tunnelSupport.ts` `frp` branch returns a placeholder credential; only `devtunnel` works end-to-end.
- Filesystem sync / FUSE / mutagen / sshfs — no code exists.
- Admin server / metrics reporting — no code exists.
- Plain-SSH (non-SLURM) launch path, storages sidebar, webview-dashboard, telemetry consent flow, local linkspan runtime, OAuth against `auth.cybershuttle.org`.

## Gotchas

- SSH ControlMaster socket path 104-byte limit → SHA-256 hash prefix (`sshSupport.ts:127`).
- `resources/webviews/js/sessions.js` is ~31KB of plain JS — not TypeScript; changes require manual UI testing.
- `sessions.json` is shared across VS Code windows; the cross-window file watcher in `extensionStore.ts` is load-bearing.
- The Restart button in the webview re-invokes `launchSession` against the existing stored session, which is how "restart with same config" is achieved — there is no separate restart command.
- CyberShuttle prepends an `Include ~/.cybershuttle/ssh_config` line to the user's `~/.ssh/config`. Removing it without also removing CS-Bridge will leave broken `cshost-*` references.

## Code Discipline

Every line must earn its place. Reject scaffolding: helpers called once (inline them), abstractions with no second caller, defensive checks for impossible states, comments that restate well-named code. Default to the smallest correct implementation; when a diff grows, scan for lines that can merge or disappear before declaring done.
