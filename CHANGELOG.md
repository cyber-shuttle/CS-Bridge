# Changelog

All notable changes to the CS Bridge VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

- The managed `~/.cybershuttle/ssh_hosts` host level — SSH hosts are now read directly from `~/.ssh/config` and the read-only system config (the legacy `Include` is cleaned up automatically).

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
