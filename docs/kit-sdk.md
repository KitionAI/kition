# Kit SDK: Editing Kit Files Inside Kition

Status: in use for all ten kits. Revised 2026-10-15: every kit draws its own
editor, and Kition's own kit editors are gone. Every new kit must follow this guide.

This guide is how Kition implements the **Kit Harness Protocol (KHP)** and
the Kition kit platform, which are normative. KHP (how an AI agent uses a
kit) is [`spec/`](https://github.com/KitionAI/kit-standard/tree/main/spec)
in the private `KitionAI/kit-standard` repository (aligned with DeepSeek
Harness contracts); the platform (engines, the Kit Data Model, the Kit UI
protocol, embedding) is `docs/platform/` in the private
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
(`apps/kit-<kit>` in each kit repository). The agent's tools for every kit are
`<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run`, generated from
the kit's definition (`photo_*`, `film_*`, `vector_*`, `effect_*`,
`design_*`, `cad_*`, `slide_*`, `doc_*`, `sheet_*`, `pdf_*`).

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
kit repository (for example KitionAI/kition-photo, standalone, private)
  crates/<engine crates>          the upstream engine, changed as needed
  (git dependency) kition-sdk     KitionAI/kition-sdk: KitDocument, export_kit_document!,
                                  testing::check_contract, host (lent files), raster
  crates/kition-<kit>-sdk         the kit's SDK: its engine behind KitDocument, as WebAssembly
  web/                            the kit's own editor on @kition/kit-editor; with the engine,
                                  the kit package (web/scripts/build-engine.sh, pnpm build)
  apps/kit-<kit>                  the headless Kit Protocol executable (agent)
  NOTICE                          credits the upstream project the kit derives from, if any

Kition (this repository)
  kits/sdks.json                  every kit engine: crate, module, class, and its contract-check edit
  public/kits/<kit>-ui/           the kit package: editor, engine/, fonts/, kit-ui.json,
                                  model/schema.json (the KDM schema, when kit.json names one),
                                  agent/checks.json and agent/guide.md (KHP K17, when the kit has them)
                                  (not committed; scripts/build-kit-ui.sh <kit>, make kit-uis)
  src/features/kits/kition/       KitFrame (the kit's editor in an iframe), the workspace
                                  host, and the Kit AI bridge
  src/features/kits/host/         Kition's copy of @kition/kit-protocol and @kition/kit-host
  src/features/kits/sdk/          loads a kit's engine in the page; Kition makes new files
                                  with it (createKitFile); imports nothing else from Kition
  src/features/workspace/components/kits/kitEditors.ts
                                  the registry: format -> kit package, engine, create menu item
  scripts/check-kit-sdk.mjs       checks a built engine against the contract (pnpm check:kit-sdks)
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

Each kit repository adds `bindings/wasm` (the `kition-<kit>-sdk` crate) on top of the
`kition-sdk` crate, modelled on `bindings/wasm` in kition-photo:

```rust
use kition_sdk::{KitCommand, KitDocument};

pub struct SketchDocument { /* the engine's session */ }

impl KitDocument for SketchDocument {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> { /* … */ }
    // create, width, height, revision, dirty, render, render_area,
    // execute, inspect, commands, save, mark_saved
}

kition_sdk::export_kit_document!(SketchDocument as "SketchDocument");

#[test]
fn keeps_the_kit_sdk_contract() {
    kition_sdk::testing::check_contract::<SketchDocument>(&fixture(), "fixture.sketch", |doc| {
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
  `#[wasm_bindgen(js_class = "<Class>", wasm_bindgen = kition_sdk::wasm_bindgen)]`
  and `use kition_sdk::wasm_bindgen::prelude::*`, and are reached from the
  page with `KitEngine.invoke`.
- No `unsafe`, no `unwrap`, `expect`, or `panic!`. Bad input returns an error
  (a `JsError` in JavaScript), never a panic, because a panic kills the worker.
- `examples/grid-kit` in kition-sdk is the smallest complete kit to copy. A
  kit does not depend on wasm-bindgen; the macro brings it.
- Engines that render whole frames (video, slides, pages) implement `render`
  and `render_area` with `kition_sdk::raster` from one full-resolution frame;
  the results are contract-exact.
- Documents that name other files (a film project's media) read them with
  `kition_sdk::host` (lent files, below).

The JavaScript class the macro generates (`KitSdkDocument` in
`src/features/kits/sdk/kitSdk.ts`):

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
built WebAssembly with `node scripts/check-kit-sdk.mjs --kit <kit>` after an
entry in `kits/sdks.json`. `pnpm check:kit-sdks` checks every built kit. A
third party checks any SDK with `--dir`, `--module`, `--class`, `--name`, and
`--edit`. A text format (`"text": true`, the Note kit's Markdown) has no bad
bytes: every byte sequence is a file of it, so the check opens any bytes
without a crash instead of expecting random bytes to be refused.

The kit package's build (`scripts/build-kit-ui.sh <kit>`, through the kit's
`web/scripts/build-engine.sh`) builds the engine into `engine/`. It needs
`wasm-pack` and a Rust toolchain new enough for the kit; kit-photo needs 1.95,
and the script handles macOS `rust-lld`'s library path. The output, about
20 MB for Photo, is not committed.

Lent files: `kition_sdk::host::{size, read_range, read}` are synchronous.
Kition's worker answers them (`src/features/kits/sdk/lentFiles.ts`) with
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
`PhotoHeadless::open` and `file_times` in kit-photo.

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
sizes for touch. Photo, Vector, Film, Effect, and CAD default to Menus; Doc,
Sheet, Slide, PDF, and Design to Single line (`kit.json` `ui.display`). Canvas
kits pass a tool rail of flyout slots; side panels sit right of the body. A
kit declares its tabs as `{ id, label, view?, ribbon?, menu? }`
(`catalogTabs` and `commandMenuTabs` build menu tabs) and marks Single line
items with `primary`.

- `scripts/build-kit-ui.sh <kit>` builds the kit's engine and editor into
  `public/kits/<kit>-ui/` with a `kit-ui.json` marker (`make kit-ui-<kit>`;
  `make kit-uis` for all of `KIT_UIS`). The package keeps its own fonts and
  assets (UI-K1), so it stays embeddable without Kition. A kit whose
  `kit.json` names `model.schema` (K12) ships that file as
  `model/schema.json`: the schema its engine was built with. `@kition/embed`
  reads it for draft review and the agent's object-model calls, and
  `@kition/sdk`'s `openKitPackage` opens documents with it, before the
  schemas bundled in `@kition/sdk/kits`. The kit's `agent/checks.json` (its
  check catalogue) and `agent/guide.md` (its guide for models) travel the
  same way (KHP K17). A local build warns when the kit's `level` claims
  Agent-ready without them, and `scripts/publish-kit.sh` refuses to publish
  it. kition-sdk's
  `packages/sdk/scripts/sync-kits.mjs` regenerates those bundled kits from
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
  next to the document), `links/pick` (Kit UI protocol 2.5, capability
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
  Kit UI protocol 2.4 section 7j, `ai-field` and `rewrite` (the runtime
  puts its own rewrite instructions before the kit's prompt). It refuses a
  kit's own purposes (`<kit>.<name>`) as `not-allowed`, because Kition has no
  generic handling for them, and `mountKit` refuses any other string
  (UI-G4). It answers `host/action` with its
  own actions (`kitActions.ts`: `workflow.run` through
  `POST /v1/workflows/{id}/run-record`, and `design.fromRecord`); neither is
  offered to a preview or a read-only document. Links (KitLinks 1.0
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
  the document and those its links name in other folders (film and effect
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
- `KIT_EDITORS` in `kits/kitEditors.ts` maps a format to its kit package.
  `KitFilePane` shows the package when its `kit-ui.json` is present. A
  development build without the package shows the file preview for formats
  the preview shows (`preview: true`: PDF and Office), or a short notice.
- New files (the create menu, Film's "Edit in Film") are made in the page by
  the engine inside the package (`createKitFile`, the `engine` manifest of the
  entry), under an unused name, written through the host.
- `src/features/kits/host/` is Kition's copy of `@kition/kit-protocol` and
  `@kition/kit-host` (kition-sdk is private, Kition public):
  `node scripts/sync-kit-host.mjs` copies them, and `pnpm check:kit-host`
  fails when they drift. The same script copies kition-sdk's `kit.json`
  schema into `contracts/kit/kit.schema.json`, which the conformance
  suite checks manifests against.
- Extensions and scripts (`KitExtensions 1.0`) work on open kit documents
  through the object model (`KitObjectModel 1.0`). `src/lib/sdk/` (the
  object model, `@kition/sdk`) and `src/lib/extensions/` (the extension
  host, `@kition/extensions`, with its built worker runtime) are copies made
  by the same sync script, as are `public/extensions/sandbox.html` and
  `public/extensions/panel.html`, the sandbox and panel pages. Settings >
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
  `frame-src` keeps it on its page. `src/lib/sdk/kits/` registers the schema
  of every kit with an object model (Doc, Slide, Sheet, Photo, Vector,
  Effect, CAD, PDF, Table, Film, Board, Note, Cube, Fig), generated in kition-sdk from each kit's
  `model/schema.json` at its pinned commit. `e2e/extensions.spec.ts`
  installs the example extension, runs its command and its panel, and runs
  scripts on Slide, Doc, Sheet, and Fig documents. Kition sends the
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
table editor of its own. Kition's host features (workflows, form and email
sync, the scenario builder, the workspace tree) read and write tables through
the host table client, `crates/kition-tableclient`: through the Kit AI bridge
when an editor has the file open, so the edit arrives live, and through the
headless `kit-table` otherwise. Its writes carry a `system:<feature>` origin
and never join the person's undo; workflow triggers read
`table.changes.since` from a cursor kept per file in the workspace
(`.kition/tables/changes.json`), so a restart neither drops nor repeats
an edit. The renderer reaches it through `/v1/kit-tables*`
(`contracts/runtime/kit-tables.schema.json`, `src/api/kitTables.ts`), and
workflows name a table by its file path (`documentPath`) and table id. They follow the file: a rename or move
(`/v1/kit-tables/renamed`) changes the path they name, and a delete
(`/v1/kit-tables/deleted`) removes them. An expanded table file in the
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
engine (`kition_board_sdk`, `BoardDocument`) and editor live in its
repository, published and pinned like every other kit. The create menu's Board
item makes an empty board with the engine in the page, and the agent's
`board_*` tools run on the headless `kit-board` for files no editor has open
(found from its `kit.json`). `e2e/board-embedded.spec.ts` (in
`make kit-e2e`) covers what Kition adds around the kit: opening, drawing,
saving through Kition, and creating a board; the editor's own behavior is
tested in the kit's repository. Kition has no board editor of its own.

### The Cube kit

`kit.cube` (`KitionAI/kition-cube`, package `public/kits/cube-ui`) is the
3D kit: `.kcube` files (a ZIP of the scene as JSON and each mesh as a binary
buffer) open in its own editor in `KitFrame`. Its Rust engine
(`kition_cube_sdk`, `CubeDocument`) renders the viewport in software in the
worker; the document's size is the editor's viewport (`view.resize`), and the
view, shading, and selection are session state that never makes the file
dirty. It exports glTF/GLB, OBJ, STL, and PNG renders, and places glTF, OBJ,
and STL files into a scene. The create menu's Cube item makes the starter
scene (a cube, a light, and a camera) with the engine in the page, and the
agent's `cube_*` tools run on the headless `kit-cube`, with rotations in
degrees and Z up. Its features and defaults are checked against Blender as a
reference application only (the kit is a clean-room Apache-2.0
implementation). `e2e/cube-embedded.spec.ts` (in `make kit-e2e`) covers opening,
editing, saving, and creating a scene through Kition.

### The Fig kit

`kit.fig` (`KitionAI/kition-fig`, package `public/kits/fig-ui`) is the
interface design and prototyping kit: `.kfig` files open in its own editor in
`KitFrame`, on its Rust engine (`kition_fig_sdk`, `FigDocument`) in the
worker. The engine also imports `.fig` and `.sketch` files; Kition opens only
`.kfig` in the kit. The create menu's Fig item makes `Untitled fig.kfig`
(one 1440 x 1024 frame) with the engine in the page, and the agent's `fig_*`
tools run on the headless `kit-fig` (`view.describe`, `document.check`, and
the object model's `model.*`). Fig is on engine contract 2: a design is a
KDM replica of schema `kit.fig` v2 (kition-fig `docs/kdm.md`; v2 adds the
libraries a design uses, `Library` objects in `Fig.libraries`), carried inside
the `.kfig` file under `kdm/`, so people co-edit a shared design and the
editor lists the `replica` capability (its replica also goes to Kition's
store, below). Its object model (namespace `Fig`, registered in
`src/lib/sdk/kits/fig.ts`) serves `fig_query` and `fig_batch`, in the open
editor through the Kit AI bridge and headless; workspace scripts use it too.
Fig claims no agent drafts. Through the headless kit a batch's model
operations reach the engine as a collaborator's changes (kition-sdk
`session::model::Exchange`), so the agent's undo takes back its commands but
not those. `e2e/fig-embedded.spec.ts` (in `make kit-e2e`) covers opening,
editing, saving, and creating a design through Kition, and
`e2e/collab-fig.spec.ts` (in `pnpm test:collab:e2e`) co-editing, the
agent's object model in the open editor, and undo by scope. A design uses team
libraries from other `.kfig` files: "Add library file…" asks Kition for a
file to link (`links/pick`), the design names it relative to its folder
(`../libraries/Design System.kfig`), and the editor reads it and watches
its stamp through `host/read` and `host/stamp`, so a library published again
on disk shows as an update to accept; `e2e/fig-embedded.spec.ts` covers
that flow, and `sdk_kits.rs` reads a design's libraries headless. Build it locally
with `scripts/build-kit-ui.sh fig`; the SDK registry marks Fig optional until
its first package is published and pinned.

### The Note kit

`kit.note` (`KitionAI/kition-note`, package `public/kits/note-ui`) is a
normal kit: `.md` and `.markdown` files open in its own editor in `KitFrame`,
and its Rust engine (`kition_note_sdk`, `NoteDocument`) and editor live in
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
  open, and through the headless `kit-note` otherwise (found from its
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

## 4b. Kit Packages And Releases

Kition ships every kit's package inside the app (decided 2026-10-15). All ten
packages add about 57 MB compressed; the renderer is embedded in the
executable with brotli, so the installer and the installed app grow by about
that much, and every app update downloads it again.

A kit package is also the kit's SDK deliverable: the same `.tgz` is what
another application embeds. A web page embeds it with kition-sdk's
`@kition/embed` (`KitionEmbed.mount`, capability set `KitEmbed 1.0`; see
kition-sdk's `docs/platform/reference/embed.md`): the page serves the extracted package from an
origin of its own, keeps documents in its own storage, and may co-edit them
through a sync server. Kition consumes the package the way any other host
would, through `@kition/kit-host`, so it never builds kits in its release.

- **Publishing** runs on a developer machine, never in the private kit
  repositories' CI (their Actions minutes are limited):
  `scripts/publish-kit.sh <kit>` clones the pushed `origin/main` of the kit,
  kition-sdk, kition-tessera, and kition-fonts side by side in a scratch folder (local changes
  never reach a package), builds the package with `scripts/build-kit-ui.sh`,
  uploads `kition-<kit>-<version>.tgz` to a `package-v<version>` Release of
  the kit's repository with `gh`, and pins it in `kits/kits.lock.json`
  (version, commit, size, SHA-256, and the kition-sdk, kition-tessera, and
  kition-fonts commits). A version is published once: bump `version` in the kit's
  `kit.json` to publish a change. `--dry-run` builds and packs only.
- **Fetching**: `node scripts/fetch-kits.mjs` (`make kit-fetch`) downloads the
  pinned packages into `public/kits/` with `gh release download`, checks size
  and SHA-256, and checks the extracted `kit-ui.json` (kit id, version,
  commit). Each fetched package gets a stamp, `<kit>-ui/.kition-package.json`
  with its lock entry (version, SHA-256, commit, kition-sdk commit);
  `scripts/build-kit-ui.sh` stamps a local build instead, so a package whose
  stamp is missing, local, or differs from the lock is fetched again even at
  the pinned version (`KITION_KEEP_LOCAL_KITS=1` keeps local builds of the
  pinned version and commit), and `--check` and the release build's
  `dist/kits` check report it. `--check` only compares. Locally it uses your gh login; the release
  workflow uses the `KITION_KITS_TOKEN` secret, a read-only token for the kit
  repositories' contents. The kit repositories stay private.
- **Releasing**: Kition's release workflow (a public repository, so its CI is
  free) fetches the packages, checks every engine against the contract
  (`pnpm check:kit-sdks`), runs the kit e2e specs in its sweep, and fetches
  them again for every platform's desktop build.
  `src-tauri/scripts/build.mjs` refuses an rc or stable build unless every kit
  in `kits/sdks.json` is pinned and in `dist/kits/` as pinned.
- The packages carry minified JavaScript and WebAssembly without source maps
  or debug names, so shipping them does not publish kit source.

## 5. Adding A Kit: Checklist

Kit repository:

1. Create the standalone repository from upstream as a clone, never a GitHub
   fork. Credit the upstream project only in the kit's `NOTICE`.
2. Add `crates/kition-<kit>-sdk` on `kition-sdk` (section 3), with
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
3. Add the headless executable `apps/kit-<kit>`:
   `kition_headless::run_manifest::<KitDocument>(include_str!("../../../kit.json"), SANDBOXED, VOLATILE)`.
   Add `"headless": { "executable": "kit-<kit>", "protocol": "kition-kit/1" }`
   to `kit.json`. `SANDBOXED` lists commands whose file parameters the
   engine reads through lent files (otherwise commands naming files are
   refused for the agent); `VOLATILE` lists `inspect()` keys that are session
   state, so `view.describe` survives a save. Pass the conformance suite:
   `cargo run -p kition-kit-conformance -- --kit <kit-<kit>> --manifest kit.json
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

8. An entry in `kits/sdks.json` (the contract check) and the kit in
   `KIT_UIS` in the `Makefile`. Then `make kit-ui-<kit>` and
   `pnpm check:kit-sdks`, and when it is ready to ship,
   `scripts/publish-kit.sh <kit>`.
9. One entry in `KIT_EDITORS` (`kits/kitEditors.ts`): format, icon, the
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

`make kit-dev` builds every missing kit package and kit executable and points
the runtime at the executables (`KITION_KIT_<KIT>_BINARY`).

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
  shortcuts (Design's e2e types right after the drag that makes a frame).
- An engine whose document holds pages (Design) lays them out on one canvas;
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
- Kit editors need kition-tessera checked out next to kition-sdk
  (`../kition-tessera`): kit-editor takes its components, theme tokens, and
  Tessera Icons from it, and each kit's Vite config allows reading it. Kits
  draw icons from `@kition/tessera-icons/react` or kit-editor's `TesseraIcons`,
  never from lucide-react, and name icons for their own engine commands in
  `web/src/commandIcons.ts` (`registerCommandIcons`). `scripts/publish-kit.sh`
  clones kition-tessera beside kition-sdk too.

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
  with `kition_sdk::schema::validate`), and map undo and redo to `edit.undo`
  and `edit.redo`. Leave out tools that open, save, combine, or split other
  files, that make new documents (`out`), reach printers, keychains, or trust
  stores, or run any registry command; drop file parameters from schemas and
  refuse them in `execute`.
- An incremental save must be rebased on the exact bytes the host wrote: keep
  them from `save` for `mark_saved`.

Time-based kits (Effect):

- An export through the engine's own queue (a Render Queue item) changes the
  project and marks it unsaved. Render from a scratch session holding a copy
  of the project instead (Effect's `renderMovie`), so exporting never dirties
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
| Fig | 285, 160 KB | 9.2 ms | 2.4 s | 4.4 / 6.0 ms (a 1440 × 900 view) | 3.4 MB |

Doc is over the remote-change budget only while other builds load the
machine. A kit over
budget records it here until it is fixed.

## 8. The Kition SDK Repository

`KitionAI/kition-sdk` (private for now, Apache-2.0, like the kits and the shared
kit UI library) is the kit author's SDK:

- `crates/kition-sdk`: the contract trait, export macro, contract checker,
  lent files, and raster helpers;
- `examples/grid-kit`: the smallest complete kit;
- `tools/check-sdk.mjs`: the built-SDK checker (Kition's
  `scripts/check-kit-sdk.mjs` is the same checker with the `kits/sdks.json`
  registry);
- the contract (kition-sdk `docs/platform/reference/contract.md`); CI builds the example for wasm32.

Kits pin it by commit (`kition-sdk = { git = "https://github.com/KitionAI/kition-sdk", rev = … }`)
with `net.git-fetch-with-cli = true`. Kit-photo and kit-film use it. The host
side (`src/features/kits/sdk/`) stays in Kition and is kept portable by
`check:deps`.

Rules:

- Contract changes happen in kition-sdk, bump `CONTRACT_VERSION` there and
  `KIT_CONTRACT_VERSION` in `src/features/kits/sdk/kitSdk.ts` together, and
  update both checkers.
- Anything a second kit would need goes into kition-sdk or `sdk/`, not into
  one kit.
- Kit-specific behavior never leaks into the core. Use `invoke` for extras,
  `describe` for view models, and `KitTool` for interaction.
