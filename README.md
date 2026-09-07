# CS Bridge

[![CI](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml)
[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![Installs](https://vsmarketplacebadges.dev/downloads-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![License](https://img.shields.io/github/license/cyber-shuttle/CS-Bridge?color=blue)](LICENSE)

CS Bridge is a VS Code extension that runs your editor on the compute nodes of an HPC (high-performance computing) cluster. You pick a cluster and the resources you need; it submits the Slurm batch job, opens a Microsoft Dev Tunnel to the allocated node, and attaches a VS Code window to it.

> New to the terms? **HPC cluster** = a shared pool of compute nodes. **Slurm** = the scheduler that hands you a node. **Compute node** = where your code actually runs (versus the login node you SSH into). **Dev Tunnel** = Microsoft's encrypted relay, so no firewall changes are needed. **CyberShuttle** = the ARTISAN group's toolset for running interactive work on HPC clusters; CS Bridge is its VS Code extension, and its files live under `~/.cybershuttle/`. **[linkspan](https://github.com/cyber-shuttle/linkspan)** = the companion agent that runs inside your Slurm job on the compute node; CS Bridge installs it on the cluster for you.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/demo-overview.webp" alt="Demo" width="480">

## Status

Version 0.1.5, published on the VS Code Marketplace as `cybershuttle.csbridge`; first released 2026-05-29. Pre-1.0 — interfaces still change between releases, see [CHANGELOG.md](CHANGELOG.md).

## Requirements

VS Code 1.98 or newer, a Slurm cluster reachable from your `~/.ssh/config`, and a free Microsoft account. Building from source is covered in [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

## Features

- **Hosts from `~/.ssh/config`** — every cluster you already SSH into, listed in the SSH Hosts view, ready to launch a session on or to open a login-node terminal from. Add a new one by pasting its connection command (e.g. `ssh user@host -A`); CS Bridge parses it and writes the `Host` entry to `~/.ssh/config`.
- **Slurm without scripts** — set partition, CPUs, memory, GPUs, and walltime in a form; CS Bridge writes and submits the batch script.
- **Session memory** — start an expired job again with its previous resource selection in one click.
- **Utilization at a glance** — each finished run records CPU and memory efficiency; the Stats view keeps the history, and a per-run summary tab shows each run's detail, so you can see how well a session used its allocation.
- **No inbound ports** — a Microsoft Dev Tunnel carries the transport; the cluster opens nothing new.
- **OS-native SSH** — uses your system `ssh` binary, not a bundled SSH client.
- **A full VS Code window on the compute node** — your editor, debugger, extensions, and keybindings, running where the code runs.

## Quick Start

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge) (or search `CS Bridge` in Extensions).
2. Click the CS Bridge icon in the activity bar and sign in with a Microsoft account (used only to authenticate the Dev Tunnel).
3. Pick a host from your `~/.ssh/config`.
4. Fill the resource form: partition, CPUs, memory, GPUs, walltime.
5. Click **Start**, then **Connect** — a new VS Code window opens on the compute node.

## How It Works

CS Bridge queries the cluster's partitions, accounts and limits. You pick the configuration you need and save it as a reusable session.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/02-sessions.png" alt="Sessions sidebar" width="480">

Each session shows its live status; a running one streams its CPU, memory, and GPU use inline. Start, Stop, and Connect from there:

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/03-live-status.png" alt="Live session status" width="480">

Every run's resource use is recorded — live in the sidebar, and afterward in a per-run summary tab reporting the run's most recent resource samples and its CPU and memory efficiency. The Stats view keeps the ten most recent runs per session, so you can right-size the next one.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/04-utilization.png" alt="Past runs and their utilization" width="480">

**Start** submits a Slurm job that runs `linkspan` on the allocated compute node. **Connect** relays linkspan's SSH server to localhost over the Dev Tunnel and opens a VS Code window on it.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/05-remote-window.png" alt="VS Code running on the compute node" width="480">

Full architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Files and paths

**Local:** `~/.cybershuttle/sessions/` (one `<sessionId>.json` per session; metadata shared across VS Code windows), `~/.cybershuttle/metrics/` (per-session utilization history),
`~/.cybershuttle/ssh_config`, `~/.cybershuttle/ssh_keys/`, `~/.cybershuttle/ssh_control/` (generated SSH config, per-session keys, ControlMaster sockets).
CS Bridge prepends `Include ~/.cybershuttle/ssh_config` to your `~/.ssh/config` so OS-native `ssh` picks up the per-session aliases.
The Microsoft account token is held by VS Code's built-in authentication provider (OS keychain).

**Remote:** `~/.cybershuttle/bin/linkspan` (installed on first launch).
`~/.cybershuttle/logs/linkspan-session-<jobid>.{out,err}` (linkspan output, for troubleshooting).
To reset, remove both `~/.cybershuttle/` directories and the `Include` line in `~/.ssh/config`.

## Troubleshooting

1. **No hosts listed.** `~/.ssh/config` is empty or unreadable. Add a `Host` block with `HostName`, `User`, and `IdentityFile`, then refresh.
2. **Microsoft sign-in fails.** Your network may block `login.microsoftonline.com` or `*.devtunnels.ms`. Allowlist both. The Dev Tunnel is the only supported transport today.
3. **Job stuck in `PENDING`.** Cluster busy or request too large. Try smaller resources, or run `squeue -u $USER` on the cluster for the reason.
4. **Session fails with "Slurm is not available".** The selected host has no `sinfo` on `PATH`. CS Bridge requires Slurm for now — see the [Roadmap](#roadmap).
5. **Connect window disconnects.** A half-open relay rebuilds itself after four missed keep-alives; if that rebuild fails the session falls back to **Connect**. A login-node outage while a session is still submitting, queued or preparing shows as **Unreachable**, with **Reconnect**. Check `View > Output > CS Bridge` for the failing step.
6. **Session stuck on `Submitting…`.** Linkspan may be installing on first use. Wait, then check `~/.cybershuttle/logs/` on the remote. If it never moves, click **Stop**, then **Start**.
7. **Permission denied on the remote Linkspan binary.** Run `chmod +x ~/.cybershuttle/bin/linkspan` on the remote, then **Start**.
8. **Walltime expired mid-work.** The session shows as **Stopped**. Click **Start** to resubmit with the same partition, account, and resources, then **Connect**. Files on the shared filesystem are untouched.

## FAQ

1. **Do I install anything on the remote?** No. CS Bridge installs `linkspan` into `~/.cybershuttle/bin/` on the cluster on first launch (the remote needs outbound access to github.com).
2. **VS Code Insiders, Cursor, or other forks?** CS Bridge targets VS Code 1.98+. Forks with compatible remote-SSH support and Marketplace access usually work but aren't officially tested.
3. **Does the cluster session survive closing my laptop?** Yes. The Slurm job and your remote processes run until walltime ends. Reopen and **Connect** to reattach.
4. **Windows, macOS, Linux?** Yes on the local side, wherever VS Code and OpenSSH run. The remote needs a Unix-like environment with SSH and Slurm.

## How it relates to Remote-SSH

Microsoft's [Remote-SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) attaches a VS Code window to a static SSH host. CS Bridge handles everything *around* that — the Slurm job, the compute-node allocation, the Dev Tunnel, the per-session SSH config — then hands the final attach to whatever remote-SSH URI handler is installed, which drives your OS `ssh` binary.

Remote-SSH alone is enough when you SSH into a static dev box. CS Bridge is for when there's a scheduler between you and the compute, a login node in the way, or a firewall blocking inbound SSH.

## Roadmap

These items are planned and may change.

- [ ] **UI to report issues** — file an issue from inside the extension with a typed description and an auto-captured stack trace.
- [ ] **UI for queue visibility** — show queued jobs, queue positions, and estimated start times.
- [ ] **Opt-in anonymous usage metrics** — explicit consent flow, reporting telemetry to a central endpoint.
- [ ] **Login to non-Slurm hosts** — connect directly to lab workstations or dev VMs with no scheduler.
- [ ] **Self-hosted FRP relay** — an institution-run fast reverse proxy (FRP) as an alternative transport, for sites that disallow MS Dev Tunnels.
- [ ] **Local-workspace mounting** — expose your local files to the remote VS Code window via FUSE + sshfs.

## Citing

If CyberShuttle supports your research, please cite:

```bibtex
@software{cybershuttle,
  title  = {CyberShuttle: Remote HPC Development from VS Code},
  author = {{ARTISAN Research Group, Georgia Institute of Technology}},
  year   = {2026},
  url    = {https://github.com/cyber-shuttle/CS-Bridge}
}
```

## Privacy

CS Bridge collects no usage metrics today. Authentication runs through VS Code's built-in Microsoft authentication provider; SSH credentials and tunnel traffic stay between you, your remote host, and Microsoft Dev Tunnels. An opt-in anonymous metrics flow is on the [Roadmap](#roadmap).

## Getting help

Search the [issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues), then open an issue. The bug form asks for the `View > Output > CS Bridge` log and the remote `~/.cybershuttle/logs/` output, which is usually what settles it. What changed between releases is in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and PRs are welcome, especially from researchers running CS Bridge on real workloads. [CONTRIBUTING.md](CONTRIBUTING.md) covers dev setup and the pull-request workflow, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers how it works inside, and participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Acknowledgments

Built and maintained by the [ARTISAN research group](https://gt-artisan.github.io/) at Georgia Tech, on top of [linkspan](https://github.com/cyber-shuttle/linkspan), [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/), and OpenSSH.

## License

[Apache-2.0](LICENSE)
