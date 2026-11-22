# Kits: Editing Kit Files Inside Kition

Status: in use for all sixteen kits. Revised 2026-10-15: every kit draws its own
editor, and Kition's own kit editors are gone. Every new kit must follow this guide.

This guide is how Kition implements the **Kit Harness Protocol (KHP)** and
the Kition kit platform, which are normative. KHP (how an AI agent uses a
kit) is [`spec/`](https://github.com/kitharness/kitharness/tree/main/spec)
in the `kitharness/kitharness` repository (aligned with DeepSeek
Harness contracts); the platform (engines, the Kit Data Model, the Kit UI
protocol, embedding) is `docs/platform/` in the
`KitionAI/kition-sdk` repository (Apache-2.0), the SDK that implements both,
with its plan in `docs/roadmap.md` there. Where this guide and KHP or the
platform disagree, they win and this guide is fixed. Every kit ships a
`kit.json` manifest checked by kition-sdk's `tools/check-manifest.mjs`. Its
`khp` field is the KHP version the kit conforms to (`"khp": "1.0"`, no alias
for the old `standard` field), and `level` the KHP tier it claims (`basic`,
`agent-ready`, `agent-ready-complete`), with `agent.drafts`,
`agent.objectModel`, and `agent.layout` saying which tools it offers. The
platform rules and levels key off the platform fields (`engine.contract`,
`model`, `ui`), never off `khp`.

## 1. The Decision

A kit's editor runs **inside the Kition tab**. The kit's engine is compiled to
WebAssembly (its *SDK*) and runs in a Web Worker. The kit's own editor (React,
on kition-sdk's `@kition/kit-editor`, in the kit repository's `web/`) draws the
menus, panels, and canvas around it, and Kition shows that editor in an
iframe over the Kit UI protocol (section 4). The kit's engine and editor form
one **kit package**, which needs nothing from Kition, so other applications
can embed the same package (section 4b). Kition ships every kit's
package inside the app; there is no install step.

The kit's native executable still exists, but only `headless`: the runtime
starts it for the agent and for conversions. It never shows a window. For a
kit on the SDK the executable is the same `KitDocument` the page runs, served
over the Kit Protocol by kition-sdk's `kition-headless`, so it is a few lines
(`apps/kition-<kit>` in each kit repository). The agent's tools for every kit are
`<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run`, generated from
the kit's definition (`photo_*`, `film_*`, `vector_*`, `motion_*`,
`layout_*`, `cad_*`, `slide_*`, `doc_*`, `sheet_*`, `pdf_*`).

When the file is open in a kit editor, those tools act on the editor itself
through the **Kit AI bridge** (standard A7 to A10), not on a headless copy:
the person sees the edit at once, it joins the editor's undo history, and the
header says "Edited by the agent" until the person edits again. The renderer
holds one event stream per window (`GET /v1/kits/bridge`, one JSON-RPC
message per event: `kit/documents`, `kit/call`, `kit/preview`) and answers
with `POST /v1/kits/bridge?session=` (and sends `kit.changed`). `KitFrame`
forwards it to the kit's editor as `ai/*` (`kition/kitBridge.ts`; runtime
side `crates/kition-kits/src/bridge.rs`). With
no window open on the file, the agent uses the headless kit as before.

The same kit tools serve other harnesses as an MCP server: kition-sdk `crates/kition-kits`
(`tools.rs`, `mcp.rs`, copied here by `scripts/sync-kit-host.mjs`) with `POST /v1/mcp/kits` on
the running runtime (`crates/kition-kits-http`; Streamable HTTP, loopback, with the live bridge)
and the stdio `kition-kits-mcp --workspace <folder>` without Kition (headless kits;
`--list-kits` lists what it found, `--unified` serves one `kit_<action>` tool set). A kit is found
from its KHP manifest, never from a table: the kit packages' `kit.json` the desktop shell hands
the runtime (`public/kits/<kit>-ui/` in development), a `--kits-dir`, or the `kit.json` a headless
executable was built from (`--kit <path>`, and `KITION_KIT_<KIT>_BINARY` for development builds).
The tools' wording comes from the manifest's `agent.describe`, `agent.render`, and
`agent.export` (Kition platform K21).
DeepSeek Harness mounts them through its own `dsh-mcp-client` with kition-sdk's
`packages/dsh-kits` patches (standard D1); its `test/e2e.sh` proves it with a real dsh runtime.

Claude Code gets them as a plugin, kition-sdk `plugins/claude-code/kition-kits` (install with
`claude plugin marketplace add <kition-sdk>/plugins/claude-code`, then
`claude plugin install kition-kits@kition`): the stdio `kition-kits-mcp` on the project folder
(`--unified` by default: 10 tools, about 10K tokens of definitions for all 16 kits, against 129
tools and about 119K tokens per kit), one `<kit>-editing` skill per kit generated from the kit's
`agent/guide.md` (`node tools/claude-plugin-skills.mjs`, `--check` for drift), and the person's
draft review (`/kition-kits:drafts-list`, `-compare`, `-merge`, `-discard`; merge and discard only
the person starts). Its README covers the options, including serving kits from their repositories'
debug builds.

Every kit also gets two object-model tools (architecture section 13, `tools/model.rs`):
`<prefix>_query` reads objects by id (`root` for the document) or by following fields from the
root (`follow: "slides.0.shapes"`), and `<prefix>_batch` runs one `model/batch` (KitObjectModel
1.0) and saves unless `save: false`. Their argument schemas are generated from the kit's
`model.describe` once Kition has seen it (types and fields become enums; `describe: true` answers
the schema and its JSON Schema). Both go to the open editor's `model/*` (Kit UI protocol
section 7a) or to the headless kit's `model.describe`/`model.batch`, honour `draft` (a draft batch
needs the editor's `draft-model` capability and is refused otherwise, never run on the document)
and read-only documents. Every kit tool failure answers a structured error beside its message,
`{ code, message, index?, retryable? }`: the object model's `BatchErrorCode` (`invalid-op`,
`not-found`, `invalid-value`, `read-only`, `command-failed`) and `invalid-params`, `not-open`,
`draft-required`, `unknown-command`, `not-allowed`, `unsupported`, `unavailable`, `failed`. The MCP
server also serves documents as resources (`resources.rs`): `kit://<document>/describe` and
`kit://<document>/objects/<id>`, `<document>` the file's workspace path as one percent-encoded
segment, with `resources/list` (the documents open now) and `resources/templates/list`; no
subscriptions.

External agents' clients reach Kition's agent over the Agent Client Protocol (standard D3,
`crates/kition-acp`): an editor launches `kition-acp --url http://127.0.0.1:<port>/api/v1
--token-file <Kition data directory>/data/api-token --model-file <model.json>` as its ACP agent
(protocol version 1, stdio); the token file holds the running Kition's API token and must be
readable by the person's account only. It serves `initialize`,
`authenticate`, `session/new`, `session/prompt` (text, resource links, embedded text resources),
and `session/cancel`, projects each turn's stream (`session.event`, `agent/assistant-stream`) onto
`session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`), and asks
`session/request_permission` when a command needs approval, resuming the turn with the answer.
Not served: `session/load`, session modes, the client's file system and terminal methods, images
and audio in prompts, and the client's MCP servers. The model file is Kition's `RuntimeModel`
JSON, since the person's model settings live in Kition's window; keep it outside any repository.

When the agent edits a co-edited document through the bridge, the person's presence state carries
`agent: { name: "Agent", origin: "agent" }` until the agent has been quiet for 30 seconds
(`src/services/agentPresence.ts`, `features/collab/collabRelays.ts`), and every viewer's tab shows
the agent as a peer of its own (`PresenceAvatars`).

Rejected on 2026-10-10 after a real-app trial: embedding the kit's native
editor in an overlay window above the tab (`surface: embedded`, plan B). It
felt like a second program, showed two canvases and extra scroll bars, and
could not share Kition's menus, dialogs, or focus. Do not build new kits that
way. The renderer side of plan B (`PhotoKitPane`, `PhotoKitEditor`) was
removed on 2026-10-15; the runtime's `/v1/kits/surfaces`, the protocol's
native surfaces, and the desktop shell's window tracking on 2026-10-28.

Also removed on 2026-10-15: Kition's own editors on a kit's engine
(`<Kit>WebEditor`, `StandardKitEditor`, `KitEditorFrame`, `KitCanvas`), which
predated the kits' own editors, and the separate `public/kits/<kit>-sdk`
engine builds. Kition loads a kit's engine from its package
(`public/kits/<kit>-ui/engine/`) only to make new files.

## 2. The Pieces

```text
kit repository (for example KitionAI/kition-photo, standalone)
  crates/<engine crates>          the upstream engine, changed as needed
  (git dependency) kition-sdk     KitionAI/kition-sdk: KitDocument, export_kit_document!,
                                  testing::check_contract, host (lent files), raster
  crates/kition-<kit>-kit         the kit's SDK: its engine behind KitDocument, as WebAssembly
  web/                            the kit's own editor on @kition/kit-editor; with the engine,
                                  the kit package (web/scripts/build-engine.sh, pnpm build)
  apps/kition-<kit>               the headless Kit Protocol executable (agent)
  NOTICE                          credits the upstream project the kit derives from, if any

Kition (this repository)
  kits/modules.json                  every kit engine: crate, module, class, and its contract-check edit
  public/kits/<kit>-ui/           the kit package: editor, engine/, fonts/, kit-ui.json,
                                  model/schema.json (the KDM schema, when kit.json names one),
                                  agent/checks.json and agent/guide.md (KHP K17, when the kit has them)
                                  (not committed; scripts/build-kit-ui.sh <kit>, make kit-uis)
  src/features/kits/kition/       KitFrame (the kit's editor in an iframe), the workspace
                                  host, and the Kit AI bridge
  src/features/kits/engine/          loads a kit's engine in the page; Kition makes new files
                                  with it (createKitFile); imports nothing else from Kition
  src/features/workspace/components/kits/kitEditors.ts
                                  the registry: format -> kit package, engine, create menu item
  scripts/check-kit-module.mjs       checks a built engine against the contract (pnpm check:kit-modules)
  crates/kition-kits/             copied from kition-sdk: kits found from their kit.json,
                                  the KHP agent tools, drafts, grants, kition-kits-mcp
  crates/kition-kits-http/        Kition's /v1/kits routes, the bridge's stream, /v1/mcp/kits,
                                  PUT /v1/kits/files for in-page saves
  crates/kition-agent/src/tools/kits.rs
                                  the agent tools, which drive the headless kit
```

Data flow for one open file:

```text
file --KitHost.read--> KitEngine (page) --postMessage--> kitEngine.worker
  ^                        |                               |  SDK document
  |                        | info after every change       |  render, renderArea,
  |                        v                               |  execute, inspect,
  +---- KitHost.write <-- save() bytes <-------------------+  commands, save, invoke
```

In Kition, `KitHost` is `KITION_KIT_HOST`: it reads `/workspace-files/<path>`
and writes through `PUT /v1/kits/files`. The agent edits the same file through
the headless kit and saves it. The tab notices the new version on disk
(section 6).

## 3. The SDK Contract (Kit Side)

Each kit repository adds `bindings/wasm` (the `kition-<kit>-kit` crate) on top of the
`kition-sdk` crate, modelled on `bindings/wasm` in kition-photo:

```rust
use kition_kit::{KitCommand, KitDocument};

pub struct SketchDocument { /* the engine's session */ }

impl KitDocument for SketchDocument {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> { /* … */ }
    // create, width, height, revision, dirty, render, render_area,
    // execute, inspect, commands, save, mark_saved
}

kition_kit::export_kit_document!(SketchDocument as "SketchDocument");

#[test]
fn keeps_the_kit_sdk_contract() {
    kition_kit::testing::check_contract::<SketchDocument>(&fixture(), "fixture.sketch", |doc| {
        doc.execute("draw.line", serde_json::json!({ "from": [1, 1], "to": [20, 10] })).map(|_| ())
    })
    .unwrap();
}
```

- `crate-type = ["cdylib", "rlib"]`. The macro expands to nothing outside
  `wasm32`, so native `cargo test` needs no wasm-bindgen, and a kit never
  depends on wasm-bindgen itself. A kit's own extras (Photo's
  `selectionOutline`, Film's `audio` and `audioRate`) go in an
  `impl WebDocument` block (imported from `crate::__kition_kit_export`) with
  `#[wasm_bindgen(js_class = "<Class>", wasm_bindgen = kition_kit::wasm_bindgen)]`
  and `use kition_kit::wasm_bindgen::prelude::*`, and are reached from the
  page with `KitEngine.invoke`.
- No `unsafe`, no `unwrap`, `expect`, or `panic!`. Bad input returns an error
  (a `JsError` in JavaScript), never a panic, because a panic kills the worker.
- `examples/grid-kit` in kition-sdk is the smallest complete kit to copy. A
  kit does not depend on wasm-bindgen; the macro brings it.
- Engines that render whole frames (video, slides, pages) implement `render`
  and `render_area` with `kition_kit::raster` from one full-resolution frame;
  the results are contract-exact.
- Documents that name other files (a film project's media) read them with
  `kition_kit::host` (lent files, below).

The JavaScript class the macro generates (`KitModuleDocument` in
`src/features/kits/engine/kitModule.ts`):

| Member | Meaning |
| --- | --- |
| `static open(name, bytes)` | Opens file bytes; `name`'s extension picks the format |
| `static create(name, width, height)` | A new blank document (for New) |
| `static contractVersion()` | The contract the SDK implements (now 1); Kition refuses newer ones |
| `width`, `height` | Document size in document pixels |
| `revision` (`u64`, a `bigint` in JS) | Moves with every change |
| `dirty` | Unsaved changes exist |
| `render(x, y, scale, width, height)` | RGBA8, straight alpha, of the area at (`x`, `y`) shown at `scale` screen pixels per document pixel. Below 1 it averages; above 1 it repeats exact pixels |
| `renderArea(x0, y0, x1, y1, width, height)` | RGBA8 of exactly that integer area averaged to exactly that size. When the area is k times the size, every output pixel must be the exact k × k box average (the canvas relies on it for seamless patches) |
| `execute(command, paramsJson)` | Runs an engine command, returns its JSON result; unknown commands and bad parameters are errors |
| `inspect()` | The document as JSON; must include `canUndo` and `canRedo`; the rest is the kit's own |
| `commands()` | JSON array of `{ id, title, menu: string[] \| null, shortcut, params, mutates, enabled }`. Kition builds the menus from `menu` and binds `shortcut` |
| `save(name?)` | The document as file bytes. It must **not** mark the document saved |
| `markSaved()` | Marks the last `save` as written. Kition calls it only after the file reached the disk |
| `free()` | Releases the document |

Commands must include `edit.undo` and `edit.redo`; the shared frame's Undo and
Redo call them. They work in an undo scope (engine contract 2 E14a,
`KitModel 1.1` M12a): the one their optional `scope` parameter names
(`"person"` or `"agent"`), else the scope of the origin they run as. Kition's
agent runs its kit steps as origin `agent`, and its kit tools send every
`edit.undo` and `edit.redo` step with `{"scope":"agent"}`
(`crates/kition-kits/src/tools.rs`), so the agent's undo or revert takes back
only its own steps, never the person's. Shortcuts are written `Cmd+Shift+Z`,
`Alt+Backspace`, `F12`; `Cmd` means Control off macOS.

Prove the contract twice: `check_contract` in the kit's Rust tests, and the
built WebAssembly with `node scripts/check-kit-module.mjs --kit <kit>` after an
entry in `kits/modules.json`. `pnpm check:kit-modules` checks every built kit. A
third party checks any SDK with `--dir`, `--module`, `--class`, `--name`, and
`--edit`. A text format (`"text": true`, the Note kit's Markdown) has no bad
bytes: every byte sequence is a file of it, so the check opens any bytes
without a crash instead of expecting random bytes to be refused.

The kit package's build (`scripts/build-kit-ui.sh <kit>`, through the kit's
`web/scripts/build-engine.sh`) builds the engine into `engine/`. It needs
`wasm-pack` and a Rust toolchain new enough for the kit; kition-photo needs 1.95,
and the script handles macOS `rust-lld`'s library path. The output, about
20 MB for Photo, is not committed.

Lent files: `kition_kit::host::{size, read_range, read}` are synchronous.
Kition's worker answers them (`src/features/kits/engine/lentFiles.ts`) with
ranged XMLHttpRequests against the workspace file server, cached in 1 MiB
chunks (256 MiB budget). Paths resolve against the document's folder, a
leading `/` means the workspace root, and nothing resolves above the root.
`KitHost.lend(path)` says where; `KITION_KIT_HOST` lends the workspace. The
runtime's CORS allows `Range` and exposes `ETag` and `Content-Range` for it.
Projects should name media relative to themselves (`../clips/a.mp4`) so they
stay portable.

The headless executable must also reload a document from disk when the file
changed since it read it and nothing is unsaved there. Otherwise the agent
edits a stale copy and its save overwrites the person's work. See
`PhotoHeadless::open` and `file_times` in kition-photo.

## 4. Kits In Kition (Standard 6.1)

A kit draws its own editor: the kit repository's `web/` app (React, on
kition-sdk's `@kition/kit-editor`) holds the ribbon, panels, canvas, and dialogs
next to the engine, and Kition shows it in an iframe and talks to it over the
Kit UI protocol (`kition-kit-ui/1`, kition-sdk `docs/platform/reference/ui-protocol.md`). Kition
keeps the shell: files, the workspace, the agent, the theme, the language, and
its own shortcuts.

All ten kits draw on kit-editor's `EditorFrame`: a top bar with the kit's tabs
(File, Home, Insert, …, or a ported app's menus) and the document actions,
then the person's display mode: Menus (tabs open as drop-down menus or a
drop-down ribbon panel), Single line (one row of the tab's main commands),
Classic (the full ribbon), or Focus (no chrome but a floating bar, Cmd+\).
kit-editor keeps the choice per kit, steps down when the window is too narrow, and
sizes for touch. Photo, Vector, Film, Motion, and CAD default to Menus; Doc,
Sheet, Slide, PDF, and Layout to Single line (`kit.json` `ui.display`). Canvas
kits pass a tool rail of flyout slots; side panels sit right of the body. A
kit declares its tabs as `{ id, label, view?, ribbon?, menu? }`
(`catalogTabs` and `commandMenuTabs` build menu tabs) and marks Single line
items with `primary`.

- `scripts/build-kit-ui.sh <kit>` builds the kit's engine and editor into
  `public/kits/<kit>-ui/` with a `kit-ui.json` marker (`make kit-ui-<kit>`;
  `make kit-uis` for all of `KIT_UIS`). The package keeps its own fonts and
  assets (UI-K1), so it stays embeddable without Kition, and its licence
  texts: the kit's `LICENSE` and `NOTICE`, and `THIRD_PARTY_NOTICES.txt`
  with the licence and notice files of every npm package the editor's Vite
  build bundled (`scripts/build-kit-editor.mjs` records them, so the kit's
  `build` script must stay `tsc --noEmit && vite build`) and every crate its
  engine links for wasm32 (`scripts/kit-package-notices.mjs`). The build fails
  when one of them ships no licence text. A kit whose
  `kit.json` names `model.schema` (K12) ships that file as
  `model/schema.json`: the schema its engine was built with. `@kition/embed`
  reads it for draft review and the agent's object-model calls, and
  `@kition/script`'s `openKitPackage` opens documents with it, before the
  schemas bundled in `@kition/script/kits`. The kit's `agent/checks.json` (its
  check catalogue) and `agent/guide.md` (its guide for models) travel the
  same way (KHP K17). A local build warns when the kit's `level` claims
  Agent-ready without them, and the kit's Package workflow refuses to publish
  it. kition-sdk's
  `packages/script/scripts/sync-kits.mjs` regenerates those bundled kits from
  the packages pinned in `kits/kits.lock.json`, and `--check` reports drift.
- Release builds use the published packages pinned in `kits/kits.lock.json`
  instead (section 4b); `make kit-fetch` puts the same ones in a development
  checkout.
- `src/features/kits/kition/KitFrame.tsx` mounts a package: the document's
  bytes, Kition's theme tokens and language, `host/read` and `host/write`
  through the workspace file API, paths confined to the workspace, a save
  (`host/write` in save mode) only of the frame's own document, new files
  and exports under unused names (a rendered movie arrives as `host/write` in
  export mode), `host/pick` (the person chooses a file, which Kition copies
  next to the document), `links/pick` (Kit UI protocol, capability
  `links-pick`: the person chooses existing workspace files in Kition's
  picker in link mode, which lists only visible files of the request's
  `accept`, never the document, and offers no import; nothing is copied, and
  the kit gets each file's path relative to its document's folder; not
  offered to a preview or a read-only document), Kition's shortcuts forwarded back (`HOST_SHORTCUTS`:
  Cmd+. opens the command palette from inside a kit, whose own Cmd+K stays
  the kit's), and the Kit AI
  bridge forwarded to the frame as `ai/*`. Kition also answers `host/generate`
  with the person's models (`kitGenerate.ts`, `POST /v1/ai/generate`,
  `contracts/runtime/ai-generate.schema.json`) for the defined purposes of
  Kit UI protocol section 7j, `ai-field` and `rewrite` (the runtime
  puts its own rewrite instructions before the kit's prompt). It refuses a
  kit's own purposes (`<kit>.<name>`) as `not-allowed`, because Kition has no
  generic handling for them, and `mountKit` refuses any other string
  (UI-G4). It answers `host/action` with its
  own actions (`kitActions.ts`: `settings.open`, which opens Settings where
  the person sets up AI); none is offered to a preview or a read-only
  document. Links (KitLinks 1.0
  section 5): `host/open` opens the workspace file a link names in a tab
  (`kitLinks.ts`: a path from the document's folder, or a bare name resolved
  to the nearest file of that name), at the link's view, and creates a
  missing one with the engine of a kit that creates its extension when the
  kit asks (`create`), else `not-found` or `no-kit`; `host/openUrl` opens an
  `https:`, `http:`, or `mailto:` address in the system's browser after the
  person confirmed it in a dialog that names the site, with its ASCII form
  for a non-ASCII host name (`KitOpenUrlDialog.tsx`, OP8). Neither is
  offered to a preview. A change of the frame's file on disk (the desktop
  watcher) reaches the kit at once as `document/fileChanged` with the file's
  new stamp (`kitFileChanges.ts`). It mounts on the protocol's `ready`
  handshake, never the frame's `load` event, and abandons a mount its effect
  no longer needs.
- Writes go through `PUT /v1/kits/files`, and the runtime keeps the same
  rule: a save names the document its editor opened (`document`) and
  replaces only that file; any other write makes a new file and never
  replaces one. So one kit's editor cannot overwrite another file, of its own
  kind or of another kit.
- What a kit reads: `host/read` and `host/stamp` answer its own document
  (through `/workspace-files/`, wherever it is) and any other workspace file
  whose path has no hidden segment, through `/kit-files/`: the files beside
  the document and those its links name in other folders (film and motion
  clips, linked pictures, the files a kit linked with `links/pick`, such as
  a design's library files). Engines read lent files under the same
  `/kit-files/` root, given to them as a URL signed for that folder only
  (below). The runtime refuses every hidden path there, Kition's
  own store `.kition/` (other documents' replicas and comment threads) among
  them, and links that lead into one or out of the workspace (rule LR2 of the
  host-capabilities proposal). `/workspace-files/` stays Kition's own.
- The runtime answers only callers holding this launch's API token
  (kit frame isolation, phase 1; `contracts/runtime/transport.schema.json`),
  because it can run commands as the person (desktop hooks). The desktop
  shell makes the token at launch and gives it to the main frame's bootstrap
  script only; `src/services/runtimeAuth.ts` takes it off `window` as the
  renderer loads and sends it as `Kition-Token` on every runtime request.
  URLs that carry no header (`<img>`, `EventSource`, a kit engine's lent
  root) are signed with it for one file or one folder and expire; a kit is
  never given the token. Requests without it get `401` before routing, so
  they change nothing; other origins, other `localhost` pages among them, get
  `403`. Trusted local clients (`kition-acp --token-file`) read it from
  `data/api-token` in Kition's data directory, which only the person's
  account can read. Residual until phase 2 (per-kit origins, CSP, sandbox):
  a kit frame is still same-origin with Kition's page, so a hostile kit page
  can reach the page's own requests through `window.parent` (for example by
  wrapping its `fetch`) and act with the token. Phase 1 closes the local API
  to everything that is not Kition's page: other accounts, other pages in
  the browser, and kits once they leave Kition's origin.
- Files beyond the document (KitFiles 1.0) go through file handles the
  runtime mints and keeps, under `/v1/kits/grants`
  (`crates/kition-kits/src/grants.rs`): a grant session per editor page,
  bound to its kit, the person, and its document, with the kit manifest's
  `files` lists (K15); handles (`fh_…`) bound to their session with `read`,
  `create`, or `write`; ranged reads; staged writes that commit atomically,
  where a `create` never replaces a file and a `write` needs the version it
  replaces; releases; and a grant log per session. Paths stay in the
  runtime, confined like `/kit-files/`. `KitFrame` serving the kit's
  `files/*` requests from them is the next step.
- A document this person may only view (a view-only share link, a `viewer`
  role) opens with `document.readOnly`. kit-editor's engine worker then refuses
  every edit (reason `read-only`) by its exported `READ_ONLY_RULES`, and the
  editor shows View only instead of Undo, Redo, and Save; a kit's own panels
  read it with `useReadOnly()`. When the role changes, `KitFrame` opens the
  kit again in a new iframe, since a kit page answers one handshake.
- `KIT_EDITORS` in `src/features/workspace/components/kits/kitEditors.ts` maps a format to its kit package.
  `KitFilePane` shows the package when its `kit-ui.json` is present. A
  development build without the package shows the file preview for formats
  the preview shows (`preview: true`: PDF and Office), or a short notice.
- New files (the create menu, Film's "Edit in Film") are made in the page by
  the engine inside the package (`createKitFile`, the `engine` manifest of the
  entry), under an unused name, written through the host.
- The Kit UI protocol's host side (`mountKit`, KitFiles) comes from the npm
  package `@kition/sdk` (`@kition/sdk/host`, `@kition/sdk/protocol`), as do
  the Kit Data Model (`@kition/sdk/kdm`), the sync client
  (`@kition/sdk/sync`), the object model (`@kition/sdk/script`) and the
  extension host (`@kition/sdk/extensions`). `node scripts/sync-kit-host.mjs`
  copies from a kition-sdk checkout what no npm package ships, and
  `pnpm check:kit-host` fails when those copies drift: kition-sdk's `kit.json`
  schema into `contracts/kit/kit.schema.json`, which the conformance suite
  checks manifests against, the other schemas of `contracts/kit/`, the
  Rust crates (`crates/kition-kdm`, the Kit Process Protocol's host side and
  `kition-kits`), and the example extension the end-to-end tests install
  (`e2e/fixtures/extensions/title-case/`).
- Extensions and scripts (`KitExtensions 1.0`) work on open kit documents
  through the object model (`KitObjectModel 1.0`): `@kition/sdk/script` (the
  object model) and `@kition/sdk/extensions` (the extension host; its built
  worker runtime is `@kition/sdk/extensions/runtime`), which share the page's
  one Loro and one KDM with `@kition/sdk/kdm` and `/sync`. The sandbox and
  panel pages (`@kition/sdk/extensions/sandbox.html` and `/panel.html`) are
  copied into `public/extensions/` (git-ignored) by `tooling/vite.config.ts`
  when the development server or a build starts, so the dev server, the
  end-to-end tests, the web build and the desktop bundle serve the installed
  package's pages. Settings >
  Extensions installs an extension from a workspace folder (with
  `extension.json`, one ES module, and its panels' HTML) or a zip of it into
  the app's own storage; its commands show in the command palette for the kit
  document shown now, next to "Run script", which runs a workspace `.mjs`
  file whose default export takes the same `ctx`. Each extension and script
  runs in a worker inside a `sandbox="allow-scripts"` frame on an opaque
  origin, reaches the network only at the origins it declares, and changes
  the document only with `model.write`. An extension's panels show in the
  palette too ("Show panel: …"); one opens as a side panel to the right of
  the kit's editor (`ExtensionPanelSlot` in `KitFilePane`), in a visible
  frame of the same kind with the extension's network origins, Kition's
  theme tokens, and a channel to the extension's worker; Kition's
  `frame-src` keeps it on its page. `@kition/sdk/script/kits` registers the schema
  of every kit with an object model (Doc, Slide, Sheet, Photo, Vector,
  Motion, CAD, PDF, Table, Film, Board, Note, Scene, Design), generated in kition-sdk from each kit's
  `model/schema.json` at its pinned commit. `e2e/extensions.spec.ts`
  installs the example extension, runs its command and its panel, and runs
  scripts on Slide, Doc, Sheet, and Design documents. Kition sends the
  registered schema with the agent's object-model calls to an open editor
  (`kitBridgeModel.ts`) and with draft review, since kit-editor answers the
  object model of an engine that does not describe its own schema only with
  one.
- A kit's development host (`web/dev.html`, kition-sdk's `@kition/kit-dev-host`)
  runs the editor without Kition, with an in-memory workspace; it can lend a
  folder of linked media. It is also the reference for other hosts.
- `e2e/<kit>-embedded.spec.ts` opens a file in each kit's editor through
  `e2e/helpers/embeddedKit.ts`, and `kit-bridge.spec.ts` drives the agent
  bridge against it. They make fixtures with the package's engine in Node and
  skip themselves when the package is not built.
- Web engines embed no Chinese face; kits that draw text export `addFont`
  (standard E9), and their editors ship Droid Sans Fallback from the
  `kition-fonts` checkout next to the kit (`web/scripts/build-engine.sh`).
  Never Noto CJK or Source Han: the kits' asset rules forbid them.

### The Table kit

`kit.table` (`KitionAI/kition-table`, package `public/kits/table-ui`) is a
normal kit: `.ktable` files open in its own editor in `KitFrame`, and its
engine and editor live in its repository. Kition has no table engine or
table editor of its own. Kition's host features (the scenario builder, the
workspace tree) read and write tables through
the host table client, `crates/kition-tableclient`: through the Kit AI bridge
when an editor has the file open, so the edit arrives live, and through the
headless `kition-table` otherwise. Its writes carry a `system:<feature>` origin
and never join the person's undo. The renderer reaches it through `/v1/kit-tables*`
(`contracts/runtime/kit-tables.schema.json`, `src/api/kitTables.ts`), and
host features name a table by its file path (`documentPath`) and table id. The
renderer reports a rename or move (`/v1/kit-tables/renamed`) and a delete
(`/v1/kit-tables/deleted`), so the client reads the file again at its new path
or forgets it. An expanded table file in the
workspace tree lists its tables and dashboards, read through the kit
(`/v1/kit-tables?path=`); a click opens the file in the kit at that one with
the Kit UI view `{ "path": "tables/<id>" }` or `{ "path": "dashboards/<id>" }`
(`document.view` for a new editor, `document/reveal` for an open one;
`revealInKit` in `src/features/kits/kition/kitViews.ts`). `pnpm test:ktable:e2e`
(`e2e/table-kit.spec.ts`) covers what Kition adds around the kit; the
editor's own behavior is tested in the kit's repository.

### The HTML kit

`kit.html` (`KitionAI/kition-html`, package `public/kits/html-ui`) edits `.html`
and `.htm` source with an HTML/CSS/JavaScript Rust/WASM preview. New > HTML creates
`Untitled HTML.html` through the Worker engine and the kit file API. Its source
editor and diagnostics live in the kit repository; Kition hosts it in `KitFrame`.
JavaScript runs in the shared Boa engine with DOM events, timers, and supplied
script/module resources. Preview clicks preserve live state; saves retain source
HTML. Missing resources and script errors are reported. Canvas 2D supports
paths, images, and solid text; selected option labels and live form values also
render. Shadow DOM, select popups, preview keyboard input, and complete browser
API compatibility remain unsupported. The Chrome comparison corpus documents
incomplete CSS/rendering fidelity.

Build locally with `scripts/build-kit-ui.sh html`; `make kit-dev` includes its
headless executable for the `html_*` agent tools. `e2e/html-embedded.spec.ts`
covers creation, editing, host saves, reopening, `.HTM`, resource isolation,
large source files, disk conflicts, read-only sessions, timers, preview clicks,
Canvas images/text, selected options, and event cancellation in Chromium and WebKit.
The SDK registry marks HTML optional until its first package is published and
pinned. It uses engine contract 1; no KDM collaboration or agent drafts are
claimed. The editor uses the shared session's file-change and read-only rules.

### The Board kit

`kit.board` (`KitionAI/kition-board`, package `public/kits/board-ui`) is a
normal kit: `.kboard` files open in its own editor in `KitFrame`, and its Rust
engine (`kition_board_kit`, `BoardDocument`) and editor live in its
repository, published and pinned like every other kit. The create menu's Board
item makes an empty board with the engine in the page, and the agent's
`board_*` tools run on the headless `kition-board` for files no editor has open
(found from its `kit.json`). `e2e/board-embedded.spec.ts` (in
`make kit-e2e`) covers what Kition adds around the kit: opening, drawing,
saving through Kition, and creating a board; the editor's own behavior is
tested in the kit's repository. Kition has no board editor of its own.

### The Scene kit

`kit.scene` (`KitionAI/kition-scene`, package `public/kits/scene-ui`) is the
3D kit: `.kscene` files (a ZIP of the scene as JSON and each mesh as a binary
buffer) open in its own editor in `KitFrame`. Its Rust engine
(`kition_scene_kit`, `SceneDocument`) renders the viewport in software in the
worker; the document's size is the editor's viewport (`view.resize`), and the
view, shading, and selection are session state that never makes the file
dirty. It exports glTF/GLB, OBJ, STL, and PNG renders, and places glTF, OBJ,
and STL files into a scene. The create menu's Scene item makes the starter
scene (a cube, a light, and a camera) with the engine in the page, and the
agent's `scene_*` tools run on the headless `kition-scene`, with rotations in
degrees and Z up. Its features and defaults are checked against Blender as a
reference application only (the kit is a clean-room Apache-2.0
implementation). `e2e/scene-embedded.spec.ts` (in `make kit-e2e`) covers opening,
editing, saving, and creating a scene through Kition.

### The Design kit

`kit.design` (`KitionAI/kition-design`, package `public/kits/design-ui`) is the
interface design and prototyping kit: `.kdesign` files open in its own editor in
`KitFrame`, on its Rust engine (`kition_design_kit`, `DesignDocument`) in the
worker. The engine also imports `.fig` and `.sketch` files; Kition opens only
`.kdesign` in the kit. The create menu's Design item makes `Untitled design.kdesign`
(one 1440 x 1024 frame) with the engine in the page, and the agent's `design_*`
tools run on the headless `kition-design` (`view.describe`, `document.check`, and
the object model's `model.*`). Design is on engine contract 2: a design is a
KDM replica of schema `kit.design` v2 (kition-design `docs/kdm.md`; v2 adds the
libraries a design uses, `Library` objects in `Design.libraries`), carried inside
the `.kdesign` file under `kdm/`, so people co-edit a shared design and the
editor lists the `replica` capability (its replica also goes to Kition's
store, below). Its object model (namespace `Design`, registered in
`@kition/sdk/script/kits/design`) serves `design_query` and `design_batch`, in the open
editor through the Kit AI bridge and headless; workspace scripts use it too.
Design claims no agent drafts. Through the headless kit a batch's model
operations reach the engine as a collaborator's changes (kition-sdk
`session::model::Exchange`), so the agent's undo takes back its commands but
not those. `e2e/design-embedded.spec.ts` (in `make kit-e2e`) covers opening,
editing, saving, and creating a design through Kition, and
`e2e/collab-design.spec.ts` (in `pnpm test:collab:e2e`) co-editing, the
agent's object model in the open editor, and undo by scope. A design uses team
libraries from other `.kdesign` files: "Add library file…" asks Kition for a
file to link (`links/pick`), the design names it relative to its folder
(`../libraries/Design System.kdesign`), and the editor reads it and watches
its stamp through `host/read` and `host/stamp`, so a library published again
on disk shows as an update to accept; `e2e/design-embedded.spec.ts` covers
that flow, and `sdk_kits.rs` reads a design's libraries headless. Build it locally
with `scripts/build-kit-ui.sh design`; the SDK registry marks Design optional until
its first package is published and pinned.

### The Note kit

`kit.note` (`KitionAI/kition-note`, package `public/kits/note-ui`) is a
normal kit: `.md` and `.markdown` files open in its own editor in `KitFrame`,
and its Rust engine (`kition_note_kit`, `NoteDocument`) and editor live in
its repository, published and pinned like every other kit. As in Word, the
engine lays the note out, draws it on the canvas (a live preview: Markdown
shows on the caret's lines, tables as grids, pictures in place), and edits it
through its `text` tool; the editor is kit-editor's frame around that canvas, with
the table controls, panels, and find bar over engine commands, and a visually
hidden copy of the text for assistive technology (`note-text`, which specs
read too). Kition has no Markdown editor of its own: the editor, its display
modes, comments, export, and image paste are the kit's. The `markdown` format id is unchanged, so
`KIT_EDITORS` finds the kit by it. What Kition keeps around notes are host
features that go through the kit:

- The agent changes a note only with `note_run` (find its commands with
  `note_commands`): through the Kit AI bridge when an editor has the file
  open, and through the headless `kition-note` otherwise (found from its
  `kit.json`). Its edits to an existing note arrive as a draft,
  reviewed in `KitDraftReview` or `HeadlessDraftReview`. `document_write` and
  `apply_patch` refuse a note; `document_read`, `document_search`, and
  `document_list` read it as plain text.
- Creating a note from a template is a create-menu feature
  (`src/features/workspace/templates/`); the onboarding guides are ordinary
  `.md` files the kit opens.
- Search, the workspace tree, renames, bookmarks, recent files, and pinned
  tabs are workspace features and do not depend on the kit.

`e2e/note-embedded.spec.ts`, `e2e/note-history.spec.ts`,
`e2e/collab-note.spec.ts`, and `e2e/note-table-widget.spec.ts` (the table
gate, `pnpm test:table:e2e`: the grid, the append buttons on the edge rails,
the column menu, cell editing, and undo, each checked in the saved file) cover
what Kition adds around the kit; they place the caret the way a person can on
a canvas (Find, then the arrow keys) and read the text from `note-text`
(`e2e/helpers/noteKit.ts`). The editor's own behavior is tested in the kit's
repository.

### The replica store

A kit that declares the `replica` capability keeps its replica for a file in
Kition's store, `.kition/docs/` under the workspace root, through the Kit UI
protocol's `replicaRead` and `replicaWrite`. The store
(`src-tauri/src/workspace/docstore/`, whose module comments are the
reference) maps workspace paths to document ids (`index.json`), so a replica
follows its file through a rename in the tree. It keeps each replica as a
snapshot plus append-only changes and a manifest that names every file with
its hash, so a crash reads as a stored version. Its `history.json` is the
version history on this device, which `src/features/history/` shows and
restores. Only the Kition holding `store.lock` writes; another Kition reads
the store and says why it does not write. The store is local and stays out of
Git (its own `.gitignore`): losing it loses history, never text, since the
workspace file is the document. The Note kit's model of a `.md` file
(schema `kit.note`, line endings, comments, identity, and merging a file
changed on disk) is in kition-note's `docs/design.md`, section 2.

## 4b. Kit Packages And npm

Kition ships every kit's package inside the app (decided 2026-10-15). All ten
packages add about 57 MB compressed; the renderer is embedded in the
executable with brotli, so the installer and the installed app grow by about
that much, and every app update downloads it again.

A kit package is also the kit's SDK deliverable: the same `<kit>-ui` folder is
what another application embeds. A web page embeds it with kition-sdk's
`@kition/embed` (`KitionEmbed.mount`, capability set `KitEmbed 1.0`; see
kition-sdk's `docs/platform/reference/embed.md`): the page serves the extracted package from an
origin of its own, keeps documents in its own storage, and may co-edit them
through a sync server. Kition consumes the package the way any other host
would, through `@kition/sdk/host`, so it never builds kits in its release.

Kit versions are distributed as npm packages, so they download from npm's
mirrors (registry.npmmirror.com) where GitHub is slow or unreachable. The
names and contents are kition-sdk's contract (`tools/kit-npm.mjs`); per kit
version (`version` in the kit's kit.json):

| Package | Holds |
| --- | --- |
| `@kition/kit-<kit>-ui` (in another scope `<scope>/<kit>`) | the folder `<kit>-ui/`: the kit's package (editor, engine, fonts), which Kition ships in `public/kits/` |
| `@kition/kit-<kit>-<platform>` (`<scope>/<kit>-<platform>`) | `kit.json` and the headless executable `kition-<kit>` (`.exe` on Windows) at the package's top, for darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-x64 (npm `os`, `cpu`, and `libc` on Linux) |

Each package.json has a `kition` field (`kit`, `id`, `name`, `version`,
`role` `ui` or `headless`, `platform`, `protocol`, `extensions`, `views`, and
`build`: the kit, kition-sdk, kition-tessera and kition-fonts commits it was
built from). A version is published once and never replaced; its integrity
is npm's `dist.integrity` (SHA-512 of the tarball).

- **Publishing** runs on GitHub, never on a developer machine. Each kit
  repository has a Package workflow (`.github/workflows/package.yml`, started
  by hand with `gh workflow run package.yml -R KitionAI/kition-<kit>`) that
  calls Kition's reusable `.github/workflows/kit-package.yml` with the kit's
  name and the repository's `NPM_TOKEN` secret, and grants it
  `id-token: write` for npm provenance. Every package of a version is built
  from the commit the run was started on.
- **The plan**: the `plan` job reads `version` from kit.json at that commit,
  asks https://registry.npmjs.org which of that version's six packages it
  lacks (kition-sdk's `tools/kit-npm-package.mjs missing`), and plans to build
  only those (`node scripts/kit-package-build.mjs plan`). When npm has every
  package, nothing is built. A version is one build: when npm has some of its
  packages and lacks others, the ones it has must name the run's commit in
  `kition.build.commit`, or the run stops before building anything (re-run
  the run that published them, or bump the version).
- **The package**, when npm lacks `@kition/kit-<kit>-ui`: the `package` job
  checks out the run's commit beside Kition, kition-sdk, kition-tessera and
  kition-fonts (main), and runs `scripts/package-kit.sh <kit> <out-dir>`: it
  builds the package with `scripts/build-kit-ui.sh` (machine paths in the
  engine remapped), refuses a `level` its agent files do not back, and writes
  and packs the npm package with kition-sdk's `tools/kit-npm-package.mjs ui`
  and `pack` (the `<kit>-ui` folder without the local-build stamp, and the four
  commits in `kition.build`; `pack` checks the tarball holds exactly the
  folder's files).
- **The headless executables**, for each platform npm lacks: the `headless`
  jobs build `kition-<kit>` (`cargo build --locked --release -p kition-<kit>`)
  exactly as kition-sdk's release builds its published kits' executables (its
  `.github/workflows/release.yml`, job `executables`): the same runners and
  targets, Linux linked against the glibc 2.17 floor with cargo-zigbuild and
  checked with kition-sdk's `tools/glibc-floor.mjs`, the fonts of the kit's
  `scripts/fetch-fonts.sh` when it has one (`KITION_FONTS_DIR`,
  `KITION_FONTS_REQUIRED=1`), else kition-fonts beside the kit. On its own
  platform the executable must answer `kit.initialize` (kition-sdk's
  `tools/kit-handshake.mjs --record`) with its kit.json's id, version and
  protocol (`node scripts/kit-package-build.mjs check`) before kition-sdk's
  `tools/kit-npm-package.mjs headless` writes its package folder. The folder
  travels to the publish job as a tar, which keeps the executable's mode, and
  is packed there, on Linux (kition-sdk's `pack` runs npm, which it cannot
  start on Windows). A platform that fails does not stop the others.
- **Publishing**: the `publish` job packs the headless folders, checks that
  every tarball is a package this run planned
  (`node scripts/kit-package-build.mjs publish-plan`), and asks the registry
  about each (`tools/kit-npm-package.mjs state`): a version npm holds with
  other bytes stops the run before anything is published. Then it publishes
  every package without waiting: `publish` runs
  `npm publish --access public --provenance`, `published` (npm has the same
  bytes) skips it, and npm refusing a version it already holds (an earlier
  run published it, not shown yet) counts as published. Only then does it
  wait (`node scripts/kit-package-build.mjs wait`): every 30 seconds, for at
  most 40 minutes (`VISIBLE_WAIT_MINUTES`), until npm shows every package
  with its bytes, the metadata of that exact version and its tarball. npm
  shows a new package name's first version only minutes later (until then
  its placeholder `0.0.0-stage`; up to 24 minutes for an editor package). At
  the limit the job fails naming the packages not shown yet: they were
  published, and re-running the job publishes nothing again, it only waits
  and checks their bytes. The job summary lists each package as already
  there, or published and when npm showed it. Nothing is published unless
  every package the plan wanted was built: a failed platform or package job
  skips the `publish` job, so a build failure never leaves a version half
  published. Running Package again, or re-running the run's failed jobs,
  builds only what npm does not show and publishes only what npm still
  lacks, which also completes a version npm stopped partway through
  publishing. After a wait that timed out, re-run the failed `publish` job
  rather than Package: Package builds again each package npm does not show
  yet, and when that build's bytes differ from the published ones the wait
  stops with an error (npm keeps the first; nothing is replaced).
- **Another npm scope**: the reusable workflow's `scope` input (default
  `@kition`) is exported as `KITION_NPM_SCOPE`, which kition-sdk's tools and
  `scripts/lib/kitNpm.mjs` read. Any scope but `@kition` (a rehearsal on
  `@kitionstage`) names the packages by layout 1, `<scope>/<kit>` and
  `<scope>/<kit>-<platform>`, publishes with the secret `NPM_TOKEN_STAGE`, and
  asks npmmirror for no copy; pinning and fetching with that variable set read
  that scope's packages.
- **Pinning**: `node scripts/pin-kits.mjs <kit>[@<version>]...` (or `--all`)
  reads the registry's metadata of the kit's editor package in the scope
  `KITION_NPM_SCOPE` names (default `@kition`) at that version, or its
  `latest`, and of its headless package for every platform npm has at that
  version (each must name the editor's commit), downloads each tarball once
  to check it has npm's integrity and to record its size, and writes the
  kit's npm pin into `kits/kits.lock.json`. A platform npm lacks is named and
  left out; a registry that cannot be asked about a platform fails the pin.
  `--dry-run` prints the entries and writes nothing; `--lock <file>` writes
  another lock file. An npm pin names no package: the names come from the
  kit (its key) and `scope`, by the scope's layout:

  ```json
  "note": {
    "scope": "@kitionstage",
    "version": "0.1.5",
    "commit": "<40 hex>", "sdkCommit": "<40 hex>", "tesseraCommit": "<40 hex>", "fontsCommit": "<40 hex>",
    "editor": { "integrity": "sha512-<base64>", "size": 12345678 },
    "platforms": {
      "darwin-arm64": { "integrity": "sha512-<base64>", "size": 9876543 },
      "linux-x64": { "integrity": "sha512-<base64>", "size": 9876543 }
    }
  }
  ```

  Until every kit is published in the new layout, the lock also reads a
  GitHub Release pin (`repository`, `version`, `tag`, `asset`, `size`,
  `sha256` and the four commits), the form the kits are pinned in today; it
  is downloaded from `https://github.com/<repository>/releases/download/<tag>/<asset>`
  (the kit repositories are public) and checked by size and SHA-256. When the
  16 kits are on npm under `@kition`, they are pinned again with
  `node scripts/pin-kits.mjs --all` and the Release form is deleted.
- **The registries**, for pinning and fetching, in kition-sdk's and the
  `kition` command's order (`scripts/lib/kitNpm.mjs`, `registries`):
  `KITION_NPM_REGISTRY` (one address or several, comma-separated), then
  `@kition:registry` in `~/.npmrc`, then `npm_config_registry` or the
  `registry` in `~/.npmrc`, then https://registry.npmjs.org/, then
  https://registry.npmmirror.com/. The first that answers wins; a registry
  that fails, lacks the version, or serves other bytes is skipped for the next.
- **Fetching**: `node scripts/fetch-kits.mjs` (`make kit-fetch`) downloads each
  pinned editor package's tarball (for an npm pin
  `<registry><package>/-/<name>-<version>.tgz`), checks its integrity and size
  against the lock, checks it holds only `package/package.json` and
  `package/<kit>-ui/` and that its package.json is the pinned package, version
  and build, checks the extracted `kit-ui.json` (kit id, version, commit), and
  only then puts `<kit>-ui` into `public/kits/`. Each fetched package gets
  a stamp, `<kit>-ui/.kition-package.json` (an npm pin's scope, version,
  editor integrity and commits; a Release pin's repository, asset, SHA-256
  and commits);
  `scripts/build-kit-ui.sh` stamps a local build instead, so a package whose
  stamp is missing, local, or differs from the lock is fetched again even at
  the pinned version (`KITION_KEEP_LOCAL_KITS=1` keeps local builds of the
  pinned version and commit), and `--check` and the release build's
  `dist/kits` check report it. `--check` only compares. `--lock <file>` reads
  another lock, `--kits-dir <dir>` puts the editors elsewhere, and
  `--headless <dir>` also downloads every platform package an npm pin names,
  checked by integrity, size, name, platform and commit, into
  `<dir>/<kit>-<platform>/` (the app ships no headless executable yet). A lock
  entry that is neither pin is refused, naming what to pin.
- **Releasing**: Kition's release workflow (a public repository, so its CI is
  free) fetches the packages, checks every engine against the contract
  (`pnpm check:kit-modules`), runs the kit e2e specs in its sweep, and fetches
  them again for every platform's desktop build.
  `src-tauri/scripts/build.mjs` refuses an rc or stable build unless every kit
  in `kits/modules.json` is pinned and in `dist/kits/` as pinned.
- The packages carry minified JavaScript and WebAssembly without source maps
  or debug names, so shipping them does not publish kit source.

## 4c. Kit CI

The kit repositories are public, so their tests run on GitHub-hosted runners for free; a
developer's machine only compiles (fmt, `cargo check -p` on the touched crates, typecheck).

- **The workflow**: each kit's `.github/workflows/ci.yml` (written by
  `node scripts/kit-ci-install.mjs <kit>`) calls `.github/workflows/kit-ci.yml` here. It runs on
  pushes to `ci/**`, on pull requests, by hand, and nightly on `main`. Jobs: `plan`
  (`scripts/kit-ci-plan.mjs` lists one test job per `test`/`test:*` script of `web/` and the
  root, skipping `test:ci`, `test:ci:full` and scripts that only chain other scripts), `build`
  (the engine and `pnpm build`, shared as the artifact `engine`), `rust` (fmt, clippy
  `--keep-going` and `cargo test --workspace --no-fail-fast`, each run to the end so one run
  reports every failure, then the kit's `cargo xtask ci` when they pass), and the test jobs. The
  checkout (`.github/actions/kit-checkout`) puts kition-sdk, kition-tessera and kition-fonts
  next to the kit, as the kits' scripts expect (Cargo reads kition-sdk through git; the editor's
  `@kition/*` packages come from npm through the kit's lockfile). The test jobs set
  `PLAYWRIGHT_NO_UA_PLATFORM=1`: otherwise Playwright's WebKit reports a Mac `navigator.platform`
  on Linux and editors expect Cmd shortcuts where the tests press Ctrl.
- **Text-only path**: a push to `ci/**` or a pull request whose every changed file (against the
  merge base with `main`) is on the text-only list skips `build`, `rust` and the tests; a
  `Text only` job checks instead that the files are UTF-8 text and that `git diff --check` is
  clean (no conflict markers, no trailing whitespace), and the run ends green in about a minute.
  The list lives in one place, `scripts/kit-ci-plan.mjs` (`isTextOnlyPath`, with its tests):
  Markdown at the root, directly in `.github/` and under `docs/`, except `docs/attribution.md`,
  `docs/parity/`, `docs/features/`, `generated/` and test-like folders (`cases`, `conformance`,
  `expected`, `fixtures`, `tests`, `testdata`, `samples`, `corpus`, ...); `.claude/`; `LICENSE*`
  and `NOTICE*` at the root; `.github/CODEOWNERS` and `.github/ISSUE_TEMPLATE/`. Markdown
  anywhere else is read by some kit's build or tests (crate READMEs compiled in as doctests,
  `agent/guide.md`, `conformance/*.md`, fixtures), so it takes the full run. So does every
  other file, a symlink, an empty change (a branch equal to `main`), and the nightly and
  hand-started runs. A commit that rewords a case's `intent` (a `.yaml` under `cases/`) or a
  comment in a `.rs` file is not text-only. `scripts/kit-ci.sh push <kit> --full` (or
  `KIT_CI_FULL=1`) forces the full run of a text-only change: once the push's run is planned
  text-only, it starts the workflow by hand (`workflow_dispatch`, always full), which cancels
  the text-only run and, as the newest run of HEAD, is the one `wait`, `status` and `land` read.
- **Per kit**: `.github/kit-ci.json` may `exclude` jobs that cannot run on a hosted runner (say
  why in the commit) and set `maxParallel` (default 6).
- **Concurrency**: the organization's plan allows 20 concurrent jobs across all repositories (5 on
  macOS). One kit's run holds at most 8 (build, rust, 6 tests); further runs queue. Runner pools
  (below) add 20 per pool organization.
- **The loop** (`scripts/kit-ci.sh <command> <kit>`): commit on `main` locally; `push` sends HEAD
  to `ci/agent` (a newer push cancels the older run); `wait` follows the run with one API request a minute (`KIT_CI_POLL`), since many kits wait at once and the API allows 5000 requests an hour; on failure,
  `failures` writes the jobs' results, the log lines before each error and the evidence
  (`test-results`, `playwright-report`) under `$TMPDIR/kit-ci/<kit>/<run>/`; fix and push again;
  `land` fast-forwards `origin/main` to HEAD only when HEAD's run passed, then deletes
  `ci/agent`. `wait`, `status` and `land` say "text-only" for a run of the text-only path. Rerun a flaky-looking failure once with `gh run rerun <run> --failed` before
  changing code. `land <kit> --dry-run` makes every check of `land` and pushes nothing.
- **Runner pools**: a run counts against the concurrent jobs of the organization that owns the
  repository it runs in, so another organization with one public repository adds 20 jobs. That
  repository (written by `node scripts/kit-ci-runner-repo.mjs <dir>`: no source, a README, the
  LICENSE, and one `.github/workflows/<kit>.yml` per kit) has workflows started by hand with the
  input `sha`; each is named `<kit> <sha>`, cancels the older run of the same kit, and calls
  `kit-ci.yml@main` here with `repository: KitionAI/kition-<kit>` and `ref: <sha>`, so it tests
  the kit's commit on the pool's runners. A pool run reads only public repositories, so it needs
  no secret and no KitionAI permission; it is always a full run, its Rust caches carry the kit's
  name (one pool repository holds all 16 kits' caches), and its artifacts, the failure evidence
  included, live in the pool repository. Every run, at home or in a pool, names what it tested:
  the plan job's log line `kit-ci-tested <repository>@<sha>`, the summary's first heading and the
  artifact `tested` (`tested.json`). `scripts/kit-ci-pools.json` lists the pools
  (`{ "pools": [{ "repo": "<org>/<repo>" }] }`); while it is empty, `kit-ci.sh` does exactly what
  is described above. With pools, `push` still pushes HEAD to `ci/agent`; a text-only change
  (decided locally with `scripts/kit-ci-plan.mjs` against the merge base with `origin/main`)
  stays at home, where the kit's own run is the text-only path. Otherwise it counts the queued
  and running runs of the KitionAI kit repositories (home) and of each pool, one `gh run list`
  each, and picks the least loaded (home on a tie). For a pool it dispatches `<kit>.yml` with
  `sha=<HEAD>`, finds the run by its name, records it in the kit's `.git/kit-ci-run.json`, then
  cancels the kit's own run of the push and the previous pool run, so HEAD is tested once.
  `wait`, `status` and `failures` read the recorded run while it is of HEAD (else the kit's own
  runs), and each says which repository's run it reads. `land` lands a pool run only when it
  passed, is named `<kit> <HEAD>` and its artifact `tested` says `KitionAI/kition-<kit>` at HEAD.
  `push --full` sends even a text-only change to the least loaded place.
  `KIT_CI_POOL=<org>/<repo>` sends the run to that pool whatever the load (to try a new one), and
  `KIT_CI_POOLS=<file>` reads another list, and `KIT_CI_POOLS=none` runs everything at home (as
  an empty list does), for when a pool misbehaves. What stays in each kit's own
  `ci.yml`: the nightly run on `main`, pull requests, the text-only path, and any push run the
  driver does not cancel. `KitionAI/kit-runner` is a test pool inside KitionAI (it adds no jobs;
  it proves the mechanics) and the template for new pools.
- **Adding a pool** (the owner):
  1. Create the organization (GitHub Free) and in it a public repository, for example
     `gh repo create <org>/kit-runner --public --description "CI runners for the public Kition kits (no source lives here)"`.
  2. `node scripts/kit-ci-runner-repo.mjs <dir>`, then in `<dir>`: `git init -b main`,
     `git add -A`, commit, `git push git@github.com:<org>/kit-runner.git main`.
  3. In the repository's Settings, Actions, General: Actions enabled and "Allow all actions and
     reusable workflows" (or
     `gh api -X PUT repos/<org>/kit-runner/actions/permissions -F enabled=true -f allowed_actions=all`).
  4. Add `{ "repo": "<org>/kit-runner" }` to `pools` in `scripts/kit-ci-pools.json` and land it.
     Nothing else: no secret, no token, no change in the kit repositories. To try the pool first:
     `KIT_CI_POOL=<org>/kit-runner scripts/kit-ci.sh push <kit>`.
  A pool runs `kit-ci.yml` and the kit-checkout action at `main` here, so a broken push to Kition's
  `main` breaks every pool's runs as it breaks every kit's.
- **Before pushing a change to the kit CI files** (`.github/workflows/kit-ci.yml`,
  `.github/actions/`, `scripts/kit-ci*`): every kit and every pool reads them from `main` the
  moment the push lands, and nothing tries them first. On 2026-11-21 an unquoted `: ` in an
  input's description made `action.yml` invalid YAML, and for about three minutes every kit's
  build, Rust and test jobs failed with "Failed to load .../kit-checkout/action.yml"; actionlint
  had passed, as it lints workflows, not action metadata. So run `node scripts/check-workflows.mjs`
  (part of `pnpm lint`, hence of the Stop hook and of CI's verify job) and `actionlint` (CI's
  repository-guards job runs 1.7.12) before the push. The check parses every
  `.github/workflows/*.yml` and `.github/actions/**/action.yml` strictly (no duplicate keys, no
  tabs, no syntax errors, with the line); requires a composite action's `name`, `description`,
  `runs.using: composite`, `shell` on every `run` step and a string `description` on every input;
  and checks that every `inputs.X` an expression reads is declared, that every use of one of
  this repository's actions or reusable workflows names one that exists and passes every
  required input and no undeclared one, and the same for the callers of `kit-ci.yml` written
  here (`scripts/kit-ci-install.mjs` for the kits, `scripts/kit-ci-runner-repo.mjs` for the
  pools). `--caller <file>` adds a caller from another checkout, for example
  `--caller ../kition-html/.github/workflows/ci.yml`. After the push, watch the next kit run that
  starts (`gh run list -R KitionAI/kition-<kit>` or a pool's `kit-runner`) get past its checkout
  steps.
- **Proposed, not in use: a `kit-ci-stable` ref.** Kits and pools would call
  `kit-ci.yml@kit-ci-stable` instead of `@main`, and a ref moves there only after the files
  loaded on GitHub, so a broken push to `main` reaches no kit. The owner decides; until then
  everything reads `main`.
  - *The ref*: a branch `kit-ci-stable` in KitionAI/kition (a branch, so it moves with a
    fast-forward and keeps its history; tags are not meant to move).
  - *What moves it*: a workflow `.github/workflows/kit-ci-stable.yml` on pushes to `main` that
    touch `.github/workflows/kit-ci.yml`, `.github/actions/**`, `scripts/kit-ci*` or itself (and by
    hand), one run at a time (`concurrency: kit-ci-stable`, not cancelled). Its jobs, with
    `contents: read`: `node scripts/check-workflows.mjs` and actionlint; a canary that runs
    `uses: ./.github/actions/kit-checkout` with `kit: html`, `repository: KitionAI/kition-html`
    and `pnpm-cache: 'false'` (proves the action loads on GitHub, about a minute); and a canary
    that calls `uses: ./.github/workflows/kit-ci.yml` for html at its `main` with a new input
    `plan-only: true`, which skips build, Rust and the tests (proves the workflow loads and the
    plan runs, about a minute). Then one job with `contents: write`, and only that job, moves the
    ref to the run's commit with a fast-forward only:
    `gh api -X PATCH repos/KitionAI/kition/git/refs/heads/kit-ci-stable -f sha=$GITHUB_SHA -F force=false`
    (it fails rather than move the ref backwards or sideways). It skips the move while the
    repository variable `KIT_CI_STABLE_FREEZE` is `1`. It does not wait for this repository's own
    CI (the app's e2e and desktop jobs), whose failures say nothing about the kit CI files and
    would hold back kit CI fixes.
  - *What reads it*: `kit-ci.yml` itself takes the kit-checkout action at
    `KitionAI/kition/.github/actions/kit-checkout@kit-ci-stable` and checks out Kition's scripts
    at `ref: kit-ci-stable`, so the workflow, the action and the plan script always come from the
    same commit; `scripts/kit-ci-install.mjs` and `scripts/kit-ci-runner-repo.mjs` write
    `@kit-ci-stable`, and the 16 kits' `ci.yml` and the 4 pools' `kit-runner` are written again
    and pushed once. `scripts/check-workflows.mjs` then also requires every reference to
    Kition's kit CI files on `main` to say `@kit-ci-stable`.
  - *Rolling back*: set `KIT_CI_STABLE_FREEZE=1`
    (`gh variable set KIT_CI_STABLE_FREEZE -R KitionAI/kition -b 1`), move the ref back to the last
    good commit (`gh api -X PATCH repos/KitionAI/kition/git/refs/heads/kit-ci-stable -f sha=<good> -F force=true`),
    fix `main`, then delete the variable. Runs already started keep what they loaded; new runs
    read the old files at once.
  - *Trying a change before it is stable*: push the change to a Kition branch
    `kit-ci-try/<topic>` whose `kit-ci.yml` names the action and the scripts at
    `kit-ci-try/<topic>` instead of `kit-ci-stable`; in one kit, push a branch `ci/try-<topic>`
    (not `ci/agent`, so `kit-ci.sh` and `land` ignore it) whose `ci.yml` calls
    `kit-ci.yml@kit-ci-try/<topic>`, and read its run with `gh run list -R KitionAI/kition-<kit> -b ci/try-<topic>`;
    delete both branches after. A pool cannot try a change (`uses:` takes no expression, so a
    dispatch input cannot pick the workflow's ref); pool runs read only `kit-ci-stable`. Then land
    the change on `main` with the refs back at `kit-ci-stable`; the stable workflow moves the ref
    within minutes.

## 5. Adding A Kit: Checklist

Kit repository:

1. Create the standalone repository from upstream as a clone, never a GitHub
   fork. Credit the upstream project only in the kit's `NOTICE`.
2. Add `crates/kition-<kit>-kit` on `kition-sdk` (section 3), with
   `check_contract` in its tests plus the kit's own tests.
2b. Under engine contract 2, add kition-sdk's `kition-convergence` as a
   dev-dependency of the SDK crate and a `tests/convergence.rs` adapter
   (`KitAdapter`) that drives the document through its commands; it must
   report `level6()`, write its report with `save_if_requested()`, pass its
   WebAssembly parity check with `KITION_WASM_ENGINE` set, and meet the
   collaboration budgets in section 7 (`tests/perf.rs`). `node
   tools/check-manifest.mjs kit.json --convergence <report.json>` then
   reports L6. A `ts-worker` engine runs the same scenarios with kition-sdk's
   TypeScript harness, `@kition/convergence`: a `KitEngineAdapter` subclass
   over its `kitEngineClass` document in a vitest spec, asserting
   `report.level6()` and writing `report.toJsonText()` to
   `KITION_CONVERGENCE_REPORT`.
2c. Implement `KitDocument::check` (kition-sdk `docs/platform/sets/agent.md`, A21–A23): diagnostics with
   stable `<kit>.<name>` codes, a `target`, and a `fix` command hint where
   one exists, errors first, each code covered by a synthetic test. Agents
   reach it as `<prefix>_check`, embeds as `editor.check()` (Slide's
   and Sheet's `bindings/wasm/src/check.rs` are the examples).
3. Add the headless executable `apps/kition-<kit>`:
   `kition_headless::run_manifest::<KitDocument>(include_str!("../../../kit.json"), SANDBOXED, VOLATILE)`.
   Add `"headless": { "executable": "kition-<kit>", "protocol": "kition-kit/1" }`
   to `kit.json`. `SANDBOXED` lists commands whose file parameters the
   engine reads through lent files (otherwise commands naming files are
   refused for the agent); `VOLATILE` lists `inspect()` keys that are session
   state, so `view.describe` survives a save. Pass the conformance suite:
   `cargo run -p kition-kit-conformance -- --kit <kition-<kit>> --manifest kit.json
   --fixture <file> --edit-command <id> --edit-params '<json>'`, 13/13.

Kition runtime and desktop:

4. Nothing to register for the agent: the runtime finds the kit from its
   `kit.json` (package, `--kits-dir`, or beside its headless executable).
5. Map the extensions to a format in `src-tauri/src/workspace/formats.rs`, and
   mirror it in the renderer's `src/features/workspace/lib/workspace.ts` and
   the `WorkspaceDocumentFormat` type.
6. Say in `kit.json` how its agent tools read (K21): `agent.describe` (`noun`,
   `fileTypes`, `reports`, `covers`, `queries`, `example`). A kit whose engine
   renders previews itself (KHP A39: `{slide?, target?, scale?, maxSize?}`
   answers `{png}`) names that command in `agent.render`; a kit that exports
   for the agent (KHP A41) names the command and the answer field holding the
   base64 file in `agent.export` (`command`, `data`, and fixed `params` so the
   open editor and the headless kit export the same thing, A26), for every
   extension in `exports`. The draft tools follow `agent.drafts`, query and
   batch `agent.objectModel` (A35). Add the kit to `KIT_FILE_KINDS` in
   `src/features/agent/lib/documentMentions.ts`, its manifest to kition-sdk
   `crates/kition-kits/tests/fixtures/kits/`, and a case to its
   `tests/sdk_kits.rs` with a small fixture.
7. Keep `contracts/runtime/kits.schema.json` in step with any new route or
   detail shape, and regenerate the renderer types.

Kition renderer:

8. An entry in `kits/modules.json` (the contract check) and the kit in
   `KIT_UIS` in the `Makefile`. Then `make kit-ui-<kit>` and
   `pnpm check:kit-modules`, and when it is ready to ship, the kit's
   Package workflow and `node scripts/pin-kits.mjs <kit>` (section 4b).
9. One entry in `KIT_EDITORS` (`src/features/workspace/components/kits/kitEditors.ts`): format, icon, the
   engine's document class, `preview: true` for a format the file preview
   already shows (PDF, Office; the linked-file prompt then keeps
   `document_read` for its text, `TEXT_EXTRACTED` in
   `crates/kition-kits/src/tools.rs`; add the format to
   `isPreviewableWorkspaceFormat`, or it opens in the system app instead of a
   tab), and `create` when the kit makes new files (id, extension, base name,
   size, label).
10. `<kit>Kit.unavailableTitle` and `<kit>Kit.unavailableBody` in all six
    locales, for development builds without the package.
11. An e2e spec like `e2e/photo-embedded.spec.ts` on
    `e2e/helpers/embeddedKit.ts`. It makes a real fixture with the package's
    engine in Node and covers open, edit, and save in the kit's editor; it
    skips itself when the package is not built. Add it to `KIT_E2E` in the
    `Makefile`.

`make kit-dev` builds every kit package and kit executable and points the
runtime at the executables (`KITION_KIT_<KIT>_BINARY`). `make kit-dev-cache`
does the same but builds only what changed (`scripts/kit-dev-build.mjs`). It
rebuilds a kit's package or executable when the kit's files differ from its
last build, committed or not: committing what was built rebuilds nothing. A
package is also rebuilt when the `kition-sdk` or `kition-tessera` checkout
changed (kition-sdk's tools check the package, and with `KITION_LINK=1` its
editor links both), and either part is rebuilt when its output is gone or
was replaced (`make kit-fetch`). Ignored files and tool caches (`.vite/`,
`__pycache__/`) do not count. Each build is recorded in
`target/kit-dev-cache.json`: the kit's commit, whether it had uncommitted
changes, and the paths of its package and executable. One build runs at a
time: while one runs, a second `make kit-dev` or `make kit-dev-cache` refuses
to start (`target/kit-dev-build.lock`).

Finish with `pnpm run check`, `pnpm check:desktop`, `python3
scripts/check-i18n.py`, the kit's e2e, `pnpm test:table:e2e`, and
`pnpm test:ktable:e2e`. Then try it in the real desktop app (`pnpm dev`)
with a large file.

## 6. Rules Learned The Hard Way

These rules came from Kition's former in-page editors; they apply to the
kits' own editors (kit-editor's canvas and engine worker) in the same way.

Loading and security:

- The CSP in `index.html` allows `'wasm-unsafe-eval'` in `script-src`. That
  permits compiling WebAssembly only; JavaScript `eval` stays blocked. Never
  widen it further.
- Import an SDK by **absolute URL**
  (`new URL('/kits/…', location.href).href`). Vite's dev server rewrites
  root-relative dynamic imports with `?import` and refuses files in
  `public/` (HTTP 500).
- In-page saves go through `PUT /v1/kits/files?path=` with the raw bytes
  (`application/octet-stream`, up to 2 GiB). It accepts only extensions a kit
  handles, only inside the workspace, and replaces the file atomically. Do
  not send files as base64 JSON; axum's default 2 MB limit and the size
  overhead make large files fail.

Responsiveness:

- The engine never runs on the page's thread: one worker per open document.
  With this, a 4096 × 4096 PSD opens (about 0.9 s) and saves (about 1.9 s)
  with zero main-thread long tasks; on the page thread it froze the UI for
  the same time.
- Pan and zoom redraw the cached frame immediately; a fresh render follows
  120 ms after the view settles. Only one full render runs at a time; a
  request meanwhile renders again afterwards.
- Below 1:1 render at a whole-number reduction 1/k (k = floor(1/scale), so
  never blurrier than the screen) via `renderArea`. Then a stroke's patch
  (`renderArea` of the touched area at the frame's k) matches a full render
  exactly. Fractional reductions produced visible one-pixel seams.
- After an edit, repaint only the damaged area. Pass it to `run(…, damage)`.
  For a brush it is the points' bounds plus half the size and a 2 px soft
  edge. A patch computed for a frame that has since been replaced triggers a
  full render instead. Measured on 4K: 23 ms instead of 226 ms at fit.
- Keep the stroke preview on an overlay canvas until the engine's patch
  lands, so nothing flickers.

Saving and the agent:

- `save()` returns bytes; call `markSaved()` only after the write succeeded,
  and only if `revision` did not move during the write.
- While the tab is in front, `useKitDocument` checks the file's
  `etag`/`last-modified` every 2 s. A clean document reloads in place and
  keeps the view. A dirty one shows the changed-on-disk notice (keep mine,
  or load the new version), never a silent overwrite. After its own save it
  records the new stamp, so it does not reload itself.
- "Ask agent" saves first, because the agent works on the file on disk.

React and the canvas:

- `KitCanvas` focuses the editor itself on pointer down and suppresses the
  browser's mousedown focus. Otherwise a field a tool opens (Type) loses focus
  the moment it appears.
- Selection-only commands repaint nothing: pass an empty damage area
  (`NO_REPAINT` in Photo), then trace the selection with an SDK extra.
- Engines refuse edits that make no sense for the target (painting a type
  layer). Show the engine's message in the notice; in tests, pick a valid
  target first instead of expecting success everywhere.

- Remember the last view (for reloads) only after the canvas placed it by
  fitting or by restoring. StrictMode's double effects otherwise store the
  default view and the image opens at 100% in the corner.
- Wheel listeners must be registered with `{ passive: false }` to prevent
  page scrolling. Use pointer capture and coalesced events for strokes.

Exports (Film's MP4):

- A kit that turns its document into another file (a movie from a video
  project) declares the extension in `KitDefinition.exports`. `PUT
  /v1/kits/files` writes an export only as a new file, never over an existing
  one, so an original clip cannot be overwritten. The editor picks an unused
  name (`bars 2.mp4`).
- Long exports run in steps inside the worker (`file.exportMedia` without
  `wait`, then the `exportStep(job, ms)` extra until finished, `takeFile` for
  the bytes), with progress and a stop button; the page never blocks. 1080p
  H.264 encodes at about 5 times slower than real time in single-threaded
  WebAssembly.
- Editing a file the kit does not own (an mp4) goes through a project: "Edit
  in Film" on the video viewer makes `<clip>.kfilm` beside the clip
  (`createKitFile` with a `prepare` step that imports it and builds a
  sequence from it) and opens it. The clip itself is never changed.

Time-based kits (Film):

- Sound leads, the picture follows. The engine mixes audio through an SDK extra
  (`audio(start, frames)`); `FilmAudioPlayer` schedules half-second chunks
  about a second ahead on a WebAudio context, and playback sets the playhead
  from that context's clock. A chunk that arrives late plays its remaining
  part, so sound never drifts. Without a running context (no device, autoplay
  refused) the clock falls back to wall time.
- Create the AudioContext inside the play gesture and call `resume()` there:
  WebKit (the desktop app's WKWebView) starts a new context suspended, while
  Chromium starts it running. Start the playback clock synchronously in the
  gesture, never after an `await`; a clock whose origin is set later reads
  "seconds since page load" and playback stops on its first frame (this
  shipped once and only failed in the desktop app).
- Test in WebKit too: `make kit-e2e-webkit` runs the in-page kit specs in
  Playwright's WebKit. Mocks must behave like the runtime: its file server
  sends `Last-Modified` (readable across origins), not an `ETag`, and
  Playwright cannot read Blob request bodies in WebKit
  (`e2e/helpers/requestBody.ts`).
- Space belongs to play and pause in a player (`spacePans={false}`).

Learned from Film (the second kit):

- Never debounce anything that must eventually happen. Playback changes the
  document every frame, and a debounced command refresh never fired, so no
  shortcut matched. Throttle instead.
- Ask the engine at key-press time whether a command can run; cached enabled
  states lag a fast select-then-delete.
- When two commands bind Delete and Backspace, the exact key wins; `Delete`
  also answering to Backspace (the Mac key) is only a fallback.
- Multi-step edits are normal (create, then place). The contract checkers take
  a list of steps, where `"$0.item"` is step 0's result field.
- A second kit finds what the first hides: `export_kit_document!`, and later
  a kit's extras, only built because Photo happened to depend on wasm-bindgen.
  Test SDK changes on a kit that does not: kition-sdk's CI builds
  `examples/grid-kit` (with an extra) with wasm-pack and runs the JavaScript
  checker on it.

Product:

- Kition draws all chrome; kits contribute commands (with menu paths and
  shortcuts), tools, and panels. Follow `docs/design.md`: purple primary
  `#5645d4`, 8 px buttons, 12 px cards, light surfaces, no scroll bars inside
  the canvas region.
- Status-bar timings (open, render, stroke) are part of the editor; keep them
  so performance can be checked in the real app.

Engine tools (Vector):

- An upstream desktop app often draws the selection itself (outlines,
  anchors, the bounding box, the hover highlight) instead of returning it as
  tool overlays. Port that drawing logic into the kit's SDK crate and return
  it as engine overlays (Vector's `selection.rs`). Never redraw it in the
  host: every host would have to, and it would drift from the engine.
- Overlays are a `decorate` function, not the preview canvas, so they stay in
  place across pans, zooms, and repaints. Assert one in e2e by its pixel
  colour (Vector checks the layer colour of a square's centre point).
- A resolution-independent engine renders sharp above 1:1: the viewport
  already asks `render` for `zoom × devicePixelRatio`, so the SDK draws at
  that scale instead of enlarging a 1:1 frame.
- Keys pressed while the engine is still answering a click are decided when
  the click is answered: the click may have started a text frame. Deciding at
  once with the last answer sent a fast typist's first letters to tool
  shortcuts (Layout's e2e types right after the drag that makes a frame).
- An engine whose document holds pages (Layout) lays them out on one canvas;
  the document pixels are that canvas, so the host's viewport, overlays, and
  damage work unchanged. Open on the first spread with `initialArea`, not the
  whole canvas shrunk to fit.
- Build with an absolute `CARGO_TARGET_DIR`: `wasm-pack` runs cargo inside
  the crate's folder, so a relative one lands in a stray directory there.

Command-line kits (CAD):

- An engine driven by prompts (pick a point, type a distance) maps onto engine
  tools directly: a tool is the command of the same name, clicks answer its
  prompts, and the prompt is a `status` request. When a command starts or ends
  other than by the host's choice (the command line, a menu, Enter), the
  engine sends `switchTool` so the rail follows, and treats a `selectTool` for
  the command already running as a no-op, or following the switch cancels it.
- Expose the command line as an ordinary command (`commandLine` with
  `{text}`), so the host's bar and agents use the same path, and refuse
  through it every command whose parameters name a file, as `kition-headless`
  does; otherwise the command line is a way around the agent's file rules.
- Below 1:1 the viewport shows exact reductions of the 1:1 pixels, so one-pixel
  hairlines fade to light grey at a fitted zoom. Draw them two document pixels
  wide at 1:1, thinning to one screen pixel as the view zooms in.
- Report `busy` while objects are selected, so Escape (clear) and Delete
  (erase) reach the engine.
- Choose document pixels from the drawing alone (CAD: a power-of-two scale of
  limits and extents), so a saved drawing reopens to the same pixels.

Slide and page kits (Slide):

- Stack the slides on one canvas in document pixels (points), so the host
  scrolls the slides; a press on another slide makes it current before the tool
  sees it, and the gesture keeps that slide until it ends. Give the spec an
  `initialArea` (the first slide) and a `focusArea` (the current slide), which
  the editor brings into view only when it is mostly offscreen, so a click
  never moves the view.
- Paint an opaque pasteboard around the slides; transparent gaps show the
  canvas checkerboard.
- Cache 1:1 slide images by the slide's `Arc` and its masters, so zoomed-out
  views (exact reductions of 1:1) do not render every slide again.
- An engine that types into the one selected shape (PowerPoint) reports
  `wantsText` while one shape is selected; otherwise the host keeps the keys.
- Engines built with kition-fonts need the checkout next to the kit
  repository (`../kition-fonts`), or web builds have no fonts and text is
  invisible. The faces an editor hands to `addFont` come from
  `../kition-fonts` (`KITION_FONTS_DIR`), Kition's own font repository.
- Kit editors install the published `@kition/*` packages (kit-editor and the
  Tessera components, theme tokens, and icons) from npm, pinned by the kit's
  `web/pnpm-lock.yaml`; `pnpm install --frozen-lockfile` works whether or not
  other checkouts sit beside the kit. With `KITION_LINK=1`, the kit's
  `web/.pnpmfile.cjs` links kition-sdk and kition-tessera checkouts instead
  (`KITION_SDK`, `KITION_TESSERA`; default `../kition-sdk` and
  `../kition-tessera`) and rewrites the lockfile, which is not committed;
  `scripts/build-kit-ui.sh` honours it and `scripts/package-kit.sh` never uses it.
  Each kit's Vite config allows reading those checkouts. Kits draw icons
  from `@kition/tessera/icons/react` or kit-editor's `TesseraIcons`, never
  from lucide-react, and name icons for their own engine commands in
  `web/src/commandIcons.ts` (`registerCommandIcons`).

Text kits (Doc):

- A word processor always types: report `busy` and `wantsText` all the time,
  so every printable key and editing key reaches the engine, and command
  shortcuts (`Cmd+B`) reach the frame. Turn the engine's `Mod+` shortcuts into
  `Cmd+`.
- Keep the session in a `RefCell` when laying out needs `&mut` (the Doc kit
  caches its layout), since `render` and `inspect` take `&self`. Never mark
  the document changed for a caret or selection move.
- An engine that fills its whole output with paper (`render_region`) renders
  each page's visible piece separately and copies it into place.

Grid kits (Sheet):

- An engine whose upstream draws with its UI toolkit (the Sheet kit's grid is
  egui) needs its own painting in the SDK: port the toolkit drawing (cell
  fills, borders, text, alignment, number formats) into the SDK crate, with
  the faces the upstream web build uses, and list what is not drawn yet in the
  kit repository's gap list (the Sheet kit's `docs/gaps.md`).
- Typing goes to the active cell and is entered on Enter, Tab, or an arrow, as
  in Excel; until then it is an overlay, so the document is not changed (and
  not dirty) by keys alone.
- Give a canvas much larger than a window an `initialArea` near 1:1 (the
  top-left cells), not the whole canvas shrunk to fit.

Tool-table kits (PDF):

- An upstream whose agent surface is a JSON tool table (the PDF kit's
  `automation`) can be the kit's command list: fill in the document argument,
  convert each JSON Schema to the standard's parameter schema (and check it
  with `kition_kit::schema::validate`), and map undo and redo to `edit.undo`
  and `edit.redo`. Leave out tools that open, save, combine, or split other
  files, that make new documents (`out`), reach printers, keychains, or trust
  stores, or run any registry command; drop file parameters from schemas and
  refuse them in `execute`.
- An incremental save must be rebased on the exact bytes the host wrote: keep
  them from `save` for `mark_saved`.

Time-based kits (Motion):

- An export through the engine's own queue (a Render Queue item) changes the
  project and marks it unsaved. Render from a scratch session holding a copy
  of the project instead (Motion's `renderMovie`), so exporting never dirties
  the document.
- Resolve an engine's relative output paths against a virtual root in the
  SDK. Upstream defaults (the home folder, `~/Movies`) are host paths and
  must never appear in a kit's memory keys or reports.
- A command that only moves the current time (`time.set`) must not bump the
  revision; then playback never marks the file unsaved. Cache the rendered
  frame per revision and time, since `render` and `renderArea` both ask.

## 7. Performance Budget

Measured for Photo in Chromium on a 4096 × 4096 PSD with four layers, in a
1280 × 720 window. Confirm new kits against the same budget, and check the
desktop app's status bar too.

| Step | Budget | Photo |
| --- | --- | --- |
| Open (worker) | < 1.5 s, no long tasks | 0.8 to 0.9 s, none |
| Full render at fit | < 300 ms, off the page thread | 220 ms |
| Repaint after a stroke | < 50 ms | 11 to 23 ms |
| Pan and zoom | next frame | immediate (cached frame) |
| Save | < 3 s, no long tasks | 1.3 to 1.9 s, none |

Film, measured on the built SDK in Node with real H.264 through lent files
(single-threaded WebAssembly): 1080p next frame 25 to 34 ms, a seek 200 to
400 ms (decoding from the keyframe), the same frame again 26 ms, and 3.7 MB
read of an 8 MB clip for five frames. Playback skips frames the engine cannot
keep up with; the status bar shows the frame rate reached.

### Collaboration budgets (engine contract 2, L6)

Every contract 2 kit also has budgets for shared editing, measured by the
convergence suite's perf mode (kition-sdk `kition-convergence`, `perf`) on
the kit's own working document: a document built from 200 random commands,
or the adapter's `large()` fixture. Run it from the kit repository with
`cargo test --release -p <kit>-sdk --test perf -- --ignored --nocapture`
(native, Apple M-series, release build, other builds running alongside).

| Step | Budget |
| --- | --- |
| Open a replica from a snapshot | < 50 ms |
| Apply 1,000 remote changes, each its own import | < 10 s (10 ms a change) |
| Local keystroke to paint (the command and the repaint of the visible page) | p95 < 50 ms |
| Memory per replica of the working document | < 16 MB |

| Kit | Objects, snapshot | Open | 1,000 remote changes | Keystroke p50 / p95 | Memory per replica |
| --- | --- | --- | --- | --- | --- |
| Doc | 173, 59 KB | 2.3 ms | 11.8 s (7 ms a change when idle) | 9.0 / 25 ms | 2.2 MB |
| Slide | 354, 167 KB | 6.0 ms | 2.5 s (an import re-reads only the slides it touched) | 4.8 / 6.0 ms (one slide shown, as in the editor) | 4.1 MB |
| Sheet | 369, 141 KB | 2.4 ms | 3.5 s | 5.7 / 6.0 ms | 1.5 MB |
| Vector | 153, 67 KB | 2.5 ms | 4.1 s | 22.2 / 35.3 ms | 1.5 MB |
| Design | 285, 160 KB | 9.2 ms | 2.4 s | 4.4 / 6.0 ms (a 1440 × 900 view) | 3.4 MB |

Doc is over the remote-change budget only while other builds load the
machine. A kit over
budget records it here until it is fixed.

## 8. The Kition SDK Repository

`KitionAI/kition-sdk` (Apache-2.0) is the kit author's SDK:

- `crates/kition-kit`: the contract trait, export macro, contract checker,
  lent files, and raster helpers;
- `examples/grid-kit`: the smallest complete kit;
- `tools/check-sdk.mjs`: the built-SDK checker (Kition's
  `scripts/check-kit-module.mjs` is the same checker with the `kits/modules.json`
  registry);
- the contract (kition-sdk `docs/platform/reference/contract.md`); CI builds the example for wasm32.

Kits pin it by commit (`kition-sdk = { git = "https://github.com/KitionAI/kition-sdk", rev = … }`)
with `net.git-fetch-with-cli = true`. Kition-photo and kition-film use it. The host
side (`src/features/kits/engine/`) stays in Kition and is kept portable by
`check:deps`.

Rules:

- Contract changes happen in kition-sdk, bump `CONTRACT_VERSION` there and
  `KIT_CONTRACT_VERSION` in `src/features/kits/engine/kitModule.ts` together, and
  update both checkers.
- Anything a second kit would need goes into kition-sdk or `sdk/`, not into
  one kit.
- Kit-specific behavior never leaks into the core. Use `invoke` for extras,
  `describe` for view models, and `KitTool` for interaction.
