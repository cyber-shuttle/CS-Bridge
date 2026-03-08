# Changelog

All notable changes to the CyberShuttle VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.1] - 2026-03-08

### Added

- Interactive session management for any SSH-accessible host, with support for multiple remote hosts
- SLURM job submission with configurable partition, memory, GPU, and wall time options
- Dynamic per-partition memory picker that queries available resources
- Microsoft Dev Tunnel integration for secure tunneling from compute nodes back to the user
- Remote file browser in the sidebar for navigating HPC filesystems
- Session metrics dashboard with local storage instrumentation
- Automatic telemetry sync with opt-in consent and export to a central server
- SSH ControlMaster connection pooling for efficient multiplexed connections
- Automatic linkspan binary deployment to remote hosts, with cancellation support
- Session persistence via file-based storage, with reload resilience across VS Code windows
- SLURM session auto-polling to track job state transitions
- SSH password prompt handling for hosts without key-based auth
- FUSE mount integration for mounting Mac work directories to HPC via Dev Tunnel
- Status bar countdown and progress toasts for active sessions
- Developer setup script and auto-deploy documentation

### Changed

- Extracted webview CSS and JS to external files, removing inline code
- Refactored CybershuttleViewProvider into modular managers (SshManager, DevTunnelManager, FileBrowserManager)
- Simplified Dev Tunnel authentication by removing manual token expiration checks
- Redesigned session cards with multi-remote host support
- Consolidated view identifiers to match sidebar UI labels

### Fixed

- Dev Tunnel connectivity reliability
- Session switching between different remote hosts
- SSH password prompt handling on initial connection
- Resource leaks in local FUSE server cleanup on session removal and extension disposal
- Session persistence and reload resilience after VS Code restarts
- Workspace switching to always use the correct FUSE-mounted directory
