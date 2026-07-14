# Changelog

All notable changes to the CS Bridge VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.5] - 2026-07-14

### Added

- **Utilization metrics + Stats view** — each finished run records CPU/memory efficiency from `sacct`; a summary tab and the new Stats view keep the history. (#82, #83, #84)
- **Wall-time session summary** — a status bar tracks elapsed time; a summary tab opens when a session ends. (#76)
- **Submit-filter validation** — Add/Save preflights the script via `sbatch --test-only` and saves only on pass, showing the site's own rejection. (#72)

### Changed

- **Graceful Stop from the remote window** — Stop reloads the window to local and finishes the cancel + summary there; the session holds `stopping` until `sacct` confirms. (#85)
- **Connect spinner; Switch focuses** — Connect stays disabled until the window registers (no duplicate windows); Switch focuses the live window. (#73)
- **Monitoring rewrite** — one lock-free poll loop per session; relay-live sessions ping the tunnel and skip `sacct`; connect tolerates an already-forwarded tunnel. (#77)
- **Per-cluster window names** — `<cluster>-<session>` instead of `cshost-<uuid>`. (#77)
- **`PENDING` shown as `QUEUED`**. (#75)
- **linkspan port pinned at launch** — tunnel URL derived without scraping logs. (#75)
- **Atomic `sessions.json` writes** — temp-file + rename, no truncation on crash. (#81)

### Fixed

- **Dead node behind the Dev Tunnels edge** — require linkspan's `{"status":"ok"}` body so wall-time `TIMEOUT` is detected instead of staying green. (#70)
- **Missing node count** — always emit `#SBATCH --nodes=1`. (#69)
- **New sessions sorting to the bottom** — reissue legacy `session-<ts>` ids as UUIDv7 on load. (#71)

## [0.0.4] - 2026-06-30

### Changed

- **One persistent SSH connection per host** — every remote command (SLURM queries, linkspan install, `sbatch`) now rides a single SSH connection established on first use and reused until it drops, then lazily re-established. On Windows (no `ControlMaster`) this is what makes connection reuse work at all; on macOS/Linux a `ControlMaster` socket is still layered in so multiple windows share one authentication. (#66)
- **Session statuses consolidated and reordered** — hitting the wall-time limit is now a restartable **`stopped`** (was `failed`), and a dropped link is a self-recovering **`unreachable`** state (replacing `disconnected`). The status set is ordered by lifecycle and the session-card icons/labels were refreshed. (#62)
- **Time-ordered session ids** — session ids are now UUIDv7, so the sidebar keeps a stable order across relaunches and a restarted session no longer jumps to the top. (#65)
- **Higher resource floors** — the minimum session memory is now **2 GB** (1 GB could OOM-kill the VS Code remote server) and the minimum CPU count is now **2**. (#57, #59)

### Fixed

- **Windows: a fresh auth prompt on every SSH operation against 2FA hosts** — Windows OpenSSH has no `ControlMaster`, so each operation re-authenticated and raised a new Duo prompt. The persistent connection now authenticates **once** at connect and is reused until it actually drops. (#66)
- **Remote sessions stalling under heavy I/O** — opening a large file (or other bursts) no longer stalls or drops the Remote-SSH connection; the Dev Tunnel relay now uses keepalives and the SSH connection has tuned resilience options. (#56)
- **Repeated launches failing with tunnel port exhaustion** — each launch now uses a fresh Dev Tunnel, avoiding the `PortsPerTunnel` (HTTP 429) buildup that made successive launches on a cluster fail. (#58)
- **Wall-time-expired sessions handled reliably** — a session that reaches its SLURM `--time` limit is now ended even when the login node is briefly unreachable for `sacct`, no longer offers a doomed Connect/Stop, and the queued-time counter no longer flashes `-1`. (#63)
- **Cross-window connect race** — connecting two sessions at once no longer reverts both to "Connect"; session state now merges reliably across windows. (#64)

### Removed

- Legacy migration shims — the old `cancelled`/`cancelling` status migration, the legacy `~/.cybershuttle/ssh_hosts` Include cleanup, and the unused `frp` tunnel-provider vestige. (#61)

## [0.0.3] - 2026-06-25

### Added

- **Edit a session's parameters from its card** — change partition, CPU, memory, GPU, allocation, and wall time without recreating the session.
- **Account switcher** in the Sessions title bar, plus automatic reuse of a signed-in Microsoft account when creating a session.
- **SSH Hosts view** improvements — expandable host rows and a refresh action.
- **SSH auth prompts surface in the Sessions view** — password/Duo prompts raised during launch are reflected on the session card.

### Changed

- **Session resilience** — only an authoritative SLURM terminal state (`COMPLETED`/`FAILED`/`TIMEOUT`/`OUT_OF_MEMORY`/`CANCELLED`) now ends a session. A transient login-node or tunnel failure becomes a recoverable **`unreachable`** state instead of `failed`, and the in-process relay is rebuilt automatically on extension restart from the persisted reattach refs, so a live session reconnects without a manual Connect.
- Background SLURM polling now runs non-interactively (`BatchMode`), so a dead `ControlMaster` fails fast instead of raising an unanswerable auth prompt and exhausting local ports.
- **Tunnel reliability** — a single client-owned Dev Tunnel per session with a clearer connect/reattach lifecycle.
- Session-card metadata redesigned as compact chips.
- Internal refactor — one provider per sidebar view over a shared base, with vscode-free, unit-tested capability modules and lint/type tooling.

### Fixed

- **Remote server death on compute nodes without systemd-logind** — the server inherited a stale `XDG_RUNTIME_DIR=/run/user/<uid>` that does not exist on the compute node; the SLURM script now unsets `XDG_RUNTIME_DIR`/`TMPDIR` so the server falls back to node-local `/tmp`.
- A transient tunnel `/health` blip no longer tears down a working relay (it self-heals), and a brief login-node outage no longer sticks a session at `failed`.
- **GPU type and count now pre-populate** when editing a GPU session (the gres name's own colon was being mis-split).
- Corrected the SLURM `--gres` resource specification format.

### Removed

- The managed `~/.cybershuttle/ssh_hosts` host level — SSH hosts are now read directly from `~/.ssh/config` and the read-only system config.

## [0.0.2] - 2026-06-12

### Added

- **SSH Hosts view** — add, list, and delete SSH login hosts from the sidebar, mirroring Remote-SSH's "Add New SSH Host" (verbatim `ssh` command parsing and host validation). Hosts merge from a managed `~/.cybershuttle/ssh_hosts` file (Include'd atop `~/.ssh/config`), your `~/.ssh/config`, and the read-only system `/etc/ssh/ssh_config`.
- **Stats view** — a dedicated sidebar view for session statistics (local-only for now).
- **New Session** and **Add SSH Host** toolbar actions on the sidebar views.
- **Per-session SSH connection resilience** — `cshost-*` blocks now set `ServerAliveInterval`/`ServerAliveCountMax`, `TCPKeepAlive`, `ConnectTimeout`, and `IPQoS cs0`, and disable compression, so sessions ride out transient network stalls instead of dropping.

### Changed

- Webview UI rewritten on **Preact + `@vscode-elements/elements`**, split into independent per-view esbuild roots (Sessions, SSH Hosts, Stats), with each view rendered from a single pushed state slice.
- Session-card action buttons (Restart / Start / Cancel / Connect / Switch / Current) made more compact.
- README demo images now load from the GitHub repository at `HEAD` instead of relative paths.

### Removed

- `docs/media/` demo assets are no longer bundled in the published `.vsix` — the packaged extension drops from ~5.25 MB to ~0.31 MB.

## [0.0.1] - 2026-05-29

Initial release of **CS Bridge** — remote HPC development from VS Code. Published as `cybershuttle.csbridge`.

### Added

- Interactive session management for any SSH-accessible host, with support for multiple remote hosts
- SLURM job submission with configurable partition, CPU, memory, GPU, and wall-time options
- Dynamic resource picker that queries available partitions, accounts, and limits per host
- Microsoft Dev Tunnel integration (in-process) for secure tunneling from compute nodes back to the user
- OS-native SSH with a CyberShuttle-managed ControlMaster pool for efficient multiplexed connections
- Per-session SSH config generation (`~/.cybershuttle/ssh_config`), consumed by the system `ssh` via an `Include` in `~/.ssh/config`
- Automatic linkspan binary deployment to remote hosts, with cancellation support
- SLURM session auto-polling (`sacct`) to track job state transitions
- SSH password/passphrase prompt handling via an SSH_ASKPASS bridge
- Session persistence via file-based storage, with cross-window reload resilience
- Status bar countdown and progress toasts for active sessions
- esbuild-based build producing a single bundled, minified `out/extension.js` (`tsc` used for type-checking only)
