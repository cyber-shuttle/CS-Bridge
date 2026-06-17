# CS-Bridge (CyberShuttle VS Code Extension)

VS Code extension for remote HPC development. From the sidebar you add an SSH host (a login node with SLURM),
create a **session** describing the resources you want, and start it. CS-Bridge submits an `sbatch` job that runs the
**linkspan** agent on the allocated compute node, opens a **Microsoft Dev Tunnel** to it, forwards the compute-node
SSH server to a local port **in-process**, writes a per-session `cshost-<id>` entry to `~/.cybershuttle/ssh_config`,
and opens a `vscode-remote://ssh-remote+cshost-<id>/…` window. The OS-native `ssh` binary (with a CS-Bridge-managed
ControlMaster pool) is the actual transport — CS-Bridge does not bundle, depend on, or call into Remote-SSH; it just
emits the `ssh-remote+` URI for whatever URI handler is installed (typically `ms-vscode-remote.remote-ssh`).

A session's lifecycle reads as: **created → started → connected → stopped → started again → removed.**
There is no local-filesystem mounting today.

## Prerequisites

- Node.js 20.x, VS Code `^1.98.0`, TypeScript `^5.9`

```bash
npm install          # install dependencies first
```

## Commands

```bash
npm run compile      # node esbuild.js — build the extension + 3 webview bundles into out/ (+ copy codicons)
npm run watch        # esbuild in watch mode (extension + webviews)
npm run check-types  # tsc --noEmit twice: root tsconfig (extension) + src/ui/tsconfig.json (webviews)
npm run lint         # eslint src
npm run test         # node --import tsx --test  (unit tests: src/modules/*.test.ts + src/ui/logic/*.test.ts)
npm run package      # vsce package -> .vsix  (vscode:prepublish = check-types + esbuild --production)
npm run dev          # install + package + install-ext into VS Code
```

Press F5 in VS Code to launch an Extension Development Host. Always run `check-types` (esbuild does **not**
type-check) and `test` before declaring a change done.

## Build pipeline

`esbuild.js` runs two esbuild contexts plus a codicon copy:

1. **Extension** — bundles `src/extension.ts` → `out/extension.js` (CJS, `platform: node`, `target: node20`,
   externals `vscode` + `node-rsa`).
2. **Webviews** — bundles each sidebar view root `src/ui/webviews/{sessions,hosts,stats}.tsx` →
   `out/{sessions,hosts,stats}.js` (IIFE, `platform: browser`, Preact JSX via `jsxImportSource: preact`).
3. Copies `@vscode/codicons/dist/codicon.{css,ttf}` → `out/codicons/`.

Shared: `bundle: true`, `sourcemap: !production`, `minify: production`, alias `@` → `src`. `tsc` only
type-checks (`noEmit`), once per tsconfig — the root `tsconfig.json` excludes `src/ui`, which has its own
`src/ui/tsconfig.json` (DOM libs, Preact JSX). The `.vsix` ships `out/`, `resources/`, `scripts/`,
README/LICENSE/CHANGELOG, and `package.json` — no `src/` or `node_modules/` (see `.vscodeignore`).

## Source Layout

```
src/
  extension.ts          # activate(): init SshManager + store, construct the 3 providers, register views + commands
  webviewProvider.ts    # abstract WebviewProvider base: webview wiring + nonce-CSP HTML shell (renderHtml) for all views
  sessionProvider.ts    # Sessions view: message dispatch, view state, owns the JobStatusMonitor + user dialogs
  sshHostProvider.ts    # SSH Hosts view: add/refresh/remove hosts; "Connect" hands off via csbridge.newSessionOnHost
  statsProvider.ts      # Stats view: skeleton ("Coming Soon")
  extensionStore.ts     # sessions.json persistence + file lock + cross-window fs.watch + windowPids + liveAndCleanup
  models.ts             # SlurmSession + status union, cluster/tunnel types, persistableConnectionInfo()
  logger.ts             # output-channel Logger singleton + errMsg() helper
  modules/                                 # capability layer; (V) = vscode-free & unit-testable, (C) = vscode-coupled
    sshSupport.ts        # (C) SshManager: OS-ssh ControlMaster pool, askpass IPC, runRemoteCommand, per-session ssh_config + keys, ~/.ssh/config Include patch
    tunnelSupport.ts     # (C) Dev Tunnels SDK: tunnel CRUD, remote sshd create + port forward, in-process relay client, MS auth
    sessionSupport.ts    # (C) lifecycle composition (prepareLaunch/launchSession/stopSession) + JobStatusMonitor
    slurmSupport.ts      # (V*) SLURM-over-SSH queries: getSlurmJobStatus/Output, getSlurmClusterInfo  (*imports Logger)
    slurmLaunch.ts       # (V) launch steps over an injected RemoteRunner + LogSink (slurm check / linkspan install / sbatch submit)
    slurmParse.ts        # (V) pure SLURM text: buildSlurmScript, parseSacctStatus, parsePartitionLine
    sessionMachine.ts    # (V) status domain: computeStatusTransition + isTerminal/isCloseable/isStoppable/isRelayLive
    sshHostsStore.ts     # (V) ssh-config parse/edit (user + system hosts), buildSshConfigBlock + SSH_RESILIENCE_OPTIONS
    sshCommandParser.ts  # (V) parse an `ssh …` command line into a Host config entry (shell-quote + posix-getopt)
    linkspanSupport.ts   # (V) checkLinkspanHealth (GET /health over the tunnel, 2s timeout)
    fsSupport.ts         # (V) isPidAlive (kill -0) + cross-process file lock/release (SharedArrayBuffer + Atomics)
  ui/                                      # webview UI — Preact + TypeScript, bundled per-view by esbuild
    webviews/{sessions,hosts,stats}.tsx    # the three view roots (render() into #root)
    platform/vscode.ts   # acquireVsCodeApi bridge: post() + useWebviewState() ('ready' on mount, re-render on 'state')
    components/           # SessionCard.tsx, HostForm.tsx, base/* (Preact wrappers over @vscode-elements/elements)
    logic/                # (V, tested) pure view logic: session.ts (status→dot/actions/labels), cluster.ts (resource options)
scripts/
  askpass.{js,sh,cmd}    # SSH_ASKPASS bridge (Electron-as-node) routing password/passphrase prompts to VS Code dialogs
  info.sh                # standalone SLURM capabilities probe — NOT currently invoked (cluster info is queried inline)
resources/               # csbridge.svg/.png (activity-bar + command icons)
```

## Architecture

- **One provider per view, over a shared base.** `SessionProvider`/`SshHostProvider`/`StatsProvider` all
  `extends WebviewProvider` (`webviewProvider.ts`), which owns the common wiring: `enableScripts`, the nonce-gated
  CSP HTML shell that loads `out/<viewKind>.js`, routing `onDidReceiveMessage` → `handleMessage`, re-pushing on
  (re)visibility → `pushState`, and tracking/clearing the resolved `_view`. Subclasses set `viewKind` and override
  `handleMessage`/`pushState`/`onResolved`. Providers are decoupled; the only cross-view handoff is SSH Hosts →
  Sessions via the internal `csbridge.newSessionOnHost` command (`SessionProvider.startSessionDraft`).

- **Webview UI is Preact + TypeScript** in `src/ui/`. Each sidebar view has a root (`webviews/*.tsx`) esbuild-bundles
  to `out/<view>.js`; the only routing is the `<script src>` the shell injects per `viewKind`. The webview talks to
  the extension only through `platform/vscode.ts`: `post({command,…})` out, and `useWebviewState` in (posts `ready`
  once, re-renders on each `{command:'state', state}` push). Pure presentation logic lives in `ui/logic/*` (unit-tested);
  `base/*` are thin wrappers over `@vscode-elements/elements` web components.

- **Session status model.** Statuses: `not_started · submitting · queued · preparing · ready_to_connect · connecting ·
  connected · disconnected · stopping · stopped · failed · completed`. The category predicates that gate behavior live
  in the vscode-free `sessionMachine.ts` as the single source of truth, shared by the provider, the monitor, and the
  webview: `isTerminal` (stopped/failed/completed), `isCloseable` (terminal + not_started), `isStoppable`
  (everything non-terminal except not_started and the in-flight `stopping`), `isRelayLive`
  (ready_to_connect/connecting/connected). `computeStatusTransition(current, slurmStatus)` is the pure poll-loop
  transition table.

- **Two-step connect.** *Step 1 (remote)*: bring up the compute-node sshd and expose it on the Dev Tunnel —
  `ensureRemoteSession` → `createSshServer` (POST to the linkspan API) + `forwardSshPortOnTunnel`; driven once per
  session by `JobStatusMonitor.prepareRemote` (→ `ready_to_connect`). *Step 2 (local)*:
  `SessionProvider._connectSessionToTunnel` → `connectSessionToTunnel` opens an in-process `TunnelRelayTunnelClient`,
  writes the `cshost-<id>` ssh_config entry, and opens the `vscode-remote://ssh-remote+cshost-<id>/…` window (→ `connected`).
  On a Step-2 failure it falls back to `ready_to_connect` (Step 1 still live) or `disconnected`.

- **JobStatusMonitor** (`sessionSupport.ts`) is provider-owned (one per window, `new JobStatusMonitor()`), polling every
  5s. For relay-live sessions it pings `checkLinkspanHealth` instead of SLURM; otherwise it `getSlurmJobStatus` and
  applies `computeStatusTransition`. It owns poll-driven transitions; `SessionProvider` owns user-action transitions
  (`submitting`/`connecting`/`connected`/`stopping`) and all dialogs.

- **SSH transport** (`sshSupport.ts`). `SshManager` (singleton) runs every remote command through the OS `ssh` binary
  multiplexed over a ControlMaster socket (socket name = SHA-256 hash of the host, to stay under the 104-byte Unix
  socket limit; multiplexing is skipped on Windows). Password/passphrase prompts go through the `SSH_ASKPASS` bridge
  (`scripts/askpass.*`) which IPCs to `vscode.window.showInputBox`. Per-session it writes a `cshost-<id>` Host block to
  `~/.cybershuttle/ssh_config` (`addSshConfigEntry` / `removeSshConfigEntry`, block built by
  `sshHostsStore.buildSshConfigBlock` with the SSH-resilience options) and a 0600 key under `~/.cybershuttle/ssh_keys/`,
  and prepends an `Include ~/.cybershuttle/ssh_config` line to `~/.ssh/config` (`_ensureSshInclude`) so the aliases resolve.

- **Tunnels** (`tunnelSupport.ts`). Dev Tunnels are managed in-process via `@microsoft/dev-tunnels-*` (no `devtunnel`
  CLI); `ensureDevTunnel`/`removeDevTunnel` do CRUD, `connectSessionToTunnel` runs the relay client (tracked in
  `activeTunnelClients`, freed by `disposeTunnelClient`/`disposeAllTunnelClients`). Microsoft auth uses
  `vscode.authentication.getSession('microsoft', [DEV_TUNNELS_SCOPE])`.

- **Persistence** (`extensionStore.ts`). Sessions live in `~/.cybershuttle/sessions.json`, guarded by the
  `fsSupport` cross-process lock; a `fs.watch` on the dir syncs state across windows. `persistableConnectionInfo`
  writes only the reattach refs (`sshTunnelId`/`sshPort`/`region`) — secrets and the ephemeral local port stay
  in-memory. `windowPids` is owned by the atomic `mutateWindowPids`; `liveAndCleanup` prunes dead pids and computes
  `isCurrent`/`windowAlive`. On load, legacy statuses migrate (`cancelled`→`stopped`, `cancelling`→`stopping`) and
  `connected`/`connecting` demote to `ready_to_connect` (the relay is gone after a reload; Step 2 re-runs).

- **Sidebar vs. remote (cshost) window.** `extension.ts` reads the workspace URI authority; in a
  `ssh-remote+cshost-<id>` window it passes that id as `SessionProvider._myId` (scoped, observe-only — no monitoring)
  and sets the `csbridge.remote` context so the SSH Hosts + Stats views hide. The sidebar window (`_myId` undefined)
  sees all sessions and drives the monitor.

- **Testability seam = vscode-free extraction, not DI/hooks into vscode-coupled files.** Tests run under
  `node --import tsx --test` with no vscode shim, and the `(C)` modules import `vscode` at load (directly or via
  `Logger.getInstance()`), so they can't be imported in a test — injecting fakes into them is inert. To make logic
  testable, extract the pure/effect-light part into a `(V)` module and test that. `slurmLaunch` is the pattern for
  I/O-bearing logic: take an injected `RemoteRunner`/`LogSink`, mutate only the in-memory session, and let the caller
  (`sessionSupport`) persist + report progress. Do **not** add optional/pluggable hooks or deps-objects to the
  vscode-coupled modules — that's scaffolding that doesn't unblock tests.

## Manifest contributes (`package.json`)

- One activity-bar container `csbridge` with three webview views: `csbridge.sessionsView` (always), and
  `csbridge.hostsView` / `csbridge.statsView` (`when: !csbridge.remote`).
- Commands (all `category: "CS Bridge"`, hidden from the palette, shown only as view-title icons): `csbridge.newSession`
  (`$(add)`) + `csbridge.switchAccount` (`$(account)`) on the Sessions title; `csbridge.addHost` (`$(add)`) +
  `csbridge.refreshHosts` (`$(refresh)`) on the SSH Hosts title. The account/refresh icons sit at `navigation@0`,
  the `+` at `navigation@1`. `csbridge.newSessionOnHost` is registered programmatically (internal handoff, not in the manifest).
- `activationEvents: ["onStartupFinished"]`, `extensionKind: ["ui"]`.

## External processes / files

- **linkspan** — runs on the compute node at `~/.cybershuttle/bin/linkspan`; `slurmLaunch.installLinkspan` deploys it
  via `curl -fsSL …/releases/latest/download/linkspan_Linux_<arch>.tar.gz | tar -xz` when missing/outdated.
- **OpenSSH** (`ssh`) — system binary; every remote command goes through it (ControlMaster-multiplexed). Not bundled.
- **`~/.cybershuttle/`** — `sessions.json`, `ssh_config` (cshost-* aliases, Include'd into `~/.ssh/config`),
  `ssh_keys/` (per-session 0600 keys), `ssh_control/` (hashed ControlMaster sockets); on the remote: `bin/linkspan`
  and `logs/linkspan-session-<jobid>.{out,err}` (tailed during connect to discover the server port).

## Unimplemented (do not document as features)

- **FRP tunnel provider** — only `devtunnel` works end-to-end; there is no FRP code (the `'frp'` literal in the
  `TunnelCredential` type is a vestige).
- **Filesystem sync** (FUSE/mutagen/sshfs), the **Stats** view (skeleton), a **plain-SSH (non-SLURM) launch** path,
  and any admin/telemetry server — no code exists. See README Roadmap.

## Gotchas

- `check-types` runs **two** tscs (root + `src/ui/tsconfig.json`); esbuild never type-checks. A `.tsx` type error only
  surfaces via `check-types`.
- Webview UI uses **Preact**, not React — hooks must come from `preact/hooks` (the esbuild + tsconfig
  `jsxImportSource` is `preact`).
- The cross-window `fs.watch` + file lock in `extensionStore` is load-bearing — multiple windows share session state;
  don't bypass the lock.
- The `~/.ssh/config` → `Include ~/.cybershuttle/ssh_config` line is load-bearing; removing it without removing
  CS-Bridge leaves broken `cshost-*` references.
- `createSshServer` is **not** idempotent; `ensureRemoteSession` guards re-creation (only creates an sshd if `sshPort`
  is unset) to avoid leaking compute-node daemons.
- The webview `.tsx` rendering has no automated tests — only `ui/logic/*` and the `(V)` modules are unit-tested; UI
  changes need a manual pass in the Extension Development Host.
- The SLURM job state `CANCELLED` (and `scancel`) are SLURM's own terms and are kept; they map to our `'stopped'`
  session status. Everything in *our* vocabulary is "stop", not "cancel".

## Code Discipline

Every line must earn its place. Reject scaffolding: helpers called once (inline them), abstractions with no second
caller, defensive checks for impossible states, comments that restate well-named code. Prefer first-class, declarative
code that reads without comments; reach for a comment only to capture a non-obvious *why*. Default to the smallest
correct implementation; when a diff grows, scan for lines that can merge or disappear before declaring done.
