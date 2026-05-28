# Changelog

All notable changes to the Cybershuttle VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.3] - 2026-05-28

### Changed

- Updated the demo-overview video in the README
- Replaced retired shields.io Marketplace badges (version and installs) with `vsmarketplacebadges.dev` equivalents
- Pointed the README header logo at `resources/cybershuttle.png`

## [0.0.2] - 2026-05-28

### Changed

- Migrated the build to esbuild — ships a single bundled, minified `out/extension.js`; `tsc` is now used for type-checking only
- Renamed the extension to "Cybershuttle" (display name and sidebar title)
- Refreshed the extension logo

### Removed

- Forward-declared, unimplemented settings from the manifest (admin server URL, tunnel provider, FRP relay address/API key, filesystem sync)
- Unused dependencies (`sql.js`, `@types/websocket`) and the unused test harness (`@vscode/test-*`, mocha)

## [0.0.1] - 2026-05-27

### Added

- Interactive session management for any SSH-accessible host, with support for multiple remote hosts
- SLURM job submission with configurable partition, memory, GPU, and wall time options
- Dynamic per-partition memory picker that queries available resources
- Microsoft Dev Tunnel integration for secure tunneling from compute nodes back to the user
- SSH ControlMaster connection pooling for efficient multiplexed connections
- Automatic linkspan binary deployment to remote hosts, with cancellation support
- Session persistence via file-based storage, with reload resilience across VS Code windows
- SLURM session auto-polling to track job state transitions
- SSH password prompt handling for hosts without key-based auth
- Status bar countdown and progress toasts for active sessions

### Changed

- Extracted webview CSS and JS to external files, removing inline code
- Simplified Dev Tunnel authentication by removing manual token expiration checks
- Redesigned session cards with multi-remote host support
- Consolidated view identifiers to match sidebar UI labels

### Fixed

- Dev Tunnel connectivity reliability
- Session switching between different remote hosts
- SSH password prompt handling on initial connection
- Session persistence and reload resilience after VS Code restarts
