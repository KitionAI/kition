# Kit Platform Architecture

Status: proposal, 2026-10-09.

Kition is a workspace for documents, data, media, and an AI agent that works
across all of them. This document defines how professional editors (images,
PDF, video, vector, audio, and others) become **kits**: installable, native
components that open inside Kition and that the Kition agent can drive.

The wire contract is specified in [kit-protocol.md](kit-protocol.md) and the
machine-readable schemas live in [`contracts/kit/`](../contracts/kit/).

## 1. Goals

- Open professional file types (PSD, PDF, video projects, vector art, audio
  sessions) inside the Kition window with native rendering performance.
- Let the Kition agent operate every installed kit through one command model,
  the same way a person does through the UI.
- Keep the base download small: built-in kits ship with Kition, everything else
  installs on demand.
- Reuse strong open-source engines without taking ownership of millions of
  lines of upstream code.

Non-goals for the first version:

- Third-party kit marketplace. Version 1 accepts first-party kits only.
- Rewriting kit user interfaces in React.
- Running native kits in an operating-system sandbox.

## 2. Upstream Candidates

The first candidate engines are the open-source "Crafting Apps" published under
the `storytold` GitHub organization (photo, vector, PDF, raw photo, effects,
slides, spreadsheet, audio, CAD, word processing, design, and video editors).
The facts that drive this architecture:

| Property | Observation | Consequence |
| --- | --- | --- |
| Size | Roughly 300k lines of Rust per application, about a dozen applications | Absorbing all of them into Kition is not maintainable |
| User interface | egui on wgpu, drawn on a GPU canvas, isolated in one `ui-egui` crate | Cannot become React components; must be hosted as a native surface |
| Engine | Pure-data document model with a single command registry (500+ commands per app) | One command model serves UI, CLI, automation, and agents |
| Automation | CLI, authenticated JSON-lines control channel, MCP server, offscreen screenshots | A natural basis for the kit protocol |
| Web build | Engine and UI compile to WebAssembly with WebGPU | A non-native fallback surface exists |
| Shared code | No shared core: `geom`, `color`, `gpu`, and similar crates are copied per repository and have diverged | A merged monorepo would not deduplicate anything |
| Velocity | Hundreds of commits each, updated daily, self-described early alpha | Forks drift quickly; sync on a schedule and keep Kition changes additive |
| License | MIT OR Apache-2.0 | Redistribution is allowed with attribution; product names are not ours to use |

## 3. Options Considered

### 3.1 Fork everything into Kition (rejected)

Copying every upstream repository into Kition as "kit components" fails on
three counts: the egui user interfaces cannot become React components without a
full rewrite, the combined code base would be several million lines with no
shared core, and daily upstream changes would make merging impractical. It also
violates the client repository boundary in `AGENTS.md`.

### 3.2 In-process plugins (rejected)

Loading kits as dynamic libraries or JavaScript modules inside Kition gives no
crash isolation, couples Kition to the upstream Rust toolchain and ABI, and
still does not solve the egui versus DOM rendering mismatch.

### 3.3 Kits as separate processes behind a protocol (chosen)

Each kit is a separate native executable, built in its own repository, that
speaks the Kit Protocol. Kition is the host. Each kit repository is a
maintained fork of one upstream application (section 7), so Kition can change
kits while still merging upstream progress. This is the model of editor
extensions with language servers: the host owns the workspace, the shell, and
the agent; each kit owns one editing domain.

## 4. Architecture

```text
+------------------------------- Kition Host --------------------------------+
| Renderer (React)                                                           |
|   workspace tree, tabs, agent panel, built-in kits (markdown, table, ...)  |
|   kit tab = placeholder region that reports its bounds                     |
|                                                                            |
| Tauri shell (Rust) = Kit Host                                              |
|   kit index, install + verify, process supervisor, surface placement,     |
|   focus and shortcut routing                                               |
+-----------+--------------------------------------------+-------------------+
            | Kit Protocol (JSON-RPC 2.0, local socket)    | runtime HTTP API
            v                                              v
   +-----------------+   +-----------------+       +------------------------+
   | kit.pdf process |   | kit.photo proc. |  ...  | Kition runtime         |
   | upstream engine |   | upstream engine |       | agent, data, workflows |
   | + Kition adapter|   | + Kition adapter|       | attaches to kits as a  |
   +-----------------+   +-----------------+       | second protocol client |
                                                   +------------------------+
```

Responsibilities:

| Component | Owns |
| --- | --- |
| Renderer | Tabs, layout, the kit placeholder region, the agent panel, built-in kits |
| Tauri shell (Kit Host) | Kit index and installation, checksum verification, spawning and supervising kit processes, surface placement, focus and shortcut routing, crash recovery |
| Kit process | Document model, rendering, its own menus, panels, and dialogs inside its surface, file I/O for the documents it was given |
| Runtime | Agent turns; it attaches to running kits (or starts headless ones through the host) and exposes kit commands as agent tools |

The runtime is an opaque binary. Its implementation language is not part of any
public contract; the client and kits depend only on HTTP behavior, the Kit
Protocol, and capability flags.

## 5. Built-In And Installable Kits

| Kind | Examples | Implementation | Delivery |
| --- | --- | --- | --- |
| Built-in | Markdown documents, tables, whiteboard, presentations | React inside the renderer | Ships with Kition |
| Installable | `kit.pdf`, `kit.photo`, `kit.vector`, `kit.film`, `kit.audio` | Native executable speaking the Kit Protocol | Downloaded on first use |

Built-in kits stay Kition's own products. Upstream word processing,
spreadsheet, and slide engines overlap with them; they are candidates only for
high-fidelity `.docx`, `.xlsx`, and `.pptx` import and export kits running in
`headless` mode, not replacements for the built-in editors.

## 6. Surfaces: How A Kit Appears Inside Kition

A **surface** is where a kit renders. A kit declares the surfaces it supports
in its manifest; the host picks the best one for the current platform.

| Surface | Inside the Kition window | Native rendering | Use |
| --- | --- | --- | --- |
| `embedded` | Yes, in the tab content region | Yes | Default for desktop editing |
| `window` | No, separate top-level window | Yes | Fallback and "pop out to window" |
| `web` | Yes, inside the DOM | No (WebAssembly + WebGPU) | Web build, quick previews, thumbnails |
| `headless` | No user interface | Yes | Agent automation, batch conversion, import and export |

### 6.1 Embedding mechanisms

The kit runs in its own process, so `embedded` requires cross-process window
composition. The mechanism differs per platform:

| Platform | Mechanism | Notes |
| --- | --- | --- |
| Windows | `child-window`: the kit creates a child `HWND` parented to the Kition window handle | Supported across processes; input queues must be coordinated |
| Linux X11 | `child-window`: the kit window is reparented under the Kition window | Supported across processes |
| Linux Wayland | none | Falls back to `window` |
| macOS | to be decided by the prototype (section 11) | An `NSView` handle is a process-local pointer and cannot be parented across processes |

macOS candidates, in prototype order:

1. `overlay-window`: a borderless kit window ordered directly above the Kition
   window by window number, with the host streaming bounds on every move and
   resize. Public APIs only; risk of visible lag during window drags and of
   quirks with Spaces and full screen.
2. `shared-texture`: the kit renders offscreen into an `IOSurface`, hands it to
   the host, and the host displays it in a native layer while forwarding input
   events. Public APIs; adds input translation work and about one frame of
   latency.
3. `remote-layer`: cross-process Core Animation layer hosting, as used by
   Chromium. Best fidelity, but relies on private APIs.

The protocol carries the mechanism name so that each platform can use a
different one without changing kits' document or command logic.

### 6.2 Airspace rule for Kition UI

A native surface always draws above web content in its region. Therefore:

- No React overlay (menus, popovers, toasts, dialogs, agent bubbles) may overlap
  an `embedded` kit region.
- When a modal Kition dialog must cover the region, the host requests a
  `surface.snapshot`, hides the surface, shows the snapshot image in its place,
  and restores the surface when the dialog closes.
- Kits draw their own menus, panels, and dialogs inside their surface.

This rule belongs in `docs/design.md` once the first embedded kit ships.

### 6.3 Focus and shortcuts

- The kit handles keys while its surface has focus, including input method
  composition.
- A host-reserved shortcut set (switch tab, command palette, toggle agent
  panel, quit) is sent to the kit during initialization. The kit must not
  consume those keys and forwards them with `input.forwardShortcut`.
- `Mod+S` and other document shortcuts are handled by the kit, which reports
  results through document notifications.

## 7. Upstream Integration Policy

Kition modifies kits to integrate them with the product (theme, menus, agent
hooks, Kition-specific features), so each kit is a **maintained fork** of its
upstream, not a pinned dependency.

### 7.1 Repository and branch model

- Each kit repository is a GitHub fork of its upstream, renamed to
  `KitionAI/kit-<name>` (for example `KitionAI/kit-photo` forks the upstream
  photo editor).
- Branches:
  - `upstream`: an exact mirror of the upstream default branch. Never commit
    to it.
  - `main` (default): `upstream` plus Kition changes. All Kition work lands
    here through pull requests.
- Upstream sync is a scheduled job (weekly, or on demand) that fast-forwards
  `upstream` and opens a pull request merging it into `main`. The merge must
  pass the kit's tests and the Kit Protocol conformance suite. Merge, do not
  rebase, so that collaborators' history stays stable.
- Releases are tagged on `main` as `v<kit-version>`; `kit.json` attribution
  records the upstream revision included in the release.

### 7.2 Rules that keep upstream merges cheap

1. **Add, do not edit.** Kition code goes into new crates that upstream never
   touches: `crates/kition-*` (protocol server, theme, surface attachment,
   Kition integrations) and `apps/kit-<name>` (the kit executable).
2. **Hooks over rewrites.** When upstream code must change, make the smallest
   change that exposes an extension point (a trait, a callback, a feature
   flag), and implement the behavior in a `kition-*` crate.
3. **Offer generic changes upstream.** Extension points and bug fixes are
   proposed upstream as well; once accepted, the local diff disappears at the
   next sync.
4. **Keep a change ledger.** `KITION_CHANGES.md` lists every modified upstream
   file with the reason and the upstream pull request, if any. Review it at
   every sync.
5. **Product look through tokens.** Kition theming (colors, radii, fonts) is
   applied through egui style and visuals from a `kition-theme` crate fed by
   the same tokens as `docs/design.md`, not by editing upstream widgets.
6. **Branding.** User-visible names, icons, and about screens show the Kition
   kit name. Upstream names remain only in `NOTICE`, license files, and
   attribution.

### 7.3 Workspace layout

```text
kit-photo/                       fork of the upstream repository
  Cargo.toml                     upstream workspace + Kition members
  crates/<upstream crates>       upstream code, edited only per section 7.2
  crates/kition-kit-server/      Kit Protocol server over the engine command registry
  crates/kition-surface/         embedded and window surface attachment
  crates/kition-theme/           design tokens to egui visuals
  apps/<upstream app>/           upstream desktop app, kept buildable
  apps/kit-photo/                kit executable: app shell + protocol server
  kit.json                       manifest template; version and checksums filled by CI
  KITION_CHANGES.md              ledger of upstream file modifications
  NOTICE, LICENSE-*              upstream attribution and licenses
```

Keeping the upstream app buildable lets upstream tests keep running and makes
regressions introduced by Kition changes visible.

### 7.4 Build pipeline

GitHub Actions in each kit repository:

1. Matrix build for `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`
   with the toolchain pinned in `rust-toolchain.toml` (at least upstream's
   `rust-version`).
2. Optional build inputs such as bundled fonts are fetched at pinned revisions.
3. Upstream test suite plus Kition crate tests.
4. macOS executables are signed with the Kition Developer ID and notarized;
   Windows executables are Authenticode signed.
5. Package `kit-<name>-<version>-<target>.tar.gz` (`.zip` on Windows)
   containing the executable, `kit.json`, `NOTICE`, and license texts.
6. Run the Kit Protocol conformance suite against the packaged executable.
7. Upload assets to the kit repository's GitHub Release.

## 8. Distribution And Verification

Decisions (2026-10-09):

- Kit assets are hosted on **GitHub Releases only**, the same channel as the
  runtime. Users behind restrictive networks use the standard proxy variables,
  as documented in [runtime-development.md](runtime-development.md).
- The kit index is **signed with Ed25519**. The public key is compiled into
  Kition; the private key is kept offline and used only by the index release
  workflow.
- Users install kits **when opening a file that needs one** (a prompt with a
  one-click install) and manage them on a **Kits page in Settings** (install,
  update, uninstall).

### 8.1 Index

- A dedicated repository, `KitionAI/kits`, publishes `kit-index.json` (see
  `contracts/kit/kit-index.schema.json`) and `kit-index.json.sig` (a detached
  Ed25519 signature over the exact file bytes) as assets of an index Release.
  Each index Release is immutable; the newest one is discovered through the
  GitHub Releases API, then pinned by tag for the session.
- The index lists kit identifiers, versions, required kit protocol version, the
  kit's Release tag, and per-target assets with size and SHA-256. Assets are
  downloaded from the Release of the kit's own repository.
- The host refuses an index whose signature does not verify, whose
  `generatedAt` is older than the cached index (rollback protection), or whose
  `schemaVersion` it does not understand.

### 8.2 Install flow

1. Opening a file with no installed handler looks up `fileTypes` in the cached
   index and shows an install prompt naming the kit and download size.
2. The host downloads the asset for the current target, checks size and
   SHA-256 against the signed index, and extracts it into a temporary
   directory.
3. The host validates the extracted `kit.json` against the manifest schema and
   checks that `id`, `version`, and `kitProtocol` match the index entry.
4. On macOS the host verifies the code signature of the executable before the
   first launch.
5. The directory is renamed atomically into the cache and the file opens.

### 8.3 Updates and removal

- The Kits page checks the index on open and once per day. Updates download in
  the background and apply the next time the kit starts; a running kit is never
  replaced underneath open documents.
- The previous version is kept until the new one starts successfully, so a
  failed update rolls back automatically.
- Uninstall deletes the kit cache directory after its processes exit.

### 8.4 Cache

- The host never resolves a floating `latest` version during a session; it
  updates the index explicitly and installs exact versions.
- Installation is atomic into the native Kition cache:

  ```text
  macOS:   $HOME/Library/Caches/Kition/kits/<kit-id>/<version>/<target>/
  Windows: %LOCALAPPDATA%/Kition/Cache/kits/<kit-id>/<version>/<target>/
  Linux:   ${XDG_CACHE_HOME:-$HOME/.cache}/kition/kits/<kit-id>/<version>/<target>/
  ```

- The host recomputes the executable checksum before every launch.
- macOS kit executables are signed and notarized with the Kition identity.
- Development overrides mirror the runtime: `KITION_KIT_<ID>_BINARY` points at
  a local build and skips download.

## 9. Trust And Permissions

Native kits run with the user's privileges. Version 1 therefore accepts only
first-party kits signed by Kition. The manifest still declares permissions so
that the host can enforce what it controls and so that a future third-party
program has a foundation:

- Kits receive file access only through URIs the host passes in
  `document.open` and `document.saveAs`. Conformance tests check that kits do
  not enumerate the workspace on their own.
- Network access must be declared; the default is none.
- Agent-invoked commands that mutate a document follow the same approval
  policy as other agent edits.

## 10. Agent Integration

- On attach, the runtime calls `commands.list` and maps each command to an
  agent tool with the command's JSON Schema parameters.
- The agent uses `view.screenshot` for visual feedback after edits.
- Large command catalogs are filtered by the kit's `agent.toolGroups` metadata
  so that a turn sees only the relevant groups.
- When no tab is open for a document, the runtime asks the host for a
  `headless` instance of the kit.

## 11. Phases

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| 0 | Kit Protocol and manifest schemas, client mock kit | Schemas validated in CI; a mock kit passes the conformance suite |
| 1 | Embedding prototype with `kit.photo` on macOS and Windows | Drag, resize, focus, IME, shortcuts, and snapshot overlay judged acceptable in the real desktop client |
| 2 | `kit.pdf` as the first shipped kit: `window` and `headless`, then `embedded` | Open, annotate, save, and agent-driven edits through the protocol |
| 3 | Kit index, installation, verification, updates | Install from a clean machine, offline relaunch from cache |
| 4 | `kit.photo` and lightweight React editing over headless engines (crop and adjust images inside documents) | Image edits round-trip from documents |
| 5 | Additional kits (video, vector, audio) | Each passes conformance and embedding acceptance |

Embedding behavior must be validated in the real desktop client. Headless test
runs cannot reproduce native surface placement, focus, or input method issues.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| macOS cross-process embedding quality | Prototype three mechanisms before committing; `window` stays available |
| Upstream instability (alpha, high churn) | Scheduled sync pull requests gated by tests and conformance; additive Kition changes per section 7.2 |
| Large command catalogs overwhelm the agent | Tool groups and per-turn filtering |
| Kit crashes | Process isolation; the host restarts the kit and reopens documents from disk |
| Bundle size | Only built-in kits ship with Kition; others install on demand |
| Font licensing for bundled fonts | Review each font package before redistribution |
