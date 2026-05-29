# Contributing to CS-Bridge

Thank you for your interest in contributing to CS-Bridge. This document covers the project architecture, source layout, and everything you need to get a local development environment running. Whether you are fixing a bug, adding a feature, or improving documentation, we appreciate your help.

## Architecture

```text
Local VS Code                              Remote HPC Cluster
┌──────────────────────────┐               ┌──────────────────────────┐
│  CS-Bridge sidebar       │── OS ssh ────▶│  SLURM login node        │
│  (webview UI)            │               │  (sbatch, sacct, sinfo)  │
│                          │               │                          │
│  SSH ControlMaster pool  │               │  Compute Node:           │
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
  vscode-remote://ssh-remote+cshost-<sessionId>/…
  (OS ssh dials 127.0.0.1:N using the per-session
   alias in ~/.cybershuttle/ssh_config)
```

## How a Session Works

1. **Host Selection**: The user selects an SSH host from `~/.ssh/config` and configures resources (CPUs, memory, GPU, wall time).
2. **Cluster Capabilities**: The extension queries SLURM partitions, accounts, and limits via `scripts/info.sh` over SSH (which calls `sinfo` and `sacctmgr`).
3. **SLURM Required**: `checkSlurmAvailability` runs `sinfo` on the host; if it fails, the launch is aborted. Plain-SSH support is on the roadmap.
4. **Job Submission**: Generates and submits a SLURM batch script that runs **linkspan** on the allocated compute node (`modules/sessionSupport.ts`, `modules/sshSupport.ts`).
5. **Tunneling**: `linkspan` starts an SSH server on the compute node and opens a Microsoft Dev Tunnel.
6. **Connection Loop**: The extension polls job status via `sacct` and tails `linkspan`'s logs from `~/.cybershuttle/logs/` on the remote to discover the tunnel ID and SSH port (`modules/slurmSupport.ts`, `modules/sessionSupport.ts`).
7. **Tunnel Forwarding**: The Microsoft Dev Tunnels SDK (`@microsoft/dev-tunnels-management`) forwards the remote SSH port to a local port (`127.0.0.1:N`) inside the extension process.
8. **SSH Config Plumbing**: An entry for `cshost-<sessionId>` is appended to `~/.cybershuttle/ssh_config` pointing at `127.0.0.1:N` with the per-session key. CS-Bridge ensures `Include ~/.cybershuttle/ssh_config` is at the top of `~/.ssh/config` so the system SSH client picks the alias up.
9. **Connect**: The user clicks **Connect**; the extension issues `vscode.openFolder(vscode-remote://ssh-remote+cshost-<sessionId>/…)`. VS Code's remote-SSH URI handler invokes the OS `ssh` binary against the alias and attaches a new window to the compute node.

## Source Layout

```text
src/
├── extension.ts                       # Entry point — registers the sidebar webview provider
├── sessionProvider.ts                 # Main webview provider (~450 lines): all user actions
├── extensionStore.ts                  # Sessions persistence + cross-window file watcher
├── models.ts                          # SlurmSession + session status types
├── logger.ts                          # Output-channel logger
├── webviews/
│   └── sessionWebview.ts              # Webview HTML/CSP generation
└── modules/
    ├── sshSupport.ts                  # SSH ControlMaster pool, askpass IPC, SLURM script construction
    ├── sessionSupport.ts              # Launch flow, linkspan deployment, status monitor
    ├── slurmSupport.ts                # sacct job-status polling
    ├── tunnelSupport.ts               # Microsoft Dev Tunnels integration
    ├── linkspanSupport.ts             # linkspan YAML config generation
    └── fsSupport.ts                   # Filesystem helpers (sessions file lock)

resources/
├── webviews/
│   ├── js/sessions.js                 # Plain JS sidebar UI (~31KB; not compiled)
│   └── css/{common,info,sessions}.css # Webview styling
├── codicons/                          # Bundled VS Code codicons
├── csbridge.svg                       # Activity bar icon
└── csbridge.png                       # Marketplace icon

scripts/
├── askpass.{js,sh,cmd}                # SSH_ASKPASS helpers (cross-platform)
└── info.sh                            # SLURM capabilities probe (sinfo / sacctmgr)
```

Authentication uses `vscode.authentication.getSession('microsoft', ...)` — there is no custom OAuth server.

## External Dependencies

- **[linkspan](https://github.com/cyber-shuttle/linkspan)** — agent that runs on the compute node and manages an SSH server + Dev Tunnel. Auto-deployed by CS-Bridge to `~/.cybershuttle/bin/linkspan` on first launch (downloaded from the latest GitHub release via `curl | tar -xz`).
- **Microsoft Dev Tunnels SDK** — npm packages `@microsoft/dev-tunnels-{management,connections,contracts}`. Used in-process to create and forward tunnels. Authentication via VS Code's built-in `microsoft` authentication provider (no custom OAuth server).
- **OS-native OpenSSH** — every SSH connection (host info probes, ControlMaster pool, and the final tunnelled session) is made by the system `ssh` binary. CS-Bridge writes its per-session config to `~/.cybershuttle/ssh_config` and ensures `~/.ssh/config` `Include`s it.
- **VS Code remote-SSH URI handler** — at the end of the connect flow CS-Bridge opens a `vscode-remote://ssh-remote+cshost-<sessionId>/…` URI; the user's installed remote-SSH provider (typically [ms-vscode-remote.remote-ssh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)) handles this URI by invoking the OS `ssh` binary against the alias. It is not a hard `extensionDependencies` declaration.

## Development Setup

### Prerequisites

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) v20+
- [VS Code](https://code.visualstudio.com/) v1.98+

### Getting Started

```sh
# Clone the repository
git clone https://github.com/cyber-shuttle/CS-Bridge.git
cd CS-Bridge

# Install dependencies
npm install

# Watch TypeScript files and build on change
npm run watch
```

1. **Launch the Extension**: Open the `CS-Bridge` folder in VS Code and press **F5** (or *Run > Start Debugging*). This opens a new VS Code window with the extension loaded (Extension Development Host).
2. **Interact**: The CyberShuttle icon will appear in the sidebar of the new window.
3. **Reload**: Reload the Extension Development Host window (`Cmd+Shift+P` > "Developer: Reload Window") to reflect your newest code changes.

> **Note:** Development mode only loads the extension in the Extension Development Host window. If you open a new remote window directly from there, the extension won't automatically propagate. To test across all windows, compile and manually install the `.vsix` packaged extension natively.

### Linting

To enforce code style and catch issues:

```sh
npm run lint
```

## Installation from Source

If you want to install the extension directly into VS Code rather than running it through the Extension Development Host:

1. Clone the repository:

   ```sh
   git clone https://github.com/cyber-shuttle/CS-Bridge.git
   cd CS-Bridge
   ```

2. Build and install in one step:

   ```sh
   npm run dev
   ```

   This installs dependencies, compiles TypeScript, packages the `.vsix`, and installs it into VS Code.

3. The CyberShuttle icon will appear in your Activity Bar. If it doesn't, reload VS Code (`Cmd+Shift+P` > "Developer: Reload Window").

### Updating

To update to the latest version:

```sh
cd CS-Bridge
git pull
npm run dev
```
