# CS Bridge (CyberShuttle VS Code extension)

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything structural; it holds the design and the
invariants. [README.md](README.md) is the user-facing description, [CONTRIBUTING.md](CONTRIBUTING.md) the
contribution and release workflow. Keep those three in step with the code as you change it, and never point a
public file at this one.

## Commands

```bash
npm install          # install dependencies first
npm run compile      # node esbuild.js — extension + 4 webview bundles into out/ (+ copy codicons)
npm run watch        # esbuild in watch mode (extension + webviews)
npm run check-types  # tsc --noEmit twice: root tsconfig (extension) + src/ui/tsconfig.json (webviews)
npm run lint         # eslint src
npm test             # node --import tsx --test  (src/modules/*.test.ts + src/ui/logic/*.test.ts)
npm run package      # vsce package -> .vsix  (vscode:prepublish = check-types + esbuild --production)
npm run dev          # install + package + install-ext into VS Code
```

`check-types`, `lint` and `test` are what CI runs; run all three before declaring a change done. Press F5 in VS
Code for an Extension Development Host.

## Unimplemented (do not document as features)

- **FRP tunnel provider** — only `devtunnel` works end to end; there is no FRP code.
- **Filesystem sync** (FUSE/mutagen/sshfs), a **plain-SSH (non-Slurm) launch** path, and any admin or telemetry
  server — no code exists. See the README roadmap.

## Gotchas

- `check-types` runs **two** tscs (root + `src/ui/tsconfig.json`); esbuild never type-checks, so a `.tsx` type
  error surfaces only there.
- The webview UI is **Preact**, not React — hooks must come from `preact/hooks`.
- The cross-window `fs.watch` + file lock in `extensionStore` is load-bearing — see
  [Persistence and cross-window state](docs/ARCHITECTURE.md#persistence-and-cross-window-state).
- The `Include ~/.cybershuttle/ssh_config` line in `~/.ssh/config` is load-bearing; removing it without removing
  CS Bridge leaves the per-session aliases dangling.
- `createSshServer` is **not** idempotent; `ensureRemoteSession` guards re-creation — see
  [Session lifecycle](docs/ARCHITECTURE.md#session-lifecycle) step 7.
- The webview `.tsx` rendering has no automated tests — only `ui/logic/*` and the `vscode`-free modules are unit-
  tested; UI changes need a manual pass in the Extension Development Host.
- Stop, never cancel, outside Slurm's own `CANCELLED`/`scancel` — see
  [Submitting a change](CONTRIBUTING.md#submitting-a-change).

## Code Discipline

Every line must earn its place. Reject scaffolding: helpers called once (inline them), abstractions with no second
caller, defensive checks for impossible states, comments that restate well-named code. Prefer first-class, declarative
code that reads without comments; reach for a comment only to capture a non-obvious *why*. Default to the smallest
correct implementation; when a diff grows, scan for lines that can merge or disappear before declaring done.
