# Contributing to Kition

Thank you for contributing to the public Kition desktop client.

All changes should follow the [Kition Development Standard](docs/development-standard.md).
It includes the recommended worktree workflow for contributors developing in
Orca.

## Scope

This repository contains the React and Electron client, public runtime
contracts, mocks, fixtures, packaging logic, and black-box tests. The
proprietary runtime implementation is maintained separately.

Cross-repository behavior changes must begin here with a public contract,
capability, mock, or client integration update. Contributors never need access
to the private runtime source repository.

## Local Setup

Requirements:

- Node.js 22.19.0
- pnpm 10.33.0

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the desktop app with the exact runtime pinned by
`electron/runtime.lock.json`. It verifies and caches a published runtime outside
the Git worktree before launching Electron.

For renderer, component, editor, and style work that does not require the
desktop runtime:

```bash
pnpm dev:web
```

This is the supported open-source fallback when the pinned runtime release is
not available for the current platform. It starts in a backendless preview mode,
so optional runtime-backed startup requests are skipped while document editing
and visual development remain available. To use an already-running API instead,
set `KITION_API_TARGET` before the same command:

```bash
KITION_API_TARGET=http://127.0.0.1:18101 pnpm dev:web
```

Runtime cache, proxy, and explicit binary options are documented in
[Runtime development](docs/runtime-development.md).

## Development Identities

Environment selection is not exposed through Make targets or local release
commands.

| Identity | Source | Portal | Distribution |
| --- | --- | --- | --- |
| `dev` | Local source checkout | Preview by default, locally overridable | Never published |
| `rc` | SemVer prerelease tag | Preview | GitHub prerelease |
| `stable` | Plain SemVer tag | Production | GitHub stable release |

Local builds default to `dev`. Official `rc` and `stable` identities are
injected only by the release workflow after it classifies the immutable tag.

## Testing Model

Public tests must not require production credentials, a private repository, or
network access to the Portal. Browser and Electron end-to-end tests use the
public mock API and isolated temporary desktop state.

| Command | Coverage |
| --- | --- |
| `pnpm test` | Full Vitest unit and component suite |
| `pnpm test:desktop:unit` | Electron bridge, runtime resolution, and packaging contracts |
| `pnpm test:e2e` | Mock-backed renderer black-box flows |
| `pnpm test:desktop:e2e` | Mock-backed real Electron flows |
| `pnpm test:table:e2e` | Required table-widget regression gate |
| `pnpm build:check` | Runtime lock, assets, notices, types, and renderer build |

Feature-specific inspection commands remain available in `package.json` for
Kitable, Scenario, Workflow, and Agent work.

## Before Opening a Pull Request

Run the same core checks used by CI:

```bash
pnpm check
pnpm test:e2e
pnpm test:table:e2e
```

For Electron-specific behavior, also run `pnpm test:desktop:e2e` on a supported
desktop platform.

For visual changes, include a screenshot or screen recording. If an AI coding
agent contributed to the change, include a brief review summary covering
platform compatibility, runtime boundaries, performance, UI quality when
applicable, and basic security risks.

## Pull Requests

- Keep changes focused and explain the user-facing behavior they affect.
- Add tests that would catch the reported regression.
- Do not commit generated output, local configuration, credentials, runtime
  binaries, or host-specific paths.
- Keep repository filenames, documentation, comments, tests, fixtures, and UI
  copy in English.
- Update public runtime contracts before depending on new runtime behavior.
- State which platforms and test commands were exercised.

## Release Process

Releases are maintainer-managed through GitHub Actions. Do not add version bumps
or run a local production packaging command for a normal contribution.

1. `Prepare Unified Release` validates the version, creates a draft release,
   and requests the matching private runtime artifacts.
2. `Publish Unified Release` verifies the draft assets, derives the build
   identity from the tag, signs and packages the desktop clients, and publishes
   the release.

Tags with a prerelease component, such as `v1.0.0-beta.3` or `v1.1.0-rc.1`,
produce `rc` builds and GitHub prereleases. Plain tags such as `v1.1.0` produce
`stable` builds. There is no manual test/production selector.

Security reports must follow [.github/SECURITY.md](.github/SECURITY.md).
