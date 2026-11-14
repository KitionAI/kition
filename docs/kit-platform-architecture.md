# Kit Platform Architecture

Status: proposal, 2026-10-09; revised 2026-10-10 for the in-process Rust
runtime and for `kit.photo` as the first kit. Partly superseded: kits draw
their own editors in the page as WebAssembly packages, and Kition ships every
package inside the app (2026-10-15); native kit surfaces (section 6), the
signed kit index and per-platform downloads were removed (2026-10-28), so kit
processes run only headless and kits are pinned in `kits/kits.lock.json`.
Sections 1, 3.3, 5, 7, and 10.1 were rewritten to that model on 2026-10-31. See
[kits.md](kits.md).

Kition is a workspace for documents, data, media, and an AI agent that works
across all of them. This document defines how professional editors (images,
PDF, video, vector, CAD, and others) become **kits**: components built in their
own repositories that open inside Kition and that the Kition agent can drive.
A kit's engine is compiled to WebAssembly and runs in a Web Worker in the page;
the kit draws its own editor, which Kition shows in an iframe (`KitFrame`, Kit
UI protocol). A kit's native executable runs only `headless`, for the agent.

The wire contract is specified in the Kition kit platform (kition-sdk `docs/platform/reference/kit-process-protocol.md`) and the
machine-readable schemas live in [`contracts/kit/`](../contracts/kit/).

## 1. Goals

- Open professional file types (PSD, PDF, video projects, vector art, CAD
  drawings) inside the Kition window without blocking the page.
- Let the Kition agent operate every kit through one command model, the same
  way a person does through the UI.
- Ship every kit's package inside the app, self-contained so that other
  applications can embed it too (platform rule UI-K1).
- Reuse strong open-source engines without taking ownership of millions of
  lines of upstream code.

Non-goals for the first version:

- Third-party kit marketplace. Version 1 accepts first-party kits only.
- Building kit editors inside Kition: each kit draws its own editor.
- Showing a kit's native window over a Kition tab.

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

### 3.3 Kits as separate repositories behind protocols (chosen)

Each kit is built in its own repository and ships two artifacts over one
command model: a package for the page (the engine compiled to WebAssembly plus
the kit's own editor, spoken to over the Kit UI protocol) and a headless native
executable that speaks the Kit Protocol for the agent. Kition is the host. This
is the model of editor extensions with language servers: the host owns the
workspace, the shell, and the agent; each kit owns one editing domain.

## 4. Architecture

```text
+------------------------- Kition desktop process --------------------------+
| Renderer (React)                                                          |
|   workspace tree, tabs, agent panel                                       |
|   kit tab = the kit's own editor in an iframe (KitFrame, Kit UI protocol) |
|             engine compiled to WebAssembly in a Web Worker                |
|                 | loopback HTTP API                                       |
| Tauri shell (Rust) = Kit Host       | Runtime (Rust crates, in-process)   |
|   window, menus, updates            |   agent, data; starts headless      |
|                                     |   kits through                      |
|                                     |   kition-kit-host                   |
+-------------+-------------------------------------+-----------------------+
              | Kit Protocol (JSON-RPC 2.0, local socket or named pipe)
              v                                     v
     +-------------------+   +-------------------+
     | kition-photo      |   | kition-pdf        |  ...
     | (headless)        |   | (headless)        |
     | engine + server   |   | engine + server   |
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
| `kition-kit-process-protocol` | Message types mirroring `contracts/kit/`, error codes, launch constants, line framing, and the socket or named pipe transport. No async runtime unless the `tokio` feature is enabled, so thread-based kits can use it |
| `kition-kit-host` | Launching a kit with a private endpoint and token, waiting for `ready`, and a request client with timeouts and cancellation. Kits run only headless |
| `kition-kit-mock` | A headless kit for `.mocktext` documents, used to test the host and the suite |
| `kition-kit-conformance` | The conformance suite (protocol section 14), as a library and as the `kition-kit-conformance` command that kit repositories run in CI |

`cargo test -p kition-kit-mock` runs the suite against the mock kit, including
injected faults that each check must catch.

## 5. Shipped Kits

Kition ships sixteen kits, each pinned by version and checksum in
`kits/kits.lock.json`: Board, CAD, Cube, Design, Doc, Effect, Fig, Film, HTML,
Note, PDF, Photo, Sheet, Slide, Table, and Vector. Every kit is delivered the same
way:

| Part | Implementation | Delivery |
| --- | --- | --- |
| Editor | The kit's engine compiled to WebAssembly in a Web Worker, and its own editor in an iframe (`KitFrame`) | Ships inside the app (`public/kits/<kit>-ui/`) |
| Agent | The kit's tools, through the open editor (Kit AI bridge) or the kit's headless executable | Headless executables run only for the agent |

Kition has no editors of its own for these formats: Markdown notes, tables,
boards, and slides are kits like the others. Registration lives in
`src/features/workspace/components/kits/kitEditors.ts` and `kits/modules.json`;
see [kits.md](kits.md).

## 6. Surfaces: How A Kit Appears Inside Kition

> **Decision, 2026-10-10:** kit editors run in the page. The kit's engine is
> compiled to WebAssembly (its SDK), runs in a worker, and the kit draws its
> own editor in an iframe (`KitFrame`, Kit UI protocol). The `embedded`
> overlay window was prototyped for `kit.photo` and rejected in the real
> desktop client: it felt like a separate program, doubled the canvas, and
> added scroll bars. How to build a kit editor: [kits.md](kits.md).
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
forks. Kition does not send pull requests upstream and does not merge upstream
work (section 2).

- Each kit repository is `KitionAI/kition-<kit>`, with `main` as its only
  long-lived branch.
- A kit derived from an upstream project credits it only in the kit
  repository's `NOTICE`; neither the README nor `kit.json` names it.
- Kit packages are tagged `package-v<version>` when published (section 7.4).

### 7.2 Rules

1. **Protocols, not shared crates.** Kit repositories do not link the crates of
   this repository: each kit implements the Kit Protocol in its own server
   crate, and the conformance suite, which runs as a separate program, proves
   it matches.
2. **Credit upstream in the NOTICE.** A kit derived from an upstream project
   credits it only in the kit repository's `NOTICE`; no change ledger is kept.
3. **Product look through tokens.** The kit's editor uses Kition Tessera and the
   theme tokens the host sends over the Kit UI protocol, so it matches
   `docs/design.md`.
4. **Branding.** User-visible names, icons, and about screens show the Kition
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
  bindings/wasm/                 kition-<kit>-kit: the in-page engine (KitDocument)
  bindings/headless/             kition-<kit>: the agent's headless executable
  web/                           the kit's editor (Kit UI protocol)
  kit.json                       manifest (KHP)
  NOTICE, LICENSE                Apache-2.0 and upstream attribution
```

### 7.4 Build and publishing

Kit repositories run no builds in their own CI. A kit is published from a
developer machine with `scripts/publish-kit.sh <kit>` in this repository: it
builds the package from the kit's pushed `main`, uploads it to a
`package-v<version>` Release of the kit's repository, and pins it in
`kits/kits.lock.json`. Kition's release workflow fetches the pinned packages
and checks every engine against the kit engine contract
([kits.md](kits.md), section 4b). Headless executables pass the Kit
Protocol conformance suite:
`kition-kit-conformance --kit <executable> --manifest kit.json --fixture
<document> --edit-command <command> --edit-params '<json>'`.

## 8. Trust And Permissions

Headless kit executables run with the user's privileges. Version 1 therefore
accepts only first-party kits:

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
| 1 | `KitionAI/kition-photo` repository: `kition-kit-server`, `apps/kition-photo` with a `headless` backend over the upstream automation engine, `kition-theme`, branding | `headless` passes the conformance suite (reached 2026-10-10, 13 of 13 checks) |
| 2 | Runtime integration (`kition-kits`): the workspace lists `.psd`, `.psb`, and `.kphoto`; a Photo tab shows the rendered preview and layers with Undo, Redo, and Save; agent tools `photo_inspect`, `photo_commands`, `photo_run`; `/v1/kits` in `contracts/runtime/kits.schema.json`; `KITION_KIT_PHOTO_BINARY` override | Reached for `headless` on 2026-10-10: open, edit, and save a PSD from the workspace, and agent edits refresh the tab |
| 3a | In-page editing with `kit.photo` ([kits.md](kits.md)): `kition-photo-sdk` (WebAssembly) in a worker per file, `src/features/kits` template, exact damage repaint, saves through `PUT /v1/kits/files`, two-way sync with the agent | Reached 2026-10-10: checked in the real desktop client; a 4K PSD opens and saves with no main-thread long tasks |
| 3 (rejected) | Embedding with `kit.photo`: the kit hosts its full desktop editor in-process (`embedded` surface); the runtime (`kition-kits` surfaces) keeps the borderless editor window over the tab from the tab's rectangle and the window position the shell reports, and hides it with the tab, dialogs, or when another app takes focus. macOS first (`overlay-window`), then Windows (`child-window`) | Prototyped on macOS 2026-10-10 and rejected in the real desktop client; superseded by 3a; its code removed 2026-10-28 |
| 4 (dropped) | Distribution: downloaded native kits through a signed index | Superseded: kits ship inside the app, pinned in `kits/kits.lock.json`; the index, its schema and types were removed 2026-10-28 |
| 5 | Image editing inside documents over the headless engine (crop and adjust) | Image edits round-trip from documents |
| 6 | Additional kits (PDF, Film, Vector, and the rest of section 5), each built on the Kition SDK template | Each passes conformance, its SDK e2e, and the performance budget in [kits.md](kits.md) |

### 10.1 Running a headless kit from its repository

Kit editors come from the pinned packages; nothing needs installing. To let the
agent use a headless kit built from its repository, name the executable with
`KITION_KIT_<NAME>_BINARY`:

```bash
# In the kition-photo repository
cargo build -p kition-photo

# In this repository
KITION_KIT_PHOTO_BINARY="$HOME/<path-to>/kition-photo/target/debug/kition-photo" pnpm dev
```

The runtime crate `kition-kits` starts a headless kit on first use with the
workspace folder as its only root, opens an `agent` connection for agent tools,
and stops the kit when the runtime restarts for another workspace.
`cargo test -p kition-kits` covers the routes against the mock kit. Editor feel
(stroke latency, scrolling, focus) must still be validated in the real desktop
client.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Upstream instability (alpha, high churn) | Kition does not merge upstream; each kit is its own code, gated by its tests and conformance |
| Large command catalogs overwhelm the agent | Tool groups and per-turn filtering |
| Kit crashes | The engine runs in a worker and the editor in an iframe; a headless kit runs in its own process, and the host restarts it and reopens documents from disk |
| Bundle size | Per-kit performance budgets in [kits.md](kits.md) |
| Font licensing for bundled fonts | Review each font package before redistribution |
| Protocol drift between Kition and kit repositories | Decided 2026-10-10: kits do not link `kition-kit-process-protocol`; every kit release must pass the conformance suite built from this repository |
