# Kit Platform Architecture

Status: proposal, 2026-10-09; revised 2026-10-10 for the in-process Rust
runtime and for `kit.photo` as the first kit. Partly superseded: kits draw
their own editors in the page as WebAssembly packages, and Kition ships every
package inside the app (2026-10-15); native kit surfaces (section 6), the
signed kit index and per-platform downloads were removed (2026-10-28), so kit
processes run only headless and kits are pinned in `kits/kits.lock.json`. See
[kit-sdk.md](kit-sdk.md).

Kition is a workspace for documents, data, media, and an AI agent that works
across all of them. This document defines how professional editors (images,
PDF, video, vector, audio, and others) become **kits**: installable, native
components that open inside Kition and that the Kition agent can drive.

The wire contract is specified in the Kition kit platform (kition-sdk `docs/platform/reference/kit-protocol.md`) and the
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

## 2. Engine Origins

The kit engines started from open-source Rust editors licensed MIT OR Apache-2.0. Kition copied
each into its own kit repository (`KitionAI/kition-<kit>`), took it under Apache-2.0, removed
everything it does not use (the native desktop application, its user interface, command-line
tools, and release tooling), and maintains the rest as its own code. Kition does not merge
upstream work. Each kit's `NOTICE` credits its origin.

What the engines bring to this architecture:

| Property | Consequence |
| --- | --- |
| Pure-data document model with one command registry per kit | One command model serves the in-page editor, the headless kit, and the agent |
| Engines compile to WebAssembly | Kit editors run the engine in a Web Worker in the page |
| Each repository keeps its own copies of shared crates | Repositories stay separate; nothing is deduplicated by merging them |

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
speaks the Kit Protocol. Kition is the host. Each kit repository is Kition's
own copy of one upstream application (section 7), so Kition can change
kits while still merging upstream progress. This is the model of editor
extensions with language servers: the host owns the workspace, the shell, and
the agent; each kit owns one editing domain.

## 4. Architecture

```text
+------------------------- Kition desktop process --------------------------+
| Renderer (React)                                                          |
|   workspace tree, tabs, agent panel, built-in kits (markdown, table, ...) |
|   kit tab = the kit's own editor in an iframe (KitFrame, Kit UI protocol) |
|                 | loopback HTTP API                                       |
| Tauri shell (Rust) = Kit Host       | Runtime (Rust crates, in-process)   |
|   window, menus, updates            |   agent, data, workflows; starts    |
|                                     |   headless kits through             |
|                                     |   kition-kit-host                   |
+-------------+-------------------------------------+-----------------------+
              | Kit Protocol (JSON-RPC 2.0, local socket or named pipe)
              v                                     v
     +-------------------+   +-------------------+
     | kit.photo process |   | kit.pdf process   |  ...
     | upstream engine   |   | upstream engine   |
     | + Kition adapter  |   | + Kition adapter  |
     +-------------------+   +-------------------+
```

Responsibilities:

| Component | Owns |
| --- | --- |
| Renderer | Tabs, layout, the agent panel, and each kit's editor in `KitFrame` (the kit's WebAssembly engine in a worker) |
| Tauri shell | The desktop window; it runs the runtime in-process |
| Kit process (headless) | Document model, rendering previews, commands, and file I/O for the documents it was given, for the agent |
| Runtime | Agent turns; it attaches to running kits (or starts headless ones through the host) and exposes kit commands as agent tools |

The runtime is Rust code in this repository (`crates/`) and runs inside the
desktop process (see `AGENTS.md`). It does not get a privileged path into kits:
it opens its own connection with the `agent` role through `kition-kit-host`,
so the kit enforces the same role and URI limits for the agent as for any
other client. Kits depend only on the Kit Protocol.

### 4.1 Kit crates in this repository

| Crate | Purpose |
| --- | --- |
| `kition-kit-protocol` | Message types mirroring `contracts/kit/`, error codes, launch constants, line framing, and the socket or named pipe transport. No async runtime unless the `tokio` feature is enabled, so thread-based kits can use it |
| `kition-kit-host` | Launching a kit with a private endpoint and token, waiting for `ready`, and a request client with timeouts and cancellation. Kits run only headless |
| `kition-kit-mock` | A headless kit for `.mocktext` documents, used to test the host and the suite |
| `kition-kit-conformance` | The conformance suite (protocol section 14), as a library and as the `kition-kit-conformance` command that kit repositories run in CI |

`cargo test -p kition-kit-mock` runs the suite against the mock kit, including
injected faults that each check must catch.

## 5. Built-In And Installable Kits

| Kind | Examples | Implementation | Delivery |
| --- | --- | --- | --- |
| Built-in | Markdown documents, tables, slides | React inside the renderer | Ships with Kition |
| Installable | `kit.photo` first, then `kit.pdf`, `kit.vector`, `kit.film`, `kit.audio` | Native executable speaking the Kit Protocol | Downloaded on first use |

Built-in kits stay Kition's own products. Upstream word processing,
spreadsheet, and slide engines overlap with them; they are candidates only for
high-fidelity `.docx`, `.xlsx`, and `.pptx` import and export kits running in
`headless` mode, not replacements for the built-in editors.

## 6. Surfaces: How A Kit Appears Inside Kition

> **Decision, 2026-10-10:** kit editors run in the page. The kit's engine is
> compiled to WebAssembly (its SDK), runs in a worker, and the kit draws its
> own editor in an iframe (`KitFrame`, Kit UI protocol). The `embedded`
> overlay window was prototyped for `kit.photo` and rejected in the real
> desktop client: it felt like a separate program, doubled the canvas, and
> added scroll bars. How to build a kit editor: [kit-sdk.md](kit-sdk.md).
>
> **2026-10-28:** the native surfaces are gone from the protocol and the
> runtime (`embedded`, `window`, the `surface.*` methods, embedding
> mechanisms, `/v1/kits/surfaces`). A kit process runs only `headless`, for
> the agent: `KITION_KIT_SURFACE=headless` is the only value.

## 7. Upstream Integration Policy

Kition modifies kits to integrate them with the product (theme, menus, agent
hooks, Kition-specific features), so each kit is Kition's **own copy** of its
upstream, not a pinned dependency.

### 7.1 Repository and branch model

Decided 2026-10-10: kit repositories are standalone repositories, not GitHub
forks. Kition does not send pull requests upstream and expects to diverge.

- Each kit repository is `KitionAI/kit-<name>`, created empty and pushed from
  a clone of the upstream repository with its full history, so newer upstream
  work can still be merged. `KitionAI/kition-photo` started from Kition Photo
  `9c427a7a` (version 0.5.0).
- A kit derived from an upstream project credits it only in the kit
  repository's `NOTICE`; neither the README nor `kit.json` names it.
- Branches:
  - `main` (default): the Kition line. All Kition work lands here through
    pull requests.
  - `upstream`: the upstream commit the last sync started from. Never commit
    to it.
- Upstream sync is on demand: fetch upstream, merge it into a branch from
  `main`, and open a pull request. The merge must pass the kit's tests and the
  Kit Protocol conformance suite. Merge, do not rebase.
- Releases are tagged on `main` as `v<kit-version>`.

### 7.2 Rules that keep upstream merges cheap

1. **Add, do not edit.** Kition code goes into new crates that upstream never
   touches: `crates/kition-*` (protocol server, theme, Kition integrations) and `apps/kit-<name>` (the kit executable). Kit
   repositories keep their upstream license and do not link the crates of
   this repository: each kit implements the protocol
   in its own `kition-kit-server` crate, and the conformance suite, which runs
   as a separate program, proves it matches.
2. **Hooks over rewrites.** When upstream code must change, make the smallest
   change that exposes an extension point (a trait, a callback, a feature
   flag), and implement the behavior in a `kition-*` crate.
3. **Offer generic changes upstream.** Extension points and bug fixes are
   proposed upstream as well; once accepted, the local diff disappears at the
   next sync.
4. **Credit upstream in the NOTICE.** A kit derived from an upstream project
   credits it only in the kit repository's `NOTICE`; no change ledger is kept.
5. **Product look through tokens.** Kition theming (colors, radii, fonts) is
   applied through egui style and visuals from a `kition-theme` crate fed by
   the same tokens as `docs/design.md`, not by editing upstream widgets.
6. **Branding.** User-visible names, icons, and about screens show the Kition
   kit name. Upstream names appear only in the kit's `NOTICE`.

### 7.3 Workspace layout

```text
kition-<kit>/                    one kit repository, the same layout for every kit
  crates/kdm/<name>              KDM model (collaboration entry point)
  crates/engine/<name>           domain model, commands, editing logic
  crates/formats/<name>          file import and export (psd, pptx, xlsx, dxf, ...)
  crates/media/<name>            audio and video codecs and containers
  crates/render/<name>           rendering, rasterising, printing
  crates/support/<name>          geometry, color, fonts, text, test helpers
  bindings/wasm/                 kition-<kit>-sdk: the in-page engine (KitDocument)
  bindings/headless/             kit-<kit>: the agent's headless executable
  web/                           the kit's editor (Kit UI protocol)
  kit.json                       manifest (KHP)
  NOTICE, LICENSE                Apache-2.0 and upstream attribution
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
6. Run the Kit Protocol conformance suite against the packaged executable:
   `kition-kit-conformance --kit <executable> --manifest kit.json --fixture
   <document> --edit-command <command> --edit-params '<json>'`.
7. Upload assets to the kit repository's GitHub Release.

## 8. Trust And Permissions

Native kits run with the user's privileges. Version 1 therefore accepts only
first-party kits signed by Kition:

- Kits receive file access only through URIs the host passes in
  `document.open` and `document.saveAs`. Conformance tests check that kits do
  not enumerate the workspace on their own.
- Network access must be declared; the default is none.
- Agent-invoked commands that mutate a document follow the same approval
  policy as other agent edits.

## 9. Agent Integration

- On attach, the runtime calls `commands.list` and maps each command to an
  agent tool with the command's JSON Schema parameters.
- The agent uses `view.screenshot` for visual feedback after edits.
- Large command catalogs are searched by keyword (`<prefix>_commands`) rather than listed in
  full, so that a turn sees only the relevant commands.
- When no tab is open for a document, the runtime asks the host for a
  `headless` instance of the kit.

## 10. Phases

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| 0 | Kit crates in this repository (section 4.1): protocol types, host launch and client, mock kit, conformance suite | Types round-trip through the schemas; the mock kit passes the suite and each injected fault fails its check; `pnpm check:desktop` passes |
| 1 | `KitionAI/kition-photo` repository: `kition-kit-server`, `apps/kit-photo` with a `headless` backend over the upstream automation engine, `kition-theme`, branding | `headless` passes the conformance suite (reached 2026-10-10, 13 of 13 checks) |
| 2 | Runtime integration (`kition-kits`): the workspace lists `.psd`, `.psb`, and `.kphoto`; a Photo tab shows the rendered preview and layers with Undo, Redo, and Save; agent tools `photo_inspect`, `photo_commands`, `photo_run`; `/v1/kits` in `contracts/runtime/kits.schema.json`; `KITION_KIT_PHOTO_BINARY` override | Reached for `headless` on 2026-10-10: open, edit, and save a PSD from the workspace, and agent edits refresh the tab |
| 3a | In-page editing with `kit.photo` ([kit-sdk.md](kit-sdk.md)): `kition-photo-sdk` (WebAssembly) in a worker per file, `src/features/kits` template, exact damage repaint, saves through `PUT /v1/kits/files`, two-way sync with the agent | Reached 2026-10-10: checked in the real desktop client; a 4K PSD opens and saves with no main-thread long tasks |
| 3 (rejected) | Embedding with `kit.photo`: the kit hosts its full desktop editor in-process (`embedded` surface); the runtime (`kition-kits` surfaces) keeps the borderless editor window over the tab from the tab's rectangle and the window position the shell reports, and hides it with the tab, dialogs, or when another app takes focus. macOS first (`overlay-window`), then Windows (`child-window`) | Prototyped on macOS 2026-10-10 and rejected in the real desktop client; superseded by 3a; its code removed 2026-10-28 |
| 4 (dropped) | Distribution: downloaded native kits through a signed index | Superseded: kits ship inside the app, pinned in `kits/kits.lock.json`; the index, its schema and types were removed 2026-10-28 |
| 5 | Image editing inside documents over the headless engine (crop and adjust) | Image edits round-trip from documents |
| 6 | Additional kits (`kit.pdf`, video, vector, audio), each built on the Kit SDK template | Each passes conformance, its SDK e2e, and the performance budget in [kit-sdk.md](kit-sdk.md) |

### 10.1 Trying `kit.photo` locally

```bash
# In the kition-photo repository (needs Rust 1.95 or newer)
cargo build -p kit-photo

# In this repository
KITION_KIT_PHOTO_BINARY="$HOME/<path-to>/kit-photo/target/debug/kit-photo" pnpm dev
```

Put a `.psd` file in the workspace and open it from the tree. Ask the agent to
edit it, for example "add a layer named Notes" or "brighten the background";
the tab refreshes after each edit. Without the variable the tab explains how
to install the kit.

The runtime crate `kition-kits` starts the kit on first use with the workspace
folder as its only root, opens a `host` connection for the tab and an `agent`
connection for agent tools, and stops the kit when the runtime restarts for
another workspace. `cargo test -p kition-kits` covers the routes against the
mock kit; `tests/photo.rs` runs against a real build when
`KITION_KIT_PHOTO_BINARY` and `KITION_KIT_PHOTO_FIXTURE` are set.

Ordinary PNG and JPEG files keep opening in Kition's own preview; they open in
`kit.photo` only when the user chooses to edit them there.

Superseded on 2026-10-10 and removed from the renderer on 2026-10-15: every
kit now draws its own editor in the page, and Kition ships every kit's
package inside the app; see [kit-sdk.md](kit-sdk.md). Editor feel (stroke
latency, scrolling, focus) must still be validated in the real desktop client.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream instability (alpha, high churn) | Scheduled sync pull requests gated by tests and conformance; additive Kition changes per section 7.2 |
| Large command catalogs overwhelm the agent | Tool groups and per-turn filtering |
| Kit crashes | Process isolation; the host restarts the kit and reopens documents from disk |
| Bundle size | Only built-in kits ship with Kition; others install on demand |
| Font licensing for bundled fonts | Review each font package before redistribution |
| Protocol drift between Kition and kit repositories | Decided 2026-10-10: kits do not link `kition-kit-protocol`; every kit release must pass the conformance suite built from this repository |
