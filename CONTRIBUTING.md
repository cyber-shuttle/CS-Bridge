# Contributing to CS Bridge

Issues and pull requests are welcome, especially from people running CS Bridge on real clusters. Participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security problem rather than a bug? Report it
privately — see [SECURITY.md](SECURITY.md).

## Prerequisites

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 20 or newer (CI runs Node 24)
- [VS Code](https://code.visualstudio.com/) 1.98 or newer

## Development setup

```sh
git clone https://github.com/cyber-shuttle/CS-Bridge.git
cd CS-Bridge
npm install
npm run watch      # esbuild in watch mode: extension + webview bundles
```

Press **F5** to open an Extension Development Host with the extension loaded; reload that window
(*Developer: Reload Window*) to pick up a rebuild. The activity-bar entry is titled **CS Bridge**.

The Extension Development Host is the only window that loads a development build — a remote window opened from it
does not inherit the extension. Testing the connect path end to end therefore needs an installed build:

```sh
npm run dev        # npm install, package the .vsix, install it into VS Code
```

## Before you open a pull request

```sh
npm run check-types   # tsc twice: the extension config, then src/ui/tsconfig.json
npm run lint          # eslint src  (npm run lint:fix applies what it can)
npm test              # node --test over src/modules/*.test.ts and src/ui/logic/*.test.ts
```

These three are exactly what `.github/workflows/ci.yml` runs on every pull request. esbuild does not type-check, so
a `.tsx` type error surfaces only under `check-types`.

## Submitting a change

- Branch off `main` and open the pull request against `main`.
- Cover new behaviour with a test. Tests sit beside what they test as `*.test.ts`. A module that imports `vscode`
  cannot be loaded by the test runner, so testable logic belongs in a `vscode`-free module — see
  [Source layout](docs/ARCHITECTURE.md#source-layout).
- Say in the description what you ran and against what: the three commands above, plus the cluster and scheduler if
  the change touches the launch or connect path. The webview `.tsx` rendering has no automated coverage, so UI
  changes want a screenshot from the Extension Development Host.
- Add a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Slurm's own terms (`CANCELLED`, `scancel`) stay as Slurm writes them; everywhere else the verb is "stop", not
  "cancel", and the session status is `stopped`.
- Keep CI green; a red check is the author's to clear.

Source layout, the status model, the SSH transport and the build pipeline are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Open work is in the
[issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues). There is no CLA and no DCO sign-off.

## Releasing

Maintainers, one pull request per release:

1. Bump `version` in `package.json`.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, open a fresh `[Unreleased]` above it,
   and add the version's link definition at the bottom of the file. Group entries under the Keep a Changelog
   headings only: Added, Changed, Deprecated, Removed, Fixed, Security.
3. If the release needs a newer linkspan, say so under the version heading (`Requires linkspan X.Y.Z.`). The
   changelog is the only place that companion-agent contract is recorded.
4. Merge the pull request as `release: X.Y.Z`, then tag that commit `X.Y.Z` — no `v` prefix — and push the tag.
5. `npm run package` produces `csbridge-X.Y.Z.vsix`. A maintainer uploads it to the VS Code Marketplace under the
   `cybershuttle` publisher; there is no publish workflow.
