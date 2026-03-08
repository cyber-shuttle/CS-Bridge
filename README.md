# CyberShuttle

Work on your local project in VS Code while computation runs on a remote HPC cluster or VM. CyberShuttle automatically mounts your workspace on the remote machine. No file syncing, no manual setup. Just select a target, launch a session, and your project is ready to use on the remote host.

---

## Features

### Sign In and Remote Target Setup

CyberShuttle reads your `~/.ssh/config` and shows all configured remote targets. HPC clusters, cloud VMs, or any machine with SSH access Sign in with a Microsoft account to enable secure tunneling between your machine and the remote target.

![Sign In and Remote Target Setup](docs/media/01-sign-in.gif)

### Resource Configuration

When a SLURM scheduler is detected, CyberShuttle queries available partitions, accounts, memory limits, GPUs, and walltime options so you can configure jobs from a visual form. Select how long you need the remote machine (walltime), and CyberShuttle handles the rest. For plain SSH hosts, connect directly with no extra configuration.

![Resource Configuration](docs/media/02-resource-config.gif)

### Session Launch and Connect

Launch a session with one click. Your current VS Code workspace is automatically mounted on the remote machine. No file copying, no rsync, no git push/pull needed. Click Connect to open a new VS Code window on the remote target where your local project files are ready to use. Work as you normally would, but computation runs on the remote machine.

When a session's walltime expires, you can restart it directly from the sidebar. CyberShuttle remembers your previous configuration so you can pick up right where you left off.

![Session Launch and Connect](docs/media/03-session-launch.gif)

### Remote File Browser

Browse directories on any connected remote host directly from the VS Code sidebar. When you open a folder in the remote VS Code window, you'll find your local workspace already mounted and ready. Continue your development or research exactly where you left off.

![Remote File Browser](docs/media/04-file-browser.gif)

## Getting Started

### Prerequisites

| Requirement | Details |
|---|---|
| VS Code | 1.98 or later |
| SSH Config | At least one remote host in `~/.ssh/config` |
| Microsoft Account | Free account for secure tunnel authentication |
| Remote Host | Any machine with SSH access (HPC cluster, cloud VM, etc.) |
| Internet on Remote | Required for first-time session setup |

### Quick Start

1. Click the CyberShuttle icon in the Activity Bar
2. Sign in with your Microsoft account
3. Select a remote target from the dropdown
4. Configure resources (SLURM clusters show partition, memory, GPU, and walltime options)
5. Click Launch to start your session
6. Click Connect. A new VS Code window opens on the remote machine with your local workspace mounted and ready

## Privacy and Telemetry

CyberShuttle collects anonymous usage data to improve the extension. No personal files, code, or identifying information is collected. Data is only sent with your explicit consent, which you can grant or revoke at any time in Settings > CyberShuttle > Telemetry.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and how to get involved.

## License

[Apache 2.0](LICENSE)
