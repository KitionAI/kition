# Proprietary Runtime Development

The desktop client can run against a released proprietary Kition runtime
without a Go checkout or access to the private runtime repository.

## Start the desktop client

From the repository root:

```bash
pnpm dev
```

The command reads `electron/runtime.lock.json`, resolves the current platform,
downloads the exact runtime asset from the pinned `KitionAI/kition-dev` GitHub
Release, verifies its declared size and SHA-256, installs it atomically in the
native Kition cache directory, and starts Electron with `KITION_API_BINARY`
pointing at the verified binary.

The command never resolves a floating `latest` version and never requires a
GitHub token for a published Release.

For runtime maintainers, the command first checks the sibling development path
`../kition-runtime/dist/kition-api` (or `.exe` on Windows). If that executable
exists, it is used as an explicit local runtime and no network request is made.
An explicitly configured `KITION_API_BINARY` always takes priority over this
automatic sibling lookup.

## Cache locations

```text
macOS:   $HOME/Library/Caches/Kition/runtime/<version>/<target>/
Windows: %LOCALAPPDATA%/Kition/Cache/runtime/<version>/<target>/
Linux:   ${XDG_CACHE_HOME:-$HOME/.cache}/kition/runtime/<version>/<target>/
```

Each installed runtime includes local metadata containing the version,
protocol, target, release tag, archive checksum, and binary checksum. Cache
reuse recomputes the binary checksum before starting the runtime.

## Development overrides

| Variable | Purpose |
| --- | --- |
| `KITION_API_BINARY` | Use an explicit local runtime binary and skip downloading. |
| `KITION_RUNTIME_VERSION` | Select another published version for one invocation. |
| `KITION_RUNTIME_BASE_URL` | Use a local or staging Release-compatible asset server. |
| `KITION_RUNTIME_FORCE_DOWNLOAD=1` | Replace an otherwise valid cache entry. |
| `KITION_RUNTIME_OFFLINE=1` | Forbid network access and require a verified cache entry. |

Downloads honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
`NO_PROXY` environment variables through the Node HTTP adapter.

When GitHub downloads are slow or blocked, pass the same proxy variables to
the install, development, or build command. Replace the example port with the
local proxy port:

```bash
HTTPS_PROXY=http://127.0.0.1:1080 \
HTTP_PROXY=http://127.0.0.1:1080 \
NO_PROXY=127.0.0.1,localhost \
pnpm dev
```

Internal full-stack development against a locally built private runtime uses:

```bash
KITION_API_BINARY=<runtime-binary> pnpm dev
```

With the standard sibling checkout layout, the shorter command is sufficient:

```bash
pnpm dev
```

Open-source contributors who only need the renderer can always use `pnpm dev:web`.
Full desktop startup without a local runtime requires the pinned Release assets
to be published.

Do not copy a private runtime binary into the Git worktree. The normal cache and
`electron/resources/bin/` build input are ignored, and the packaging script
removes its temporary sidecar input after every build.

## Compatibility checks

The runtime exposes `/desktop/runtime`. Electron validates:

- the runtime process ID;
- the hashed workspace ID;
- runtime version presence;
- exact protocol compatibility with `electron/runtime.lock.json`;
- build commit presence;
- the capabilities list.

An incompatible runtime is stopped before the normal product UI is allowed to
use it. Optional UI behavior must be driven by capabilities rather than runtime
version comparisons.

The public schemas live under `contracts/runtime/`.

## Packaging

Official packaging accepts runtime input in this order:

1. `KITION_RUNTIME_ASSET_DIR`
2. `KITION_API_BINARY`
3. the checked-in runtime lock and verified cache/download

There is no source-build fallback. Missing, unverified, or incompatible runtime
input fails the build and directs the developer to `pnpm dev` or
`KITION_API_BINARY`.

For a local non-CI build, `pnpm run build:unpack` also discovers the standard
`../kition-runtime/dist/kition-api` sibling path before attempting a Release
download. CI builds never use this convenience lookup; release workflows must
provide `KITION_RUNTIME_ASSET_DIR` so the packaged binary is verified against
the prepared runtime metadata.

## Unified Release workflows

The public repository owns both workflows:

```text
.github/workflows/prepare-release.yml
.github/workflows/publish-release.yml
```

Release environments are derived from immutable tags rather than selected by
a local command or workflow input:

- local builds use the `dev` identity;
- prerelease tags such as `v0.2.0-beta.1` or `v1.1.0-rc.1` use the `rc`
  identity and are published as GitHub prereleases;
- plain tags such as `v1.1.0` use the `stable` identity and are published to
  the production update channel.

Only CI injects an official `rc` or `stable` identity. Local commands do not
expose environment-specific build targets. Local full-stack development can
still override the Portal endpoint explicitly with `KITION_PORTAL_BASE_URL`.

`Prepare Unified Release` validates the package/runtime lock, creates separate
draft Releases in `KitionAI/kition` and `KitionAI/kition-dev`, and dispatches
the private runtime workflow.

The private `KitionAI/kition-runtime` workflow must be named
`build-release-assets.yml` and accept these `workflow_dispatch` inputs:

```text
version
release_tag
protocol_version
public_repository
```

It uploads the manifest, checksums, SBOM/provenance, and platform archives to
the existing `KitionAI/kition-dev` draft Release and publishes it after
verification. Its upload credential must be a GitHub App or fine-grained token
restricted to Release contents in `KitionAI/kition-dev`.

`Publish Unified Release` verifies the published developer runtime assets,
prepares the runtime locally, packages the desktop clients without private
source access, uploads only end-user installers and updater metadata to the
`KitionAI/kition` Release, and publishes it.

The public `release` environment requires:

```text
KITION_RUNTIME_DISPATCH_TOKEN
MACOS_CSC_P12_BASE64
MACOS_CSC_KEY_PASSWORD
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_API_KEY_P8
```
