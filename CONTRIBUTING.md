# Contributing to Kition

Thank you for contributing to the public Kition desktop client.

All changes should follow the [Kition Development Standard](docs/development-standard.md).
It includes the recommended worktree workflow for contributors developing in
Orca.

## Scope

This repository contains the React client and its Tauri desktop shell, public
runtime contracts, mocks, fixtures, packaging logic, and black-box tests. The
proprietary runtime implementation is maintained separately.

Cross-repository behavior changes must begin here with a public contract,
capability, mock, or client integration update. Contributors never need access
to the private runtime source repository.

## Local Setup

Requirements:

- Node.js 22.19.0
- pnpm 10.33.0
- Rust (stable) and the
  [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the desktop app. The Rust runtime in `crates/` is compiled
into the Tauri shell and runs in-process; see
[docs/runtime-development.md](docs/runtime-development.md).

For renderer, component, editor, and style work that does not require the
desktop runtime:

```bash
pnpm dev:web
```

It starts in a backendless preview mode,
so optional runtime-backed startup requests are skipped while document editing
and visual development remain available. To use an already-running API instead,
set `KITION_API_TARGET` before the same command:

```bash
KITION_API_TARGET=http://127.0.0.1:18101 pnpm dev:web
```

Runtime crates, checks, and rules are documented in
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
network access to the Portal. Browser and desktop end-to-end tests use the
public mock API and isolated temporary desktop state. Desktop specs run the
renderer in Chromium against a mocked `window.kitionDesktop` bridge
(`e2e/helpers/desktopHost.ts`); the native shell is covered by its own Rust
tests.

| Command | Coverage |
| --- | --- |
| `pnpm test` | Full Vitest unit and component suite |
| `pnpm test:desktop:unit` | Desktop bridge, runtime resolution, and packaging contracts |
| `pnpm check:desktop` | Desktop shell lint and Rust tests (`src-tauri/`) |
| `pnpm test:e2e` | Mock-backed renderer black-box flows |
| `pnpm test:desktop:e2e` | Desktop flows against the mocked desktop bridge |
| `pnpm test:table:e2e` | Required table-widget regression gate |
| `pnpm test:ktable:e2e` | Required Table kit regression gate (`e2e/table-kit.spec.ts`) |
| `pnpm build:check` | Runtime lock, assets, notices, types, and renderer build |

Feature-specific inspection commands remain available in `package.json` for
Table kit, Scenario, Workflow, and Agent work.

## Before Opening a Pull Request

Run the same core checks used by CI:

```bash
pnpm check
pnpm test:e2e
pnpm test:table:e2e
pnpm test:ktable:e2e
```

For desktop shell changes, also run `pnpm check:desktop` and
`pnpm test:desktop:e2e`, and try the change in `pnpm dev` on a supported
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
or run a local production packaging command for a normal contribution. Official
GitHub Releases must be published as `allentatakai`.

1. `Prepare Unified Release` validates the version, creates a draft release,
   and requests the matching private runtime artifacts.
2. `Publish Unified Release` verifies the draft assets, derives the build
   identity from the tag, signs and packages the desktop clients, and publishes
   the release.

Tags with a prerelease component, such as `v0.2.0-beta.1` or `v1.1.0-rc.1`,
produce `rc` builds and GitHub prereleases. Plain tags such as `v1.1.0` produce
`stable` builds. There is no manual test/production selector.

Security reports must follow [.github/SECURITY.md](.github/SECURITY.md).
