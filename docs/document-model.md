# Markdown documents on the KDM

Every Markdown document the Document feature opens (notes, pages, daily notes, templates'
targets) is also a **Kit Data Model (KDM)** replica: a CRDT document with field-level
transactions, per-author undo, and merge-safe concurrent edits. The `.md` file stays the
interchange format — what Git tracks, what another editor can open, what the agent reads and
writes when no window has the file open — and the replica adds editing history and merge-safe
concurrent edits on top of it, privately, on this machine. This page describes that model and how
the editor, the desktop shell, and the agent read and write it. See
[whiteboard-document.md](whiteboard-document.md) for the Whiteboard's own (differently shaped) KDM
document, [table-document.md](table-document.md) for the Table's (a relational projection of its
KDM replica, rather than a direct view of it), and [kit-sdk.md](kit-sdk.md) for the separate Kit
SDK system; a Markdown document is a built-in document type, not a kit.

## Where the KDM comes from

`@kition/kdm` is not an installed dependency: it is a copy of `packages/kdm/src/*.ts` from the
private `kition-sdk` repository, carried into this repository at `src/lib/kdm/` by
`scripts/sync-kit-host.mjs`. Every file the script writes there starts with a header naming its
source and saying "change it there, not here" — the KDM's contract and implementation are
normative in `kition-sdk`, not in Kition. `pnpm check:kit-host` fails if the copy has drifted.
Nothing under `src/lib/kdm/` is edited by hand; a needed KDM change goes to `kition-sdk` first,
then `node scripts/sync-kit-host.mjs`.

## The `kit.document` schema

`src/features/document/kdm/documentSchema.ts` defines the schema under the kit name
`kit.document`. Its root type is `Document`, with exactly one field:

- **`Document`** — `body`, a KDM `text` field: the whole Markdown file.

Markdown's structure — headings, tables, frontmatter, embeds, tags — stays inside that one text
field, as plain Markdown. The rich editor, the source editor, and every widget the document editor
draws over the Markdown (tables, Mermaid diagrams, math, embeds) are views and edits of the same
text, not a separate structured model; there is no second place a heading or a table's cell could
drift out of sync with the file. This is deliberately unlike the Whiteboard's `kit.board`, whose
elements and pages are each their own KDM object: a Markdown document's one unstructured text field
is what keeps it a plain, portable `.md` file first.

## The file and the replica

A `.md` file's text is the document. `.kition/docs/<docId>/` (under the workspace root) holds a
private, local-only replica of it — its KDM snapshot and metadata — that exists purely to give
Kition editing history, merge-safe concurrent edits, and a stable identity across renames. Losing
that folder loses only history: the next open just imports the file's current text as a fresh
replica. The store's own `.gitignore` keeps `.kition/docs/` out of the workspace's Git history, and
nothing under it is ever shown in the document tree.

The store (`src-tauri/src/workspace/docstore/`) keeps each replica as `snapshot.bin` plus the
changes saved after it, `changes/<seq>.bin`, append-only: a save writes only the changes since the
stored version (`appendDocumentStore`, rule P5), and the snapshot is rewritten only when the change
log is compacted (the store asks after 64 changes or 8 MB, and a closing document compacts). A
manifest, `meta.json`, names every file with its hash, so a crash or a store synced in part reads as
a version that was stored, never a mix; a kit replica's blobs are content-addressed files,
`blobs/<sha256>`. `history.json` is the document's version history on this device: checkpoints at
open, every few minutes of editing, after an agent's edits, on a kit's save, and around a restore,
each naming a replica version. The version history dialog (`src/features/history/`) shows a
checkpoint from the open replica's own history and restores it as one new change (one undo step in
a Markdown document). One Kition writes a workspace's store, the one holding `store.lock` (a
heartbeat that goes stale after two minutes, or at once when its process has ended); another Kition
— a second window, or another device that syncs the workspace — reads the store but writes nothing
to it, and says so. Stores of the earlier layout (one `snapshot.bin` and one `blobs.bin`) stay
readable and are migrated by the writer, keeping the old files until the new layout reads back the
same.

`src/features/document/kdm/documentText.ts` is the text side of this: `analyzeText` reads a file's
raw text into the replica's normalised form (`\n` line endings, no byte order mark) plus a
`LineStyle` recording how to write it back (`eol`, `bom`, `finalNewline`); `renderText` is the
inverse. `createDocumentReplica` builds a new replica from a file's text in its **creating commit**
(`system('create')`, `Replica.createWith`), so importing a file is never itself an undo step. The
body is inserted in pieces of about 16 KB (`BODY_PIECE`), **last piece first**: the engine would
otherwise join everything appended in one run into a single element, and an edit inside a large
element costs time proportional to the whole element's length (worse still for non-ASCII text);
inserting the pieces in reverse order keeps them separate elements in the replica and in its
snapshots, so a later edit near the end of a large document stays cheap.

## Opening a document

`openDocument` (`src/features/document/kdm/documentStore.ts`) is the whole open path, driven by a
path-to-document-id **index** (`.kition/docs/index.json` by way of
`src/services/desktopClient/documentStore.ts` and, on the desktop,
`src-tauri/src/workspace/docstore.rs`):

- **A known path.** The index has a `docId` for the path: the stored replica is loaded
  (`Replica.load`). If the file's hash matches what the replica last saved, nothing more happens.
  If it differs — the file changed since this machine last wrote it (another tool, another
  machine's copy, Git) — the stored replica's text is the three-way merge's base and the file's
  current text is merged into it (`mergeExternalText`, below), then the merged replica is stored
  again.
- **A path renamed or moved outside Kition.** If the index has no entry for the path,
  `recogniseRenamed` looks for another index entry whose file no longer exists in the workspace and
  whose last-saved file hash equals this file's hash; if it finds one, it rebinds that document id
  to the new path instead of treating the file as new. It compares the stored hash before loading
  any snapshot, and it takes the workspace's files from the app's tree (`noteWorkspaceFiles`)
  instead of listing the workspace on every open; a match the tree suggests is confirmed against a
  fresh listing before it is taken. (A rename done inside Kition's
  own file tree does not need this: it is tracked directly, see Identity below.)
- **Anything else (a genuinely new file, or a store that could not resolve it).** The file is
  **imported** as a new replica (`createDocumentReplica`) and recorded in the store and the index.

Every store failure — a damaged entry, an unexpected error — degrades to importing the file again
(a fresh replica, no history) rather than ever failing to open or blocking a read or a write: the
`.md` file is the document, and the store only adds history on top of it. The one failure that does
not degrade this way is the workspace having switched to another folder while the open was in
flight (`DESIGN_WORKSPACE_CHANGED`): that is reported as a failed open rather than silently losing
history, since importing fresh under the wrong workspace root could not be saved safely anyway.
Opening a `DocumentSession` without a known workspace root is refused outright for the same reason.
Because a file can change on disk in the moments between the editor reading it and the session
finishing its open, `DocumentSession.start` reconciles against the file once more right after
opening, so a change made while the document was opening is not missed until the next external-change
event.

## Editing

Each open Markdown document is one `DocumentSession`
(`src/features/document/kdm/documentSession.ts`), registered by workspace path in
`src/features/document/kdm/documentSessions.ts` for as long as its tab stays open (even in the
background) — so its replica and undo history survive switching tabs and remounting the editor.
Within a session there is exactly **one replica**; every editor view bound to it gets its own
`TextBinding` (`src/features/document/kdm/codeMirrorBinding.ts`), tracked in the session's
`bindings` set, so a split view or a remounted pane never duplicates the document's state — only
the view.

**Local edits, minimised.** A `TextBinding` publishes a local CodeMirror transaction as one KDM
transaction with the session's `typingOrigin` (`person('user:local', 'typing')`). `applyChangeSet`
does not simply replace whatever range CodeMirror reports: `minimalEdits` first cuts each replaced
range down to its common prefix and suffix, then diffs what is left with `diffText`'s line-and-character
diff. This matters because CodeMirror commands and widgets routinely rewrite a whole line, a whole
table, or the whole document even when only a little of it actually changed; minimising keeps the
KDM transaction — and so what has to merge with anyone else's concurrent edit — down to the part
that really differs.

**Other changes arrive as CodeMirror changes.** Everything that is not this editor's own local
transaction — another editor's binding, an agent's edit, a merged external change, undo/redo — is
delivered back to each bound editor as an ordinary CodeMirror change set, annotated
`replicaChange` (so other extensions, and CodeMirror's own history, can tell it apart from typing)
and kept out of the browser's native undo stack. While an IME composition is under way, or while
the editor is mid-update, those changes are held back (`pending`) and flushed right after, so they
never interrupt a composition or a dispatch in progress; a local edit made meanwhile is still
published at the position it lands at once the pending changes are accounted for.

**Undo lives in the replica, not in CodeMirror.** `documentHistoryExtension`
(`src/features/document/kdm/documentHistory.ts`) replaces CodeMirror's `history()` entirely: Mod-Z
and Mod-Y/Mod-Shift-Z run the replica's `undo()`/`redo()` instead. This is also why the desktop
shell's own Edit ▸ Undo and Redo (and a context menu's, or `execCommand('undo')`) work correctly on
a bound editor: the browser delivers those as `beforeinput` events with `inputType`
`historyUndo`/`historyRedo`, which would otherwise let the browser mutate the editor's DOM content
directly (behind CodeMirror's back) and have the result published as if it were typed; the history
extension intercepts those events and runs the replica's undo and redo instead, so native undo and
the in-app shortcut always do the same thing.

Typing groups into undo steps the way CodeMirror's own history would: `DocumentSession.beforeLocal`
opens the replica's undo group (`beginUndoGroup`) on the first keystroke of a run and keeps
extending it while keystrokes of the same kind (typing or deleting) keep arriving within
`TYPING_GROUP_MS` (500 ms); a pause, a change of kind, or an **isolated** transaction ends the
group. An isolated transaction (`isolateHistory` — the translation card's replace-with-translation
edit is one) always gets its own undo step, never merged into an adjoining typing run. Not every
replica change is a typing-origin transaction with its own place in undo history at all: imports
(`FILE_IMPORT_ORIGIN`, `{ kind: 'import', principal: 'file' }`, for merges of external file changes)
and `system`-origin transactions (document creation, the save-time rewrite described below) are
excluded from the undo stack by the KDM engine itself — undo skips them like it skips another
replica's changes, and they are never themselves undone.

## Saving

Saves are debounced 300 ms (`SAVE_DELAY_MS`) after a replica change. `saveDocument`
(`documentStore.ts`) takes the text, the replica's snapshot, and its version **together, before
anything is awaited** — specifically before the guarded file write — so that an edit made while that
write is in flight is never folded into what gets recorded as "saved": it stays unsaved and keeps
its own place in the save queue, and discarding the session's pending edits afterwards cannot
resurrect it from the store. The write itself is guarded: it passes the file's last-known contents
as `expected_content`, so a write that would clobber a change made elsewhere since this session
last read or wrote the file is refused (`DESIGN_SAVE_CONFLICT`) rather than overwriting it. On that
conflict the session re-reads the file, merges it into the replica (as below), and writes again, up
to three attempts (`MAX_SAVE_ATTEMPTS`); a failed save (including the store write afterwards)
retries with backoff (1 s, 2 s, 4 s), and a new edit resets the retry count.

Before every write — including the final write a closing session makes, not only the first attempt
of a save run — the host may rewrite the text (`prepareSave`): the one real use today turns
temporary `blob:` image links pasted into the document into workspace asset links. That rewrite is
applied as a three-way merge against whatever the text has become since it was read (so typing done
while the rewrite itself is running is kept, not clobbered) and under a `system` origin, which is,
as above, not an undo step — undoing after a paste must never bring the temporary `blob:` link back.

`flush()` resolves once every edit made before the call is in the file; it is what `Mod-S`, closing
a tab, a workspace flush, and `beforeunload` all call. Closing a document tab waits for its flush;
if it rejects, a confirmation dialog asks whether to close and discard the changes that could not
be saved, or to keep the tab open with its pending edits and retries. Discarding (`discard()`) stops
saving and retrying for good and leaves the file exactly as it is; a write already in flight when
discard is called is not retried, but is also not undone.

If the open document's file is deleted (or moved away) outside Kition, the session notices — the
`unlink` event, or a save whose conflict read finds no file — stops saving and retrying, and says so
with a **Save to recreate** action. That save expects no file at the path (`expected_missing`), so a
file that appeared meanwhile is merged first rather than overwritten; a file that comes back on its
own is simply followed again.

## External changes

When the workspace reports a change to an open document's file (another program, Git, a sync tool),
the session **merges** it rather than ever overwriting local edits in either direction:
`mergeExternalText` (`src/features/document/kdm/documentMerge.ts`) three-way merges `base → incoming`
(the file's last-known text to its text now) into `current` (the replica's text, which may already
hold local edits made since `base`): base text survives where neither side touched it, every
insertion from both sides is kept (the local one first where both insert at the same place), and an
external edit of a range also edited locally inserts next to the local edit rather than clobbering
it. A change made identically on both sides (for example, two machines saving the same edit) is
applied only once. The same merge path is used for the conflict retry during a save, for a change
noticed by the external-change watcher, and for the merge an open does when the file's hash no
longer matches what was last saved.

The diff underneath (`diffText`) is a line diff refined to characters: lines are matched by
"patience diff" — lines that occur exactly once on both sides anchor the diff, splitting it into
smaller pieces around them — with a bounded Myers diff filling in gaps that have no such anchor, so
cost grows with the amount of change rather than the size of the files. Character-level detail
inside a changed line is itself budgeted (`REFINE_WORK`, `REFINE_MAX_LENGTH`) so that a single very
long or heavily rewritten line falls back to a whole-line replacement instead of an expensive
character diff.

A file whose line endings cannot be reproduced exactly on export — a mix of `\n` and `\r\n`, or a
lone `\r` — is left alone: opening or merging such a file does **not** mark the document dirty or
rewrite it into the normalised style just because it was read. Only an actual edit saves the file,
at which point it is written in the normalised style going forward (see Line endings and BOM
below).

## Agent edits

An agent's edit to a document that a Kition window has open **goes live**, through the document
bridge, instead of landing later as an external file change:

- The renderer side, `src/features/document/kdm/documentAgentBridge.ts`, shares the Kit AI bridge's
  stream. Each open `DocumentSession` registers itself (`registerOpenDocument`); the window
  announces its open paths with a `documents.open` notification and answers two requests on the
  stream: `document/read { path }` (the live text, unsaved edits included, or "not open") and
  `document/apply { path, content, tool, turnId? }` (applies the agent's whole new text and saves
  it, answering the saved file content, or why it did not apply).
- The runtime side, `crates/kition-kits/src/document_bridge.rs`, is the transport (`Bridge::document_window`,
  `read_document`, `apply_document`, with a 3 s read timeout and a 10 s apply timeout); the agent
  tool side, `crates/kition-agent/src/tools/live_documents.rs`, decides *whether* to use it:
  `is_live_candidate` restricts it to `.md`/`.markdown` paths, and `LiveDocuments::write` tries the
  window that has the path open (the newest, if several announce the same path) before falling back
  to writing the file directly.

Inside the window, `DocumentSession.applyAgentContent` applies the agent's whole new text as the
smallest diff from the current text, in **one `agent`-origin transaction** (so it is one undo
step), marks it for review, and saves it — the person sees the agent's edit appear in the text at
once, already highlighted, exactly as if it had just been typed by someone else sharing the
document. Several agent edits before a decision grow the same review rather than starting a new
one each time. The review (`DocumentAgentReview`, `src/features/document/kdm/documentAgentReview.ts`)
tracks what was added and removed, remapped through every later change to the text (typing, a
further agent edit, a merge) so the highlights never drift; `DocumentAgentReviewBar`
(`src/features/document/components/DocumentAgentReviewBar.tsx`) sits above the editor with **Accept**
(keep it), **Reject** (take the edit back three-way, keeping anything typed since — or, when
nothing else touched the text, an exact `undo` of the agent's steps), and **Review changes**, which
opens the full change-by-change panel (`DocumentRevisionReview.tsx`, built on the same word-level
comparison, `createDocumentRevisionComparison`, used elsewhere for document revisions) to accept or
reject individual changes rather than the whole edit.

When no window has the document open, or the window's session refuses or does not answer in time,
the agent falls back to writing the file directly (atomically, on the runtime side), recording why
(`Delivery::fallback`) in the tool's result. If a session for that document exists but was not the
one that answered — or the document was closed at the time and is reopened later — the next open
merges that file change in like any other external edit, and, if the path was already flagged
modified by the agent, offers it for review through `reviewOpenMerge()`: the merge's "before" text
is recorded (`OpenedDocument.previousText`) specifically so a change made while the document was
closed can still be shown as something to accept or reject, not just a reload.

## Identity

A document's identity is its KDM document id (`docId`), kept on its workspace path by the
`.kition/docs/index.json` index, independent of the file's content. `src/features/workspace/lib/documentIdentity.ts`
keeps that index in step with tree operations, best effort (a store failure is logged and never
blocks or undoes the file operation that triggered it):

- **Rename or move inside Kition** (`renameDocument`/`renameDocumentFolder`) rewrites the index
  entry (or every entry under a moved folder) to the new path, including a file's child pages — a
  folder named after the file without its extension, which moves with it.
- **Rename or move outside Kition** (the terminal, another editor, Git) leaves a stale index entry;
  the next open recognises it by content hash (`recogniseRenamed`, above) rather than losing
  history.
- **Delete** (`forgetDocument`/`forgetDocumentFolder`) moves the index entry (and the file's child
  pages') to a deleted path under `.kition/docs/deleted/`, keeping the stored replica: a file
  restored (or moved back) meanwhile is still recognised by its hash. The first workspace open in a
  window prunes the store (`pruneDocumentStoreOnOpen`): replicas of deleted documents are deleted,
  and entries whose files went away outside Kition are kept for one more open before they go.
- **Duplicate** (`duplicateDocumentIdentity`) gives the copy no index entry at all, so opening it
  imports a fresh document id: two files never share one document's identity, even right after a
  copy.

`DocumentSession.setPath` and `remapDocumentSessions` (`documentSessions.ts`) move an *open*
session's registration, its flush registration, and its agent-bridge registration to the new path
when a rename happens while the tab is open, without touching the replica itself.

## Cross-file writers go through open sessions

Kition's own other writers of Markdown files — tag rename, creating a note from a wikilink, daily
notes, the document properties dialog — never write a `.md` file out from under an open tab.
`readWorkspaceMarkdown`, `writeWorkspaceMarkdown`, and `updateWorkspaceMarkdown`
(`documentSessions.ts`) check the session registry first: when the path is open, the read is the
session's live text and the write is one more undoable, origin-labelled edit of the replica (which
the session then saves normally); only a path with no open session is read or written as a plain
file. A result made from an earlier text — the properties dialog edits the text it opened on, an
agent edit's review starts from the text after the edit — is applied with
`DocumentSession.applyFrom(base, next, origin)`, a three-way merge onto the text as it is now, so
changes made meanwhile are kept.

## Line endings and BOM

A file's line ending style and leading byte order mark are never part of the replica's text — the
replica always holds `\n`-terminated, BOM-free text — and are instead carried alongside it as a
`LineStyle` (`eol`, `bom`, `finalNewline`, and `mixedEol` for a file that mixes styles), restored
whenever the file is written (`renderText`). A file using `\r\n` throughout, or starting with a BOM,
round-trips byte for byte through edits and saves. A file whose line endings cannot be reproduced
exactly — a mix of conventions, or a lone `\r` the exporter cannot encode — is, as noted under
External changes, left exactly as it is until a real edit changes it; opening or merging such a
file never itself triggers a rewrite into the normalised style, only a later edit does.

## Performance notes

A keystroke and a save are both fast at every document size the project measures against (see
`documentKdm.bench.spec.ts`): a keystroke is one minimised KDM text edit, and a save is rendering
the replica's text plus taking its snapshot. What dominates cost at scale is not the diff — both the
line diff and its character refinement are bounded (patience diff plus a capped Myers fallback, a
refine budget, a maximum line length for character detail) so their cost grows with how much
changed, not with the size of the files — it is the **engine applying many small operations** for a
large, scattered merge (many short edits spread across a big document cost more than one big edit of
the same total size, because each is its own KDM operation). `mergeExternalText` accepts an opt-in
`MergeOptions.coalesce` that joins edits separated by only a little unchanged text into one larger
edit above a given edit count, trading a slightly coarser merge (a concurrent edit of another
replica inside the joined span, or a person's undo reaching into it, no longer finds exactly what it
expects there) for fewer, larger operations on a merge that would otherwise produce a great many
tiny ones.

## WebAssembly loading

The KDM runs on `loro-crdt` (a Rust/WebAssembly CRDT engine). `tooling/vite.config.ts` aliases the
bare `loro-crdt` import to its bundler entry point so `vite-plugin-wasm` fetches and instantiates
the WebAssembly asynchronously (in both development and built output) instead of the default
browser entry's synchronous, main-thread load; see [whiteboard-document.md](whiteboard-document.md#webassembly-loading)
for the detail, which is shared by every KDM document type in this repository.

## Testing pointers

- Unit specs sit beside the modules they cover:
  `src/features/document/kdm/documentText.spec.ts`, `documentMerge.spec.ts`,
  `codeMirrorBinding.spec.ts`, `documentStore.spec.ts`, `documentSession.spec.ts`,
  `documentAgentBridge.spec.ts`, and `documentAgentReview.spec.ts`.
- `documentKdm.bench.spec.ts` is a manual, opt-in benchmark
  (`KITION_DOC_BENCH=1 pnpm vitest run --config tooling/vitest.config.ts src/features/document/kdm/documentKdm.bench.spec.ts`),
  not a correctness test: it measures import, open, a real keystroke, a paste, an external merge
  (with and without coalescing), save, and undo across realistic 100 KB, 1 MB, and 5 MB documents,
  and prints its numbers rather than enforcing them.
- `crates/kition-kits/src/document_bridge.rs` and `crates/kition-agent/src/tools/live_documents.rs`
  each have their own async tests of the bridge's request/response shape and the live-vs-fallback
  decision, independent of a real renderer window.
- `e2e/helpers/markdownDocument.ts` installs an in-memory mock desktop bridge that behaves like the
  real one byte for byte (exact line endings and BOM preserved, guarded writes refused on conflict,
  external-change events raisable on demand, write counts and failures injectable);
  `e2e/helpers/documentStore.ts` adds the matching in-memory `.kition/docs/` replica store
  (document id and index-path validation, the index version guard, the workspace-root check); and
  `e2e/helpers/documentBridge.ts` plays the runtime's end of the agent document bridge
  (`GET /v1/kits/bridge` as server-sent events, `POST /v1/kits/bridge?session=` for answers) so a
  spec can simulate the agent editing an open document without a real agent run.
  `e2e/document-persistence.spec.ts` uses these to cover saving typing, merging a file change made
  on disk with unsaved typing, keeping a CRLF-with-BOM file byte for byte, keeping a document's
  identity across a rename, saving on tab close, the discard-on-repeated-save-failure dialog, undo
  after a reload, and the desktop shell's native Edit ▸ Undo/Redo running on the replica rather than
  as typing.
