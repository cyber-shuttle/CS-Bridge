# Changelog

All notable changes to the CS Bridge VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.5] - 2026-08-22

Requires linkspan 0.17.0.

### Changed

- **Stopped sending and declaring fields linkspan no longer has** — `POST /vscode/sessions` no longer sends `mount_user_home`, the last remnant of the remote filesystem mounting linkspan no longer does, and a session status no longer declares `active`, `restarts` or `last_error`. Only `id`, `state` and `addr` were ever read. (#114)
- **Dropped the one-time legacy session migration** — the old `~/.cybershuttle/sessions.json` array was folded into per-id records, and the id rewrite and `cshost-<id>` workspace-authority form repaired ids written in that format. All three are one-time repairs, and the migration deleted its own input. (#114)
- **Removed surface with no caller** — `SlurmSession.jobDirectory` (written as `''`, rendered behind a guard that is never true), the `statusDescriptor` wrapper over three predicates, the `AccountInfo` wrapper over a nullable string, three re-exports that renamed store functions, and unused `Chip`/`Card` props. The logger's level enum and gate never filtered anything. (#114)

### Fixed

- **`summaryPanel` subscribed to the run watcher twice** — one subscription came in under a re-exported alias, hiding the duplicate. (#114)
- **`install-ext` pinned a stale vsix** — it installed `csbridge-0.0.2.vsix` regardless of the packaged version, and now reads the name and version from the package. (#114)

### Docs

- Corrected descriptions of mechanisms that no longer exist: nothing tails linkspan's logs to discover the API port (it is pinned at launch), `linkspanSupport` is an HTTP client rather than a YAML generator, `checkLinkspanHealth` does not exist, and sessions are per-id records rather than one array file. (#114)

## [0.1.4] - 2026-08-22

Requires linkspan 0.16.0.

### Changed

- **The compute node no longer holds a Microsoft Entra bearer** — CS Bridge creates the Dev Tunnel, registers its ports and deletes it itself, and the job receives only a token scoped to hosting that one tunnel (`--tunnel-host-token`). The batch script carries that token, so it is no longer written to disk. (#113)
- **The session SSH key pair is minted locally and stays local** — `POST /vscode/sessions` now sends only the public half, so a compromised allocation cannot hand out credentials to itself and linkspan returns nothing secret. (#113)
- **Linkspan installs follow newest-wins** — a build ahead of the published release (`X.Y.Z.<commit>`) is left alone, a release that catches up takes over, and an already-installed release is not re-fetched. A failed lookup of the latest release keeps what is installed rather than replacing a working binary. (#113)

### Fixed

- **A window reload while a session was preparing orphaned it** — only connection info carrying an `sshTunnelId` was persisted, and that is set once the remote sshd exists; a session still bringing up linkspan therefore lost the API port it was pinned to, and fell back to polling the login node forever instead of the tunnel. (#113)

## [0.1.3] - 2026-07-28

### Fixed

- **Multi-line SSH authentication prompts on Windows** — the authentication view showed only the first line of a keyboard-interactive prompt, so a CILogon device-flow login lost its sign-in link, device code and QR code and could not be completed at all. `SSH_ASKPASS` pointed at a `.cmd` wrapper, and Windows runs a `.cmd` through `cmd.exe /c`, which truncates its command line at the first newline — the prompt was discarded one process before the helper started. (#111)

### Changed

- **One askpass helper per ssh exec model** — the helper was chosen by `process.platform`, but what decides the calling convention is how ssh launches it: Windows OpenSSH builds a command line, while every `execlp`-based build — Unix and Git for Windows/MSYS2 alike — takes a single filename and runs it through its shebang. The platform check and `askpass.cmd` are gone, and Git for Windows users share the same helper as macOS. (#111)

## [0.1.2] - 2026-07-27

### Added

- **Refresh cluster details** — a refresh icon on the session form re-queries the host's partitions, accounts and limits. Previously a host was fetched once per window, so a cluster that changed kept serving stale options until a reload. (#110)
- **Terminal on an SSH host** — opens a login-node shell in the current window, riding the connection CS Bridge already holds so it costs no second 2FA prompt. (#110)

### Changed

- **One Start action** — a finished session shows **Start**, not **Restart**; every launch was already a fresh one. (#110)

### Fixed

- **Duplicate allocations in the picker** — `sacctmgr` prints one row per (account, partition) association, so an account repeated once per partition it covers. The list is deduped, and the parsing moved into a tested `parseAccounts`. (#109)
- **A partition dropped from the cluster stayed selected** — the form kept the saved partition name even when the cluster no longer offered it, and submitted it as `--partition` anyway; it now falls back to the first valid partition. (#110)

## [0.1.1] - 2026-07-18

### Fixed

- **Cross-window UI stutter when a session window opens** — the cross-window sync watcher re-read and re-parsed every session file on every record write, so opening a new remote window (or any session change) briefly hung every other open window. It now reads only the single record that changed, and coalesces the duplicate filesystem events macOS fires per write. (#107)

## [0.1.0] - 2026-07-18

### Fixed

- **linkspan socket permission clash on shared compute nodes** — the in-allocation control socket now binds at `/tmp/csbridge-<id>.sock` directly in the sticky, world-writable `/tmp`, instead of a shared `/tmp/csbridge/` directory that the first user to launch on a node would own (mode 0755) and lock every other user out of, failing with `bind: permission denied`. (#105)

## [0.0.5] - 2026-07-16

### Added

- **Utilization metrics + Stats view** — each finished run records CPU/memory efficiency from `sacct`; a summary tab and the new Stats view keep the history. (#82, #83, #84)
- **Wall-time session summary** — a status bar tracks elapsed time; a summary tab opens when a session ends. (#76)
- **Submit-filter validation** — Add/Save preflights the script via `sbatch --test-only` and saves only on pass, showing the site's own rejection. (#72)
- **Live resource metrics on the session card** — each running session shows live CPU/memory samples pulled from linkspan. (#87)
- **`(No Allocation)` allocation option** — pick it to omit `--account` on clusters that don't require an allocation. (#89)
- **Clear a session's run history** from its card. (#92)

### Changed

- **Graceful Stop from the remote window** — Stop reloads the window to local and finishes the cancel + summary there; the session holds `stopping` until `sacct` confirms. (#85)
- **Connect spinner; Switch focuses** — Connect stays disabled until the window registers (no duplicate windows); Switch focuses the live window. (#73)
- **Monitoring rewrite** — one lock-free poll loop per session; relay-live sessions ping the tunnel and skip `sacct`; connect tolerates an already-forwarded tunnel. (#77)
- **Per-cluster window names** — `<cluster>-<session>` instead of `cshost-<uuid>`. (#77)
- **`PENDING` shown as `QUEUED`**. (#75)
- **linkspan port pinned at launch** — tunnel URL derived without scraping logs. (#75)
- **Atomic `sessions.json` writes** — temp-file + rename, no truncation on crash. (#81)
- **Per-session storage** — `sessions.json` and the run store split into per-session files (`sessions/{id}.json`, `metrics/{id}.json`), cutting cross-window write contention. (#91, #92)
- **SSH auth prompts rendered verbatim** in a monospace webview, so password/Duo challenges stay readable. (#88)
- **New extension logo** — refreshed the CS Bridge activity-bar and command icons (`csbridge.svg`/`csbridge.png`).

### Fixed

- **Dead node behind the Dev Tunnels edge** — require linkspan's `{"status":"ok"}` body so wall-time `TIMEOUT` is detected instead of staying green. (#70)
- **Missing node count** — always emit `#SBATCH --nodes=1`. (#69)
- **New sessions sorting to the bottom** — reissue legacy `session-<ts>` ids as UUIDv7 on load. (#71)
- **`(No Allocation)` leaking as a bogus `--account`** — its label no longer reaches `sbatch`, which had failed session create with "Invalid account or account/partition combination". (#97)
- **Half-open Dev Tunnel relay** — a relay that goes half-open (keep-alive failing while the SDK still reports Connected) now rebuilds itself, so the SSH forward self-heals instead of hanging until a manual reconnect. (#98)
- **`sacct` efficiency accounting** — utilization is read from the `.batch` step only, fixing incorrect CPU/memory efficiency numbers. (#93)
- **Atomic, locked `~/.ssh/config` edits** — host-config writes are file-locked and atomic, avoiding corruption when multiple windows edit hosts. (#94)
- **Remote VS Code server OOM on Delta** — the server now installs to node-local disk (`/tmp`) instead of `$HOME`, and the job memory floor is raised to 4 GB, fixing 2 GB job-cgroup OOM crashes. (#99)

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
