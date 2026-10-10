# Kit SDK: Editing Kit Files Inside Kition

Status: in use for `kit.photo` and `kit.film` since 2026-10-10. Every new kit
must follow this guide. The kit-side SDK is the private repository
`KitionAI/kition-sdk` (AGPL-3.0-only, like Kition); its `docs/contract.md`
holds the contract section 3 summarizes. The platform background lives in
[kit-platform-architecture.md](kit-platform-architecture.md) and the wire
protocol in [kit-protocol.md](kit-protocol.md).

## 1. The Decision

A kit's editor runs **inside the Kition tab**. The kit's engine is compiled to
WebAssembly (its *SDK*), runs in a Web Worker, and paints pixels into a
`<canvas>`. Kition draws everything else: header, menus, tool rail, options
bar, panels, status bar, notices. The person sees one product, like the suites
of an office package, not a separate program.

The kit's native executable still exists, but only `headless`: the runtime
starts it for the agent (`photo_inspect`, `photo_commands`, `photo_run`) and
for conversions. It never shows a window.

Rejected on 2026-10-10 after a real-app trial: embedding the kit's native
editor in an overlay window above the tab (`surface: embedded`, plan B). It
felt like a second program, showed two canvases and extra scroll bars, and
could not share Kition's menus, dialogs, or focus. Do not build new kits that
way. The plan B code (`PhotoKitEditor`, `/v1/kits/surfaces`,
`src-tauri/src/kit_host.rs`) remains only as Photo's fallback for builds
without the SDK and is slated for removal.

## 2. The Pieces

```text
kit repository (for example KitionAI/kit-photo, standalone, private)
  crates/<engine crates>          the upstream engine, changed as needed
  (git dependency) kition-sdk     KitionAI/kition-sdk: KitDocument, export_kit_document!,
                                  testing::check_contract, host (lent files), raster
  crates/kition-<kit>-sdk         the kit's SDK: its engine behind KitDocument, as WebAssembly
  apps/kit-<kit>                  the headless Kit Protocol executable (agent)
  KITION_CHANGES.md               every upstream file Kition changed, and why

Kition (this repository)
  kits/sdks.json                  every kit SDK: crate, module, class, and its contract-check edit
  public/kits/<kit>-sdk/          the built SDK (not committed; scripts/build-kit-sdk.sh <kit>)
  src/features/kits/sdk/          the portable TypeScript core of the Kit SDK (section 4); it
                                  imports nothing else from Kition (enforced by check:deps)
  src/features/kits/kition/       Kition's editor chrome and workspace host for kits
  src/features/workspace/components/kits/kitEditors.ts
                                  the registry: format -> SDK, editor, fallback
  src/features/workspace/components/<Kit>WebEditor.tsx and <kit>/
                                  the kit's own tools, panels, and options
  scripts/check-kit-sdk.mjs       checks a built SDK against the contract (pnpm check:kit-sdks)
  crates/kition-kits/             the runtime side: kit definitions, /v1/kits routes,
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

Each kit repository adds `crates/kition-<kit>-sdk` on top of the
`kition-sdk` crate, modelled on `crates/kition-photo-sdk` in kit-photo:

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
Redo call them. Shortcuts are written `Cmd+Shift+Z`, `Alt+Backspace`, `F12`;
`Cmd` means Control off macOS.

Prove the contract twice: `check_contract` in the kit's Rust tests, and the
built WebAssembly with `node scripts/check-kit-sdk.mjs --kit <kit>` after an
entry in `kits/sdks.json`. `pnpm check:kit-sdks` checks every built kit. A
third party checks any SDK with `--dir`, `--module`, `--class`, `--name`, and
`--edit`.

Build it with `scripts/build-kit-sdk.sh <kit>`. It needs `wasm-pack` and a
Rust toolchain new enough for the kit; kit-photo needs 1.95, and the script
handles macOS `rust-lld`'s library path. The output, about 20 MB for Photo, is
not committed. wasm-pack writes a `.gitignore` of `*` into it.

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

## 4. The Template (Kition Side)

`src/features/kits/public.ts` is the only import path; it re-exports what
kits use, and more of `sdk/` can be added when a kit needs it. The template
has two layers.

**`sdk/`, the portable core.** It depends on React and itself only, and is
what the open Kit SDK will publish:

| Export | Role |
| --- | --- |
| `KitSdkManifest`, `kitSdkAvailable` | Where an SDK lives (`{ kitId, dir, module, documentClass }`) and whether this build has it |
| `KitEngine` | One document in its own worker; async calls answered in order; `info` (`width`, `height`, `revision`, `dirty`, `canUndo`, `canRedo`, `inspected`) is current after every change; `invoke(name, …args)` reaches an SDK's own extras; a worker failure rejects every waiting call |
| `KitHost` | File IO: `read`, `stamp`, `write` |
| `useKitDocument(host, manifest, path, active, describe)` | Loads the file, follows it on disk, runs commands with a repaint area, saves in place; `describe(info)` maps `inspected` to the kit's view model |
| `KitCanvas` | The document on a canvas: the active `KitTool` gets gestures in document pixels; Space (unless `spacePans` is off, as in a player), the middle button, and `HAND_TOOL` pan; the wheel pans and zooms with Cmd or Ctrl; pointer capture and coalesced events; a preview overlay; `decorate` with `animated` for marching ants; HTML children for inline fields |
| `KitTool`, `KitGesture`, `KitPointer`, `HAND_TOOL`, `ZOOM_TOOL`, `dragRect` | Tools: `begin(pointer, { viewport, overlay })` returns a gesture with `move`, `end`, `cancel` |
| `RasterViewport` | The canvas engine: cached frame, pan, zoom, fit, exact damage patches, sampling, `toScreen` |
| `commandForShortcut` (internal) | Shortcut matching used by the frame |

**`kition/`, Kition's chrome.**

| Export | Role |
| --- | --- |
| `KITION_KIT_HOST` | The workspace as a `KitHost` |
| `useKitEditor(document, { onOpenAgent })` | Command list (at once on open, then throttled to every 250 ms while the document changes), `run` returning the command's JSON result (or null after a notice), `runShortcut`, save notices, "save before asking the agent" |
| `KitEditorFrame` | Header, menus, options, tools, canvas, panels, a `bottom` panel (timelines), status bar; opening, failure, and changed-on-disk states. Keys go to the kit first, then Cmd/Ctrl+S, then the command bound to the key (modified keys, Delete, Backspace, F-keys; never Kition's Cmd+N, W, O, P, Q, T, or comma); the engine is asked whether it can run at that moment |
| `KitMenuBar` | Menus from the commands in a given top-level order |

Shared test ids: `kit-editor`, `kit-unsaved`, `kit-save`, `kit-ask-agent`,
`kit-menu-bar`, `kit-menu-<Menu>`, `kit-menu-command-<id>`,
`kit-canvas-region`, `kit-canvas`, `kit-canvas-surface`, `kit-opening`,
`kit-file-changed`, `kit-file-reload`, `kit-status-bar`. Shared strings live
under `workspace:kitEditor.*` and must never name a kit.

## 5. Adding A Kit: Checklist

Kit repository:

1. Create the standalone repository from upstream as a clone, never a GitHub
   fork. Note the upstream base in the README and keep `KITION_CHANGES.md`
   current.
2. Add `crates/kition-<kit>-sdk` on `kition-sdk` (section 3), with
   `check_contract` in its tests plus the kit's own tests.
3. Implement the headless Kit Protocol executable and pass the conformance
   suite (`kition-kit-conformance`); include the reload-on-change rule.

Kition runtime and desktop:

4. Add a `KitDefinition` to `KITS` in `crates/kition-kits/src/manager.rs`
   (id, name, binary environment variable, extensions, creatable formats).
5. Map the extensions to a format in `src-tauri/src/workspace/formats.rs`, and
   mirror it in the renderer's `src/features/workspace/lib/workspace.ts` and
   the `WorkspaceDocumentFormat` type.
6. Add agent tools in `crates/kition-agent/src/tools/kits.rs` and their
   catalog entries, following the `photo_*` tools.
7. Keep `contracts/runtime/kits.schema.json` in step with any new route or
   detail shape, and regenerate the renderer types.

Kition renderer:

8. An entry in `kits/sdks.json`, then `scripts/build-kit-sdk.sh <kit>` and
   `pnpm check:kit-sdks`.
9. `src/features/workspace/components/<kit>/<kit>KitSdk.ts`: the manifest
   and `describe<Kit>(info)`; `<kit>CanvasTools.ts`: the kit's `KitTool`s
   (Photo's `photoCanvasTools.ts` shows brushes, rectangles, lassos, clicks,
   and inline text).
   `<Kit>WebEditor.tsx`: `useKitDocument(KITION_KIT_HOST, …)`,
   `useKitEditor`, `KitEditorFrame`, and `KitCanvas` with the active tool.
10. One entry in `KIT_EDITORS` (`kits/kitEditors.ts`): format, SDK, lazy
    editor, fallback, and `create` when the kit makes new files (id, extension,
    base name, size, label, icon). The create menu then offers it: the SDK's
    own `create` makes the file in the page (`createKitFile`), under an
    unused name, written through the host.
11. Strings in all six locales; menu labels under `<kit>Kit.menu.*`.
12. An e2e spec like `e2e/photo-web-editor.spec.ts`. It generates a real
    fixture with the SDK in Node, serves `/workspace-files/<file>` with an
    `etag`, captures `PUT /v1/kits/files`, and covers open, edit, undo, redo,
    save, the agent's clean reload, and the conflict notice. It skips itself
    when the SDK is not built. Kit-process specs must route
    `**/kits/<kit>-sdk/**` to 404 so they test the fallback deterministically.

Finish with `pnpm run check`, `pnpm check:desktop`, `python3
scripts/check-i18n.py`, the kit's e2e, and `pnpm test:table:e2e`. Then try it
in the real desktop app (`pnpm dev`) with a large file.

## 6. Rules Learned The Hard Way

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

Time-based kits (Film):

- Sound leads, the picture follows. The engine mixes audio through an SDK extra
  (`audio(start, frames)`); `FilmAudioPlayer` schedules half-second chunks
  about a second ahead on a WebAudio context, and playback sets the playhead
  from that context's clock. A chunk that arrives late plays its remaining
  part, so sound never drifts. Without a running context (no device, autoplay
  refused) the clock falls back to wall time.
- Create the AudioContext inside the play gesture; browsers refuse sound
  started anywhere else.
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

## 8. The Kition SDK Repository

`KitionAI/kition-sdk` (private for now, AGPL-3.0-only, like Kition and the
kits) is the kit author's SDK:

- `crates/kition-sdk`: the contract trait, export macro, contract checker,
  lent files, and raster helpers;
- `examples/grid-kit`: the smallest complete kit;
- `tools/check-sdk.mjs`: the built-SDK checker (Kition's
  `scripts/check-kit-sdk.mjs` is the same checker with the `kits/sdks.json`
  registry);
- `docs/contract.md`: the contract; CI builds the example for wasm32.

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
