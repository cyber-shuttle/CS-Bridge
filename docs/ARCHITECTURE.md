# Architecture

CS Bridge is a Slurm session manager first and a cs-plane client second. Everything runs in the local VS Code
extension host (`extensionKind: ["ui"]`): it drives the cluster through the OS `ssh` binary, the job's linkspan links
out to cs-plane, CyberShuttle's control plane, which relays each connection, and CS Bridge hands the final attach to
VS Code's remote-SSH URI handler. cs-plane never reaches the cluster, and nothing listens for inbound connections on
it.

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
│    ssh_control/          │               │  │  └─ link ────────┼────┼──▶ cs-plane
│                          │               │  └──────────────────┘    │
│  scripts/forward.js      │◀── cs-plane ──│                          │
│  (relays ssh over WSS    │               └──────────────────────────┘
│   to compute-node sshd)  │
└──────────────────────────┘
         │
         ▼
  vscode-remote://ssh-remote+<cluster>-<cs-plane session id>/…
  (OS ssh runs forward.js as the ProxyCommand of the
   per-session alias in ~/.cybershuttle/ssh_config)
```

## Session lifecycle

1. **Host and resources.** The user picks a host from `~/.ssh/config` and sets partition, account, CPUs, memory,
   GPUs and walltime. Partitions, accounts and limits come from `sinfo` and `sacctmgr` over SSH (`slurmSupport.ts`).
2. **Slurm gate.** `checkSlurmAvailability` runs `sinfo` on the host; a non-zero exit aborts the launch. Slurm is
   mandatory (`slurmLaunch.ts`).
3. **Agent install.** If `~/.cybershuttle/bin/linkspan` is missing or older than 0.21.0, `installLinkspan`
   fetches `linkspan_Linux_<arch>.tar.gz` from the linkspan GitHub release, stages it, and moves it into place mode
   `0700`. `uname -m` values `x86_64`, `aarch64` and `arm64` map to the two published assets
   (`linkspan_Linux_x86_64.tar.gz`, `linkspan_Linux_arm64.tar.gz`); anything else is refused by name.
4. **Submit.** `launchSession` records the session on cs-plane under its local id and attaches the tunnel
   `csbridge.transport` names: `cybershuttle` (default) is a WebSocket link to cs-plane and never touches Dev Tunnels;
   `devtunnel` is a Dev Tunnel cs-plane creates with the Dev Tunnels account linked to CyberShuttle. Attaching is how
   cs-plane expects this job: only a linkspan holding that run's token can link. `buildSlurmScript` bakes the port
   cs-plane dials and the tunnel's flags into the script (`sessionSupport.ts`, `slurmParse.ts`), which is
   base64-piped into `sbatch` with the token only in sbatch's environment, so it never lands on the cluster
   filesystem or a command line. A failed submit stops the cs-plane session. The parsed job id is kept on the session
   record and the in-memory script is dropped (`slurmLaunch.ts`).
5. **Poll.** The sidebar polls every 5 s (`trackSessions`): a session cs-plane reports `READY` reaches
   `ready_to_connect`, and `sacct` gives the job state, which `computeStatusTransition` applies
   (`sessionSupport.ts`, `sessionMachine.ts`). Stop is `scancel`, then `POST /sessions/{id}/stop` even when `scancel`
   fails.
6. **Remote sshd.** Connect asks cs-plane for the session's capability (`GET /sessions/{id}/access`) and for an SSH
   server that accepts this machine's per-session public key (`POST /sessions/{id}/ssh`, idempotent per key).
7. **Connect.** `addSshConfigEntry` writes the per-session `Host` block, whose ProxyCommand runs `scripts/forward.js`
   under VS Code's own Node to carry ssh over `wss://…/sessions/{id}/forward/{port}`, reading the capability from a
   `0600` file; then `vscode-remote://ssh-remote+<alias>/…` opens.
8. **Attach.** VS Code's remote-SSH URI handler runs the OS `ssh` binary against that alias, installs VS Code
   Server, and attaches the window to the compute node. CS Bridge pins that alias's
   `remote.SSH.serverInstallPath` to node-local `/tmp/cs-vscode/<sessionId>`, keeping the server off the shared
   network home where stalls miss the ptyHost heartbeat.

## The per-session SSH alias

`csHostAlias(cluster, planeId)` is `<cluster>-<cs-plane session id>` — for example
`delta-s-0123456789ab` (`sshHostsStore.ts`). One function builds the `~/.cybershuttle/ssh_config` `Host` line, the
`ssh-remote+` authority, and the reverse lookup that tells a remote window which session it belongs to, so all
three stay in lockstep. The alias is what VS Code prints as the window's `[SSH: …]` label, and it never equals a
bare cluster name, so it cannot shadow the login host used for Slurm.

## Source layout

Four layers, and nothing reaches past its neighbour.

- **`src/*.ts`** — the VS Code surface. `extension.ts` registers everything; one provider per contributed view
  (`sessionProvider`, `sshHostProvider`, `statsProvider`) plus `summaryPanel` and `control` (the cs-plane client),
  over the `webviewProvider` base that renders the nonce-gated CSP shell each bundle loads into.
  `remoteSessionController` exists only inside a remote window, where it owns the walltime status bar and the
  hand-back to a local window.
- **`src/modules/*.ts`** — the capability layer. SSH (`sshSupport`, `sshShell`, `sshHostsStore`, `sshCommandParser`),
  Slurm (`slurmLaunch`, `slurmParse`, `slurmSupport`), the status domain (`sessionMachine`), lifecycle composition
  (`sessionSupport`) and the on-disk stores. Modules that do not import `vscode` unit-test directly; the ones that do
  cannot be imported under the test runner at all.
- **`src/ui/`** — Preact webviews, one esbuild bundle per view. `logic/` is pure and tested, `components/` renders,
  `platform/vscode.ts` is the only thing that talks to the webview host (`post()` out, `useWebviewState()` in).
- **`resources/`, `scripts/`** — the activity-bar icons, the `SSH_ASKPASS` helpers (`askpass.js`, `askpass.sh`), and
  the Connect ProxyCommand (`forward.js`).

The testability seam is extraction, not injection: to make `vscode`-coupled logic testable, move the pure or
effect-light part into a `vscode`-free module and test that. `slurmLaunch` is the pattern — it takes an injected
`RemoteRunner` and `LogSink`, mutates only the in-memory session, and leaves persistence to its caller.

## Session status model

Statuses are `not_started`, `submitting`, `queued`, `preparing`, `ready_to_connect`, `connecting`, `connected`,
`stopping`, `stopped`, `failed` (`models.ts`). The predicates that gate behaviour
live in `sessionMachine.ts` as the single source of truth shared by the provider, the poll and the webview:
`isTerminal` (stopped/failed), `isCloseable` (terminal plus `not_started`), `isStoppable`, `isRelayLive`
(`ready_to_connect`/`connecting`/`connected`). `computeStatusTransition(current, slurmStatus)` is the pure poll-loop
transition table. `trackSessions` owns poll-driven transitions; `SessionProvider` owns user-action transitions and
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
drops another window's update. A record carries its cs-plane session id, never a token. On load, `connected`,
`connecting` and 0.1.8's `unreachable` demote to `ready_to_connect`. Utilization history lives in
cs-plane, which records who launched each run, so the Stats view filters VS Code's runs from JupyterLab's.

A remote window recognises itself: `extension.ts` reads the workspace URI authority, and in an
`ssh-remote+<alias>` window it scopes the Sessions view to that one session, observe-only, and sets the
`csbridge.remote` context so the SSH Hosts and Stats views hide.

## Build pipeline

`esbuild.js` runs two esbuild contexts plus a codicon copy. The extension bundles `src/extension.ts` to
`out/extension.js` (CJS, `platform: node`, `target: node20`, `vscode` external). The webviews bundle
`src/ui/webviews/{sessions,hosts,stats,summary}.tsx` to `out/*.js` (IIFE, `platform: browser`, Preact JSX). Both
share `bundle: true`, sourcemaps off and minification on under `--production`, and the `@` → `src` alias. esbuild
never type-checks: `tsc` does, once per tsconfig, since the root config excludes `src/ui`, which has its own with
DOM libs and Preact JSX. The `.vsix` ships `out/`, `resources/`, `scripts/`, `package.json` and the root
documents; `src/`, `docs/`, `.github/` and `node_modules/` are excluded (see `.vscodeignore`).

## External dependencies

- **[linkspan](https://github.com/cyber-shuttle/linkspan)** — the agent that runs on the compute node and manages
  the SSH server and links to cs-plane or hosts the Dev Tunnel. Installed by CS Bridge to `~/.cybershuttle/bin/linkspan` on first
  launch. The linkspan version a release requires is recorded in [CHANGELOG.md](../CHANGELOG.md).
- **cs-plane** — sign-in (CILogon's device grant, relayed), session records, the link or Dev Tunnel, Connect,
  metrics and runs. See its `docs/API.md`.
- **OS-native OpenSSH** — every SSH connection is made by the system `ssh` binary. Nothing is bundled.
- **VS Code remote-SSH URI handler** — CS Bridge emits a `vscode-remote://ssh-remote+…` URI and whatever provider
  is installed (typically
  [ms-vscode-remote.remote-ssh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh))
  attaches the window. It is not declared as an `extensionDependencies` entry.
