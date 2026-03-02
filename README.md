# 🚀 CyberShuttle (CS-Bridge)

**CS-Bridge** is a Visual Studio Code extension designed for seamless integration with High-Performance Computing (HPC) environments. It enables you to launch and manage interactive HPC sessions, submit SLURM jobs to remote clusters, establish SSH tunnels via Microsoft Dev Tunnels, and connect to remote VS Code sessions — all straight from your VS Code sidebar.

## ✨ Features

- **HPC Cluster Integration**: Connect to remote HPC clusters using your existing `~/.ssh/config` setups.
- **Interactive SLURM Jobs**: Easily configure CPUs, memory, GPUs, and wall time limits from the extension UI.
- **Automated Dev Tunnels**: Automatically sets up secure connections to compute nodes using Microsoft Dev Tunnels.
- **One-Click Connect**: Opens a dedicated Remote-SSH window directly to your compute node.
- **Session Monitoring**: Enjoy real-time log streaming and continuous job monitoring via `squeue`/`sacct`.

## 📦 Installation

*CS-Bridge is currently installed directly from source.*

### Prerequisites

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) (v20+)
- [VS Code](https://code.visualstudio.com/) (v1.98+)

### Steps

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

3. The CyberShuttle icon will appear in your Activity Bar. If it doesn't, reload VS Code (`Cmd+Shift+P` → "Developer: Reload Window").

### Updating

To update to the latest version:

```sh
cd CS-Bridge
git pull
npm run dev
```

## ⚙️ Configuration

### SSH Hosts

The extension reads `~/.ssh/config` to populate the host dropdown. Ensure your HPC hosts are configured there. For example:

```ssh-config
Host delta
  ProxyCommand ssh -q exouser@149.165.171.64 nc %h %p
  HostName login.delta.ncsa.illinois.edu
  User svcscigapgwuser
  IdentityFile ~/.ssh/ext_delta
```

### `linkspan` on Remote Hosts

The `linkspan` binary is **automatically downloaded and deployed** by CS-Bridge. Before submitting a SLURM job, the extension SSHs into the remote host, detects its architecture, and downloads the latest release from [GitHub](https://github.com/cyber-shuttle/linkspan/releases) directly on the remote machine. The binary is cached at `~/.cybershuttle/bin/linkspan`.

No manual installation is required. The remote host just needs internet access to `github.com`.

### SSH ControlMaster

The extension handles SSH connection multiplexing under the hood. Control sockets are stored safely in `~/.cs-ssh/` using hashed designations to stay underneath the 104-byte macOS socket path limit. **No manual configuration is required.**

## 🏗 Architecture

```text
Local VS Code                        Remote HPC Cluster
┌─────────────────────┐              ┌──────────────────────────┐
│  CS-Bridge sidebar  │──── SSH ────▶│  SLURM (sbatch/squeue)   │
│  (webview UI)       │              │                          │
│                     │              │  Compute Node:           │
│  SSH ControlMaster  │              │  ┌──────────────────┐    │
│  (connection pool)  │              │  │  linkspan         │    │
│                     │              │  │  ├─ VS Code Server│    │
│  Persistent shells  │              │  │  └─ Dev Tunnel ───┼────┼──▶ devtunnels.ms
│  (file browser,     │              │  └──────────────────┘    │
│   job monitoring)   │              └──────────────────────────┘
└─────────────────────┘
         │
         ▼
  Remote-SSH window
  (connects via tunnel)
```

### How a Session Works

1. **Host Selection**: The user selects an SSH host and configures resources (CPUs, memory, GPU, wall time).
2. **Cluster Capabilities**: The extension queries SLURM partitions and accounts via `scripts/info.sh` over SSH.
3. **Job Submission**: Generates and submits a SLURM batch script that runs **linkspan** on the allocated compute node.
4. **Tunneling**: `linkspan` initiates a VS Code Server, sets up a Dev Tunnel, and emits the necessary connection details.
5. **Connection Loop**: The extension periodically polls `squeue`/`sacct` and tails `linkspan` logs to capture the newly formed tunnel URL and SSH port.
6. **Connect**: The user clicks **Connect**, spinning up a Remote-SSH VS Code window straight into the compute node through the active tunnel.

### Source Layout

```text
src/
├── extension.ts                 # Entry point — registers sidebar view + auth command
├── CybershuttleViewProvider.ts  # Main provider — webview UI, SSH, SLURM, tunnels (~3k lines)
├── cscommands.ts                # OAuth device flow auth against auth.cybershuttle.org
├── csstorage.ts                 # Thin wrapper around VS Code SecretStorage for tokens
└── test/
    └── extension.test.ts

scripts/
├── askpass.js    # SSH_ASKPASS helper — bridges SSH prompts to VS Code UI dialogs
└── info.sh       # Queries SLURM partitions, accounts, capabilities via sinfo/sacctmgr

resources/
└── cybershuttle.svg   # Activity bar icon
```

### External Dependencies

| Dependency | Purpose |
|---|---|
| [linkspan](https://github.com/cyber-shuttle/linkspan) | Custom agent managing the VS Code Server + Dev Tunnel on the compute node. Auto-deployed by CS-Bridge to `~/.cybershuttle/bin/linkspan`. |
| [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) | VS Code extension utilized to natively attach the remote session. |
| Microsoft Dev Tunnels | Port-forwarding service. Requires Microsoft account sign-in from the sidebar. |
| OpenSSH (`~/.ssh/config`) | System SSH properties fetched to build the host directory in the UI. |

## 🛠 Development Setup

Run and modify CS-Bridge locally:

```sh
# Ensure dependencies are installed
npm install

# Watch TypeScript files and build on change
npm run watch
```

1. **Launch Extension**: Open the `CS-Bridge` folder in VS Code and press **F5** (or *Run > Start Debugging*). This opens a new VS Code window with the extension loaded (Extension Development Host).
2. **Interact**: The CyberShuttle icon will appear in the sidebar of the new window.
3. **Reload**: Reload the Extension Development Host window (`Cmd+Shift+P` > "Developer: Reload Window") to reflect your newest code changes.

> **Note:** Development mode only loads the extension in the Extension Development Host window. If you open a new Remote-SSH window directly from there, the extension won't automatically propagate. To test in Remote-SSH windows across the board, compile and manually install the `.vsix` packaged extension natively.

### Linting

To enforce code style and catch issues:

```sh
npm run lint
```
