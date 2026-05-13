<p align="center">
  <img src="resources/cs-logo.png" alt="CyberShuttle Logo" width="60" />
</p>

<h1 align="center">CyberShuttle</h1>

<p align="center">
  <strong>Remote HPC development from VS Code.</strong>
</p>

<p align="center">
  <img src="docs/media/demo-overview.gif" alt="CyberShuttle demo" width="700" />
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=cybershuttle.cybershuttle">VS Code Marketplace</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Work locally in VS Code while computation runs on a remote HPC cluster or VM. Select a target, configure resources, and connect — all from VS Code.

## Features

### Remote Targets from SSH Config

Reads `~/.ssh/config` and lists configured hosts — HPC clusters, cloud VMs, or any SSH-accessible machine. Sign in with a Microsoft account to enable secure tunneling.

### Resource Configuration

For SLURM hosts, query partitions, accounts, memory, GPUs, and walltime, then submit jobs from a visual form. Plain SSH hosts connect directly.

<p align="center">
  <img src="docs/media/02-resource-selection.png" alt="Resource configuration form" width="700" />
</p>

### Session Management

Launch with one click. **Connect** opens a new VS Code window attached through a secure tunnel. Switch between sessions, stop them, or restart expired ones.

<p align="center">
  <img src="docs/media/03-session-management.png" alt="Session management across multiple windows" width="700" />
</p>

## Key Concepts

| Concept | Description |
|---|---|
| **Dev Tunnel** | Microsoft Dev Tunnel between your local VS Code and the remote compute node. |
| **linkspan** | Agent on the remote host managing the VS Code Server and Dev Tunnel. |
| **Session** | A SLURM job (or direct SSH connection) running linkspan. Launch, monitor, restart, or reattach to them. |

## Installation

Search for **CyberShuttle** in VS Code Extensions (`Cmd+Shift+X`), or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=cybershuttle.cybershuttle).

Building from source? See [CONTRIBUTING.md](CONTRIBUTING.md#installation-from-source).

## Quick Start

1. Open the **CyberShuttle** extension panel and sign in
2. Select a target from your SSH config
3. Configure resources (SLURM) or connect directly (plain SSH)
4. **Launch**, then **Connect** to open a remote VS Code window

### Prerequisites

| Requirement | Details |
|---|---|
| VS Code | 1.98 or later |
| SSH Config | At least one host in `~/.ssh/config` |
| Microsoft Account | For Dev Tunnel authentication |
| Remote Host | Any machine reachable via SSH |

## Architecture

```text
Local VS Code                  Remote HPC
┌──────────────────┐           ┌──────────────────────┐
│  CyberShuttle    │── SSH ──▶ │  SLURM scheduler     │
│  extension       │           │                      │
│  panel           │           │  Compute Node:       │
│                  │           │   linkspan           │
│                  │           │   ├─ VS Code Server  │
│                  │           │   └─ Dev Tunnel ─────┼──▶ devtunnels.ms
│  Remote-SSH ◀────┼───────── tunnel ─────────────────┘
└──────────────────┘
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for source layout and development setup.

## Privacy

We collect anonymized telemetry data, with explicit consent. No files, code, or identifying information is collected. You can opt-out from **Settings > CyberShuttle > Telemetry**.

## License

[Apache 2.0](LICENSE)
