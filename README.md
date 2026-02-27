# CyberShuttle (CS-Bridge)

VS Code extension for launching and managing interactive HPC sessions. Submit SLURM jobs to remote clusters, set up SSH tunnels via Microsoft Dev Tunnels, and connect to remote VS Code sessions — all from the sidebar.

## Architecture

```
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

### Source Layout

```
src/
├── extension.ts                 # Entry point — registers sidebar view + auth command
├── CybershuttleViewProvider.ts  # Main provider — webview UI, SSH, SLURM, tunnels (~3k lines)
├── cscommands.ts                # OAuth device flow auth against auth.cybershuttle.org
├── csstorage.ts                 # Thin wrapper around VS Code SecretStorage for tokens
└── test/
    └── extension.test.ts

scripts/
├── askpass.js    # SSH_ASKPASS helper — bridges SSH password prompts to VS Code input dialogs
└── info.sh       # Queries SLURM partitions, accounts, GPU/CPU capabilities via sinfo/sacctmgr

resources/
└── cybershuttle.svg   # Activity bar icon
```

### Key Components

| Class | Responsibility |
|---|---|
| `CybershuttleViewProvider` | Webview sidebar, SSH host management, SLURM job submission/monitoring, Dev Tunnel integration, file browser, log streaming |
| `CsCommands` | OAuth 2.0 device authorization flow (Keycloak) |
| `CsStorage` | Persists access/refresh tokens in OS keychain via `vscode.SecretStorage` |

### How a Session Works

1. User selects an SSH host and configures resources (CPUs, memory, GPU, wall time)
2. Extension queries SLURM partitions/accounts via `scripts/info.sh` over SSH
3. Extension generates a SLURM batch script that runs **linkspan** on the compute node
4. linkspan starts a VS Code Server, creates a Dev Tunnel, and emits connection details
5. Extension polls `squeue`/`sacct` + tails linkspan logs to capture tunnel URL and SSH port
6. User clicks **Connect** — opens a Remote-SSH window through the tunnel

### External Dependencies

| Dependency | Purpose |
|---|---|
| [linkspan](../linkspan) | Runs on the compute node — starts VS Code Server + Dev Tunnel. Must be in `$PATH` on the remote host. |
| [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) | VS Code extension used to open the remote session |
| Microsoft Dev Tunnels | Port forwarding service — requires Microsoft account sign-in from the sidebar |
| SSH config (`~/.ssh/config`) | Extension reads this to populate the host dropdown |

## Development Setup

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code 1.98+

### Install and Build

```sh
cd CS-Bridge
npm install
npm run compile
```

### Run in Development Mode

1. Open the `CS-Bridge` folder in VS Code
2. Press **F5** (or Run > Start Debugging)
3. A new VS Code window opens with the extension loaded (Extension Development Host)
4. The CyberShuttle icon appears in the activity bar sidebar

Changes to TypeScript files require recompilation. Use watch mode for convenience:

```sh
npm run watch
```

Then reload the Extension Development Host window (`Cmd+Shift+P` > "Developer: Reload Window").

> **Note:** Development mode only loads the extension in the Extension Development Host window. If you open a new Remote-SSH window from there, the extension won't appear. To test in Remote-SSH windows, install the packaged extension (see below).

### Lint

```sh
npm run lint
```

## Packaging and Installing

Package the extension as a `.vsix` file and install it into VS Code:

```sh
npx @vscode/vsce package
code --install-extension cybershuttle-0.0.1.vsix --force
```

This installs the extension globally so it appears in all VS Code windows, including Remote-SSH sessions.

After making code changes, re-run both commands to update the installed version.

## Configuration

### SSH Hosts

The extension reads `~/.ssh/config` to populate the host dropdown. Ensure your HPC hosts are configured there:

```
Host delta
  ProxyCommand ssh -q exouser@149.165.171.64 nc %h %p
  HostName login.delta.ncsa.illinois.edu
  User svcscigapgwuser
  IdentityFile ~/.ssh/ext_delta
```

### linkspan on Remote Hosts

The `linkspan` binary (Linux AMD64) must be installed in `$PATH` on each remote host:

```sh
scp linkspan/bin/linkspan-linux-amd64 <host>:~/bin/linkspan
ssh <host> 'chmod +x ~/bin/linkspan'
```

Ensure `~/bin` is in `$PATH` (add `export PATH=$HOME/bin:$PATH` to `~/.bashrc` if needed).

### SSH ControlMaster

The extension uses SSH ControlMaster for connection multiplexing. Control sockets are stored in `~/.cs-ssh/` with hashed names to stay under the 104-byte macOS socket path limit. No manual configuration is needed.
