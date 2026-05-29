# Changelog

All notable changes to the CS Bridge VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
