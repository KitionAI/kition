# The Whiteboard's document model

The built-in Whiteboard stores its document as a **Kit Data Model (KDM)**
replica: a CRDT document with field-level transactions, collision-free ids,
list ordering, per-author undo, and merge-safe concurrent edits. This page
describes how that model is laid out and how the editor reads and writes it.
The Whiteboard is a built-in document type, not a kit (see
[kit-sdk.md](kit-sdk.md) for that separate system).

## Where the KDM comes from

`@kition/kdm` is not an installed dependency: it is a copy of
`packages/kdm/src/*.ts` from the private `kition-sdk` repository, carried into
this repository at `src/lib/kdm/` by `scripts/sync-kit-host.mjs`. Every file
the script writes there starts with a header naming its source and saying
"change it there, not here" — the KDM's contract and implementation are
normative in `kition-sdk`, not in Kition.

- `node scripts/sync-kit-host.mjs` copies the latest files from
  `../kition-sdk` (or `$KITION_SDK`) into `src/lib/kdm/`.
- `pnpm check:kit-host` (`node scripts/sync-kit-host.mjs --check`) fails if
  the copy has drifted from `kition-sdk`, so CI catches a hand-edit of
  `src/lib/kdm/`.
- To change KDM behavior, change it in `kition-sdk` first, then re-run the
  sync script here. Do not edit `src/lib/kdm/` directly.

## The `kit.board` schema

The whiteboard's KDM schema lives in
`src/features/whiteboard/kdm/boardSchema.ts` under the kit name `kit.board`.
Its root type is `Board`:

- **`Board`** — `title` (string) and `pages` (an ordered list of `Page`).
- **`Page`** — `name` (string) and `elements` (an ordered list of `Element`).
- **`Element`** — one object per whiteboard element (rectangle, text,
  stroke, connector, or image), identified by its `kind` enum field, with:
  - geometry fields (`x`, `y`, `width`, `height`, `rotation`, `locked`);
  - an optional `parent` reference to another `Element`, for groups and
    frames;
  - style fields stored individually — `strokeColor`, `fillColor`,
    `fillStyle`, `dashStyle`, `opacity`, `strokeSize` — rather than as one
    JSON blob, so that two people changing different style properties of the
    same element merge instead of one write clobbering the other
    (`BOARD_STYLE_FIELDS` in `boardSchema.ts`);
  - `text` as a KDM `text` field (a collaborative text type), not a plain
    string, so concurrent edits of the same element's text merge
    character-by-character instead of one edit overwriting the other;
  - connector fields (`start`, `end`, `connectorType`, arrowheads,
    `startBinding`/`endBinding`) — a binding anchors a connector's endpoint
    to another element, stored as a JSON value naming the target object and
    an anchor point;
  - a few remaining fields — `points` (freehand strokes), `image`,
    `sourceRefIds` — stored as opaque JSON because they are not edited
    field-by-field.

Both page order (`Board.pages`) and element order within a page
(`Page.elements`) are KDM lists, so reordering a page or an element becomes a
list move rather than a rewrite of an `index` field, and concurrent reorders
merge via the list CRDT.

## `BoardStore`: the replica's view

`src/features/whiteboard/lib/boardStore.ts` exposes `BoardStore`, which keeps
its existing public API (`getRecords`, `transact`, `undo`, `redo`, …) but is
now a materialized view over a KDM `Replica`. The pieces:

- **Commit → field-level transaction.** A `BoardStore` transaction collects a
  `BoardRecordDiff` (added/updated/removed records) from the view, then
  `BoardReplicaHistory.commit` (`src/features/whiteboard/kdm/boardReplicaBridge.ts`)
  writes it as one KDM transaction via `writeBoardDiff`
  (`src/features/whiteboard/kdm/boardKdmWrite.ts`), which sets only the
  fields that actually changed and turns order changes into list moves. This
  is what makes concurrent edits of different fields, or of different
  elements' order, merge instead of conflict.
- **Live gestures and history marks.** A transaction started with
  `{ live: true }` notifies on every intermediate change (for drag/resize
  feedback) and still commits once at the end. `markHistory`/`squashToMark`/
  `bailToMark` let a multi-step gesture collapse into one undo step, or be
  rolled back without leaving a redo step.
- **Undo groups.** The outermost open history mark opens the replica's undo
  group (`Replica.beginUndoGroup`/`endUndoGroup`); inner marks share it. A
  group that changed anything is one undo step.
- **Read-back of skipped and relocated ids.** `writeBoardDiff` returns
  `{ skipped, relocated }`: ids it could not write as asked (an update to an
  element or page the replica no longer has, or an element placed on a page
  neither the replica nor the diff has). `BoardStore` re-reads those ids from
  the replica after the commit (`readBack`) so the view never shows a ghost
  element or a bogus write.
- **Repair as non-undoable `system` transactions.** Loading a document, or
  importing changes from elsewhere, can leave duplicate list placements (an
  element two merges each inserted into a different page's list) or dangling
  references. `BoardReplicaHistory.repair` fixes these — and
  `repairBoardPlacements` removes duplicate placements — in a transaction
  with `system('repair')` origin, which the KDM keeps out of undo history.
- **Imports.** `BoardStore.importChanges` merges another copy's changes
  (`Replica.importChanges`) and rebuilds the view, repairing what the merge
  left inconsistent. An import arriving mid-gesture or mid-undo-group is
  deferred until the gesture or group ends, so it can never split one.

Reading the replica back into records is `boardKdmRead.ts`
(`readBoardRecords`, plus narrower per-id readers such as
`readBoardElementRecords` and `readBoardBindingRecords` used by read-back and
repair so they do not have to materialize the whole board).

## Ids

Every object (element, page) gets a **UUID v7** (`newObjectId` in
`src/lib/kdm/ids.ts`, wrapped by
`src/features/whiteboard/lib/whiteboardElementId.ts`): unique across replicas
without coordination, and roughly creation-ordered. A KDM transaction's
`create` also accepts a caller-chosen id (`tx.create(type, fields, { id })`),
which the whiteboard's file creation and template code use when it needs a
specific root or page id.

The AI agent names elements it creates with short ids of its own choosing
(such as `n2`), meaningful only within one patch.
`src/features/whiteboard/lib/whiteboardAgentPatch.ts` turns every such name
into a real object id before it reaches the document
(`remapAgentCreatedIds`), rewriting every reference — parents, source
references, connector bindings — to match. Once a patch is accepted, its
created names are remembered in a `renamed_ids` map
(`rememberAgentRenamedIds`) so that a later patch in the same conversation can
still refer to an element by the name the agent gave it; `resolveAgentRenamedIds`
resolves those names before the operations run, and reusing a remembered name
to create a new element is rejected.

## Per-user view state

The current page and the camera viewport are **view state**, not part of the
document: they are never written to the replica and never an undo step, so
they do not create undo noise and do not conflict between users sharing a
file. `src/features/whiteboard/hooks/useBoardViewState.ts` keeps them in
`localStorage` under the key `kition.board.view.<docId>` (debounced, flushed
on unmount or document switch). `BoardStore.setActivePage` mirrors the active
page into an in-memory `meta` record for convenience, but that record is
stripped before anything is written to the KDM document
(`persistedBoardDiff` in `boardReplicaBridge.ts`).

## The `.kiboard` file (envelope v2)

A `.kiboard` file is a one-line JSON envelope holding the whole KDM document
as a base64-encoded snapshot:

```json
{"format":"kition-board","version":2,"kdm":"<base64 of Replica.snapshot()>"}
```

There is no record JSON and no viewport in the file — the KDM snapshot *is*
the document, and viewport/current-page live in per-user view state (above).
`src/features/whiteboard/kdm/boardKdmFile.ts` is the file's API:

- `createEmptyBoard` / `createBoardFromRecords` build a new replica (the
  latter for templates: its records are written in the replica's creating
  commit, so a new board from a template starts with nothing to undo).
- `encodeBoardFile` produces the envelope text; `decodeBoardFile` parses it
  back into a writable replica, or reports `unsupported` with reason
  `'version-1'` (an old record-JSON file, recognized but refused) or
  `'not-a-board'` (anything else unreadable).
- `mergeBoardFile` imports another copy's changes (`Replica.importChanges`)
  into an open replica, answering `'merged'`, `'unchanged'`, or
  `'unsupported'`.

`useBoardDocument` opens a file by decoding it into a `BoardStore`; a
version-1 file opens **read-only**, with a notice, and is never migrated or
written back. Saving is guarded: writes pass the file's last-known contents
as `expected` to `writeWorkspaceDocument`, so a write that would clobber a
change made elsewhere is rejected; on that conflict, the document re-reads
the file, merges it with `mergeBoardFile`, and saves again (with a bounded
number of attempts). External changes to the file on disk are merged the
same way, without discarding unsaved local edits. A pending save is flushed
immediately on unmount, on `beforeunload`, and when the open document's path
changes, so no edit is lost to a debounce window.

## Performance rules

The KDM standard (normative in `kition-sdk`) sets four rules that bind how
the whiteboard (and any other KDM-backed document) must be built:

- **Large collections as objects.** A collection that can grow past about
  10,000 entries must be modeled as one object per entry, not as plain
  values inside a single `map` field — import cost into a flat map grows
  with the map's size. This is why whiteboard elements and pages are each
  their own KDM object rather than entries in one JSON blob.
- **Bulk content written at creation.** Bulk content (a file import, a
  generated document, a template) must be written while the document is
  created (`Replica.createWith`), outside undo history — undo bookkeeping
  grows faster than linearly with a transaction's size. `createBoardFromRecords`
  follows this: template records are written in the creating commit.
  `boardKdmFile`'s templates follow the same rule.
- **Bounded interactive transactions.** An interactive transaction should
  touch at most about 10,000 objects; a larger edit should split into several
  transactions or run as an import instead.
- **Bulk work inside the engine.** Bulk work should run inside the KDM
  engine's own code, not be driven object-by-object across the JavaScript
  boundary, which is markedly slower for large batches.

## WebAssembly loading

The KDM runs on `loro-crdt` (a Rust/WebAssembly CRDT engine), version pinned
in `package.json`. `tooling/vite.config.ts` aliases the bare `loro-crdt`
import to `loro-crdt/bundler`: the default browser entry point downloads and
compiles its WebAssembly synchronously on the page's main thread, while the
bundler entry imports the WebAssembly as an ES module, which `vite-plugin-wasm`
fetches and instantiates asynchronously instead — in both development and
built output. `loro-crdt` is listed under Vite's `optimizeDeps.include` so
dev-server pre-bundling can find it even though it is reached only through
dynamic imports, keeping it out of the startup bundle. Vitest keeps Node's
native entry for `loro-crdt` (`tooling/vitest.config.ts` has no such alias).

## Testing pointers

- Unit specs sit alongside the modules they cover:
  `src/features/whiteboard/kdm/boardKdmFile.spec.ts`,
  `boardKdmRead.spec.ts`, `boardKdmWrite.spec.ts`, and
  `src/features/whiteboard/lib/boardStore.kdm.spec.ts`,
  `boardRecordEquality.spec.ts`, `whiteboardAgentPatch.spec.ts`, among others.
- `e2e/helpers/whiteboard.ts` builds `.kiboard` fixtures for Playwright specs
  using the v2 envelope (`encodeBoardFile`/`createBoardFromRecords`) rather
  than hand-built record JSON, so an end-to-end test opens exactly the file
  format the editor itself writes.
