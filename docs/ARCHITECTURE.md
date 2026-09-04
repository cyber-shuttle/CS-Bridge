# Architecture

CS Bridge is a Slurm session manager first and a tunnel client second. Everything runs in the local VS Code
extension host (`extensionKind: ["ui"]`): it drives the cluster through the OS `ssh` binary, opens a Microsoft
Dev Tunnel to the compute node, and hands the final attach to VS Code's remote-SSH URI handler. Nothing listens
for inbound connections on the cluster.

```text
Local VS Code                              Remote HPC cluster
┌──────────────────────────┐               ┌──────────────────────────┐
│  CS Bridge sidebar       │── OS ssh ────▶│  Slurm login node        │
│  (Preact webviews)       │               │  (sbatch, sacct, sinfo)  │
│                          │               │                          │
│  SSH ControlMaster pool  │               │  Compute node:           │
│  ~/.cybershuttle/        │               │  ┌──────────────────┐    │
│    ssh_config            │               │  │  linkspan        │    │
│    ssh_keys/             │               │  │  ├─ sshd         │    │
│    ssh_control/          │               │  │  └─ Dev Tunnel ──┼────┼──▶ devtunnels.ms
│                          │               │  └──────────────────┘    │
│  Dev Tunnels SDK         │◀── tunnel ────│                          │
│  (forwards 127.0.0.1:N   │               └──────────────────────────┘
│   to compute-node sshd)  │
└──────────────────────────┘
         │
         ▼
  vscode-remote://ssh-remote+<cluster>-<last 6 of session name>/…
  (OS ssh dials 127.0.0.1:N using the per-session
   alias in ~/.cybershuttle/ssh_config)
```

## Session lifecycle

1. **Host and resources.** The user picks a host from `~/.ssh/config` and sets partition, account, CPUs, memory,
   GPUs and walltime. Partitions, accounts and limits come from `sinfo` and `sacctmgr` over SSH (`slurmSupport.ts`).
2. **Tunnel first.** `prepareLaunch` pins a random API port, creates the Dev Tunnel, and mints a host-scoped
   token for the job (`sessionSupport.ts`, `tunnelSupport.ts`). `buildSlurmScript` bakes the port, the token and
   the tunnel id into the batch script (`slurmParse.ts`).
3. **Slurm gate.** `checkSlurmAvailability` runs `sinfo` on the host; a non-zero exit aborts the launch. Slurm is
   mandatory (`slurmLaunch.ts`).
4. **Agent install.** If `~/.cybershuttle/bin/linkspan` is missing or older than the latest release, `installLinkspan`
   fetches `linkspan_Linux_<arch>.tar.gz` from the linkspan GitHub release, stages it, and moves it into place mode
   `0700`. `uname -m` values `x86_64`, `aarch64` and `arm64` map to the two published assets
   (`linkspan_Linux_x86_64.tar.gz`, `linkspan_Linux_arm64.tar.gz`); anything else is refused by name.
5. **Submit.** The script is base64-piped into `sbatch`, so the host token never lands on the cluster filesystem.
   The parsed job id is kept on the session record and the in-memory script is dropped (`slurmLaunch.ts`).
6. **Poll.** `SessionMonitor` runs one `setInterval` per active session — no central loop. Before the job runs it
   polls `sacct` and applies `computeStatusTransition`; once it runs it pings linkspan over the tunnel and falls
   back to a `sacct` cross-check only after repeated health failures (`sessionSupport.ts`, `sessionMachine.ts`).
7. **Remote sshd.** `ensureRemoteSession` asks linkspan to start an SSH server that accepts one public key, then
   registers its port on the tunnel. The session reaches `ready_to_connect`. `createSshServer` is not idempotent,
   so re-creation is guarded: an sshd linkspan reports in a non-`failed` state is reused only while this machine
   still holds that session's private key; either condition failing mints a new sshd and a new key pair. Skipping
   the guard leaks compute-node daemons.
8. **Connect.** `establishRelay` composes the step: `connectSessionToTunnel` opens an in-process
   `TunnelRelayTunnelClient` bound to `127.0.0.1:N` and returns that port, `addSshConfigEntry` writes the
   per-session `Host` block, and only on success does `openOrFocusWindow` open
   `vscode-remote://ssh-remote+<alias>/…`.
9. **Attach.** VS Code's remote-SSH URI handler runs the OS `ssh` binary against that alias, installs VS Code
   Server, and attaches the window to the compute node. CS Bridge pins that alias's
   `remote.SSH.serverInstallPath` to node-local `/tmp/cs-vscode/<sessionId>`, keeping the server off the shared
   network home where stalls miss the ptyHost heartbeat.

## The per-session SSH alias

`csHostAlias(cluster, sessionName)` is `<cluster>-<last 6 characters of the session name>` — for example
`delta-493119` (`sshHostsStore.ts`). One function builds the `~/.cybershuttle/ssh_config` `Host` line, the
`ssh-remote+` authority, and the reverse lookup that tells a remote window which session it belongs to, so all
three stay in lockstep. The alias is what VS Code prints as the window's `[SSH: …]` label, and it never equals a
bare cluster name, so it cannot shadow the login host used for Slurm.

## Source layout

Four layers, and nothing reaches past its neighbour.

- **`src/*.ts`** — the VS Code surface. `extension.ts` registers everything; one provider per contributed view
  (`sessionProvider`, `sshHostProvider`, `statsProvider`) plus `summaryPanel`, over the `webviewProvider` base that
  renders the nonce-gated CSP shell each bundle loads into. `remoteSessionController` exists only inside a remote
  window, where it owns the walltime status bar and the hand-back to a local window.
- **`src/modules/*.ts`** — the capability layer. SSH (`sshSupport`, `sshShell`, `sshHostsStore`, `sshCommandParser`),
  Slurm (`slurmLaunch`, `slurmParse`, `slurmSupport`), linkspan's HTTP client (`linkspanSupport`), Dev Tunnels
  (`tunnelSupport`), the status domain (`sessionMachine`), lifecycle composition (`sessionSupport`) and the on-disk
  stores. Modules that do not import `vscode` unit-test directly; the ones that do cannot be imported under the test
  runner at all.
- **`src/ui/`** — Preact webviews, one esbuild bundle per view. `logic/` is pure and tested, `components/` renders,
  `platform/vscode.ts` is the only thing that talks to the webview host (`post()` out, `useWebviewState()` in).
- **`resources/`, `scripts/`** — the activity-bar icons, and the `SSH_ASKPASS` helpers (`askpass.js`, `askpass.sh`).

The testability seam is extraction, not injection: to make `vscode`-coupled logic testable, move the pure or
effect-light part into a `vscode`-free module and test that. `slurmLaunch` is the pattern — it takes an injected
`RemoteRunner` and `LogSink`, mutates only the in-memory session, and leaves persistence to its caller.

## Session status model

Statuses are `not_started`, `submitting`, `queued`, `preparing`, `ready_to_connect`, `connecting`, `connected`,
`stopping`, `stopped`, `failed`, `unreachable`, `awaiting_input` (`models.ts`). The predicates that gate behaviour
live in `sessionMachine.ts` as the single source of truth shared by the provider, the monitor and the webview:
`isTerminal` (stopped/failed), `isCloseable` (terminal plus `not_started`), `isStoppable`, `isRelayLive`
(`ready_to_connect`/`connecting`/`connected`). `computeStatusTransition(current, slurmStatus)` is the pure poll-loop
transition table. `SessionMonitor` owns poll-driven transitions; `SessionProvider` owns user-action transitions and
every dialog.

## SSH transport

`SshManager` holds one persistent `ssh … bash -l` per host and multiplexes every remote command over it, framing
each call with a random marker to demux stdout, stderr and exit code (`sshSupport.ts`, `sshShell.ts`). A per-host
serial queue keeps one command in flight; a dropped shell reconnects lazily on the next command. This in-process
multiplexing is what makes Windows work, where OpenSSH has no Unix-socket ControlMaster; on Unix a ControlMaster
socket (named by a SHA-256 of the host, to stay under the 104-byte socket-path limit) is layered on as well so
several windows share one authentication. Background polls run in a batch mode that rides an existing shell or
fails fast, so they never raise a 2FA prompt nobody is watching. Password, passphrase and keyboard-interactive
prompts go out through the `SSH_ASKPASS` helper, which IPCs to a `csbridge.sshAuth` webview panel: a
newline-preserving monospace block is what lets a device-flow QR prompt render, which an input box cannot do.

## Persistence and cross-window state

Sessions are one JSON record per id under `~/.cybershuttle/sessions/`, guarded by a cross-process file lock
(`fsSupport.ts`); an `fs.watch` on the directory syncs state across VS Code windows (`extensionStore.ts`). Every
write goes through that locked read-modify-write: windows share these records, so a write that bypasses the lock
drops another window's update. Only reattach references are persisted — `sshTunnelId`, `sshPort`, `region` and
`apiPort`, the last so a reattached session health-pings the tunnel instead of polling the login node — while
secrets and the ephemeral local port stay in memory. On load, `connected` and `connecting` demote to
`ready_to_connect` (the relay is gone after a reload) and `awaiting_input` reverts to `not_started` (the prompt
can no longer be answered). Utilization history
lives separately, one file per session under `~/.cybershuttle/metrics/` (`sessionMetricsStore.ts`).

A remote window recognises itself: `extension.ts` reads the workspace URI authority, and in an
`ssh-remote+<alias>` window it scopes the Sessions view to that one session, observe-only, and sets the
`csbridge.remote` context so the SSH Hosts and Stats views hide.

## Build pipeline

`esbuild.js` runs two esbuild contexts plus a codicon copy. The extension bundles `src/extension.ts` to
`out/extension.js` (CJS, `platform: node`, `target: node20`, `vscode` and `node-rsa` external). The webviews bundle
`src/ui/webviews/{sessions,hosts,stats,summary}.tsx` to `out/*.js` (IIFE, `platform: browser`, Preact JSX). Both
share `bundle: true`, sourcemaps off and minification on under `--production`, and the `@` → `src` alias. esbuild
never type-checks: `tsc` does, once per tsconfig, since the root config excludes `src/ui`, which has its own with
DOM libs and Preact JSX. The `.vsix` ships `out/`, `resources/`, `scripts/`, `package.json` and the root
documents; `src/`, `docs/`, `.github/` and `node_modules/` are excluded (see `.vscodeignore`).

## External dependencies

- **[linkspan](https://github.com/cyber-shuttle/linkspan)** — the agent that runs on the compute node and manages
  the SSH server and the Dev Tunnel host side. Installed by CS Bridge to `~/.cybershuttle/bin/linkspan` on first
  launch. The linkspan version a release requires is recorded in [CHANGELOG.md](../CHANGELOG.md).
- **Microsoft Dev Tunnels SDK** — `@microsoft/dev-tunnels-{management,connections,contracts}`, used in-process for
  tunnel CRUD and for the relay client. There is no `devtunnel` CLI and no custom OAuth server: authentication is
  `vscode.authentication.getSession('microsoft', …)`.
- **OS-native OpenSSH** — every SSH connection is made by the system `ssh` binary. Nothing is bundled.
- **VS Code remote-SSH URI handler** — CS Bridge emits a `vscode-remote://ssh-remote+…` URI and whatever provider
  is installed (typically
  [ms-vscode-remote.remote-ssh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh))
  attaches the window. It is not declared as an `extensionDependencies` entry.
