# CS Bridge

[![CI](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml)
[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![Installs](https://vsmarketplacebadges.dev/downloads-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![License](https://img.shields.io/github/license/cyber-shuttle/CS-Bridge?color=blue)](LICENSE)

CS Bridge is a VS Code extension for working on high-performance computing (HPC) clusters. It requests a compute node through Slurm, reaches it through cs-plane, CyberShuttle's control plane, and opens a VS Code window on it, so the editor, terminal and debugger run where the code runs.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/demo-overview.webp" alt="Demo" width="480">

## Features

- **Cluster hosts** — hosts come from `~/.ssh/config`; a new one is added by pasting its `ssh` command.
- **Job form** — partition, allocation, CPUs, memory, GPUs and walltime are chosen once; CS Bridge writes and submits the batch script over your own `ssh`.
- **Transport** — the `csbridge.transport` setting picks `cybershuttle` (default), where the job links out to cs-plane, or `devtunnel`, a Dev Tunnel made with the Dev Tunnels account linked to CyberShuttle.
- **Live metrics** — the session card shows the job state and its current CPU, memory and GPU use.
- **Persistent sessions** — a job outlives its VS Code window; **Connect** opens a new window on the same job.
- **Session reuse** — a finished session can be started again.
- **Utilization history** — the Stats view lists the CPU and memory efficiency of every run from VS Code and JupyterLab, filterable by platform.
- **No inbound ports** — the job's linkspan dials out to cs-plane, which relays connections, so the cluster opens no port.

## Supported Clusters

CS Bridge is tested on the following ACCESS clusters (🟢 supported, 🟡 partially tested, 🔴 unsupported). Any Slurm cluster whose compute nodes have outbound internet access should work. Results from other clusters are welcome in the [issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues).

| Name | Hostname | Slurm | Architecture | Compatibility |
|---|---|---|---|---|
| Anvil | `anvil.rcac.purdue.edu` | 25.11 | x86_64 | 🟢 |
| Bridges-2 | `bridges2.psc.edu` | 22.05 | x86_64 | 🟢 |
| Delta | `login.delta.ncsa.illinois.edu` | 25.11 | x86_64 | 🟢 |
| DeltaAI | `dtai-login.delta.ncsa.illinois.edu` | 25.11 | aarch64 | 🟢 |
| Expanse | `login.expanse.sdsc.edu` | 23.02 | x86_64 | 🟢 |
| Stampede3 | `stampede3.tacc.utexas.edu` | 23.11 | x86_64 | 🟢 |

## Quick Start

CS Bridge requires VS Code 1.101 or newer, a Slurm cluster reachable from `~/.ssh/config`, and a CyberShuttle account. Building from source is covered in [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge), or search for `CS Bridge` in the Extensions view.
2. Open CS Bridge from the activity bar, log in to CyberShuttle and approve the code in the browser.
3. Select a host.
4. Fill in the resource form.
5. Click **Start**, then **Connect**. A new VS Code window opens on the compute node.

## How It Works

A cluster is entered through a login node, but work runs on compute nodes that Slurm allocates. CS Bridge installs [linkspan](https://github.com/cyber-shuttle/linkspan), a small agent, on the cluster and runs it inside each job; linkspan dials out from the compute node to cs-plane, which relays VS Code's connection over that link without any inbound port.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/02-sessions.png" alt="Sessions sidebar" width="480">

**Start** submits the job. The session card shows its state and, once running, its CPU, memory and GPU use.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/03-live-status.png" alt="Live session status" width="480">

**Connect** opens a VS Code window on the compute node.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/05-remote-window.png" alt="VS Code running on the compute node" width="480">

After a run ends, the Stats view records its CPU and memory efficiency.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/04-utilization.png" alt="Past runs and their utilization" width="480">

The full design is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Files and Paths

**Local**

- `~/.cybershuttle/sessions/` holds one `<sessionId>.json` per session.
- `~/.cybershuttle/ssh_config` defines the per-session SSH aliases and is included from `~/.ssh/config`.
- `~/.cybershuttle/ssh_keys/` holds the per-session SSH keys.
- `~/.cybershuttle/ssh_control/` holds the ControlMaster sockets.
- VS Code keeps the CyberShuttle credential in the operating system keychain.

**Remote**

- `~/.cybershuttle/bin/linkspan` is installed on first launch.
- `~/.cybershuttle/logs/` holds the linkspan output of each session.

To reset, remove `~/.cybershuttle/` on both machines and the `Include` line in `~/.ssh/config`.

## Privacy

cs-plane records each session's resources, run state and utilization under your CyberShuttle account, which is what the Stats view shows. SSH credentials never leave your machine; session traffic passes only between the user, the remote host and cs-plane.

## FAQ

1. **How does CS Bridge differ from Remote-SSH?**

   Microsoft's [Remote-SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) attaches a VS Code window to a host that is already reachable over SSH. CS Bridge adds the steps a cluster needs first: the Slurm job, the compute-node allocation and the tunnel past the login node and firewall. It then hands the final attach to Remote-SSH.

2. **Which operating systems are supported?**

   Windows, macOS and Linux locally, wherever VS Code and OpenSSH run; **Connect** needs macOS or Linux. The remote needs a Unix-like environment with SSH and Slurm.

3. **Do VS Code forks work?**

   VS Code Insiders, Cursor and other forks with Remote-SSH support and Marketplace access usually work but are not tested.

4. **Why is MFA requested again?**

   One authenticated SSH connection is reused for ten minutes of inactivity. After that, the cluster prompts again.

5. **Why do remote extensions reinstall every session?**

   The VS Code server runs from node-local `/tmp`, which is not shared across jobs. Extensions listed in Remote-SSH's `remote.SSH.defaultExtensions` setting are installed automatically.

6. **Why is the form's minimum 2 CPUs and 4 GB?**

   Anything less starves the VS Code server, and a 2 GB job is killed for exceeding its memory.

7. **Why is file transfer slower than plain SSH?**

   The connection is relayed through cs-plane. Move large data through the login node with `scp` or `rsync`.

## Troubleshooting

1. **CyberShuttle sign-in fails.**

   The network must allow `jupyterapi.cybershuttle.org`.

2. **Session stays on `Submitting…`.**

   The first launch installs linkspan, which needs outbound access to github.com from the cluster. Check `~/.cybershuttle/logs/` on the remote.

3. **The remote window disconnects.**

   Remote-SSH reconnects while the session runs. Otherwise click **Connect** again, and check `View > Output > CS Bridge` for the failing step.

4. **The remote window crashes or reports `No ptyHost heartbeat`.**

   The job's memory limit is killing the VS Code server. Start the session again with more memory.

5. **The Dev Containers extension errors in the remote window.**

   It needs a container runtime that the cluster does not provide. Disable it for the remote window.

## Getting Help

Search the [issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues) before opening an issue. The bug form asks for the `View > Output > CS Bridge` log and the remote `~/.cybershuttle/logs/` output. Changes between releases are listed in [CHANGELOG.md](CHANGELOG.md).

## Roadmap

CS Bridge is pre-1.0, and interfaces may change between releases. The following work is planned, in no particular order.

- [ ] **Issue reporting from the extension** — file an issue with a typed description and an automatically captured stack trace.
- [ ] **Queue visibility** — queued jobs, queue positions and estimated start times shown in the Sessions view.
- [ ] **Cloud VM support** — provision a cloud VM and run a session on it, for work that needs no cluster.
- [ ] **File mounts** — mount local files and external datasets into the remote session.
- [ ] **Checkpoint and restore** — snapshot a session and resume it in another job with its running processes intact.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers development setup and the pull-request workflow, and participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Citing

CS Bridge is part of CyberShuttle, the ARTISAN group's toolset for interactive HPC work. If it supports your research, please cite:

```bibtex
@software{cybershuttle,
  title  = {CyberShuttle: Remote HPC Development from VS Code},
  author = {{ARTISAN Research Group, Georgia Institute of Technology}},
  year   = {2026},
  url    = {https://github.com/cyber-shuttle/CS-Bridge}
}
```

## Acknowledgments

Developed by the [ARTISAN research group](https://gt-artisan.github.io/) at Georgia Tech. Built on [linkspan](https://github.com/cyber-shuttle/linkspan), cs-plane and [OpenSSH](https://www.openssh.com/).

## License

[Apache-2.0](LICENSE)
