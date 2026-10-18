# The Table on the KDM

Every `.kitable` file is also a **Kit Data Model (KDM)** replica: a CRDT document with
field-level transactions, per-author undo, and merge-safe concurrent edits. Unlike the Markdown
document's one text field or the Whiteboard's direct view of its replica, the Table's relational
tables (`kition_tables`, `kition_fields`, `kition_records`, ...) — what the rest of the runtime
and the editor actually read — are a **projection** of the replica, kept in the same SQLite file
and rebuilt from it whenever it changes. This page describes that model: the replica's shape, how
it is stored and projected, who writes it and under what origin, the runtime API and the events
it publishes, and what happens to a file the KDM does not (yet, or any more) recognize. See
[document-model.md](document-model.md) and [whiteboard-document.md](whiteboard-document.md) for
the other two KDM-backed document types, and [kit-sdk.md](kit-sdk.md) for the separate Kit SDK
system; the Table is a built-in document type, not a kit.

Unlike the other two, the Table's KDM is implemented directly in Rust (`crates/kition-kdm`,
`crates/kition-kitable`), not carried in from `kition-sdk` by `scripts/sync-kit-host.mjs`: the
runtime is the only writer that needs it, since the editor talks to the runtime's HTTP API rather
than opening the replica itself.

## The `kit.table` schema

`crates/kition-kitable/src/kdm/kit-table.schema.json` defines the schema under the kit name
`kit.table`. Its root type is `Base`, the whole document:

- **`Base`** — `title`, `description`, `icon`, `color`, `meta` (json), and ordered lists of
  `tables` and `dashboards`.
- **`Table`** — `name`, `title`, `description`, `meta`, a `primaryField` reference, and ordered
  lists of `fields`, `views`, and `records`.
- **`Field`** — `name`, `title`, `type`, `required`, `readonly`, `options` (json), `formula`,
  `aiPrompt`, `meta`.
- **`View`** — `type`, `title`, `locked`, `config` (json — the filter tree, sorts, groups, and
  per-field layout, as one opaque value), plus `widths` and `hidden` maps keyed by field.
- **`Record`** — `cells` (a map keyed by field object id, not name, so a field rename never
  touches a record), `createdAt`, `createdBy`.
- **`Link`** — `from` and `to` record references and a `field` reference, one object per link
  between two records: a record's `link_to_record` chips are the `Link` objects that name it,
  not a list on the record, so concurrent link edits merge as a set rather than conflicting over
  one list.
- **`Dashboard`** — `name`, `config` (json), and a `widgets` map.

Object ids are UUID v7 (creation-ordered), except a record's, which is its `row_key` — already
the shape the relational `kition_records.row_key` column used before the KDM, kept as the
record's object id so a migrated file does not have to rewrite every reference to a record.
Options and dashboard configs name tables and fields by relational integer id in the SQL API
(`target_table_id: 3`) but by KDM object id inside the replica (`target_table: "<object id>"`,
without the `_id` suffix); `crates/kition-kitable/src/kdm/options.rs` converts between the two —
integer ids are local to one SQLite projection, so the replica cannot use them.

A field's value is either **stored** (in `Record.cells`, keyed by the field's object id) or
**derived**: `formula`, `lookup`, `rollup`, `link_to_record`'s display value, `auto_number`,
`created_time`/`last_modified_time`, and `created_by`/`last_modified_by` are never written to
`cells` at all (`kdm::model::is_computed`) — they are computed by the projector (below) every time
something they depend on changes, the same way a spreadsheet recomputes a formula cell rather than
storing its last answer.

**Circular references are refused** at the point a field's own definition would create one:
creating or editing a formula, lookup, or rollup field that would depend on itself through the
document's other fields' dependencies is rejected (`KitableError::Invalid`, "circular reference";
`kdm::model::check_acyclic`), the way a spreadsheet refuses a circular formula. A **migration**
from a legacy schema-3 file reproduces the source exactly, circular references included — such a
file could already hold one, from before this check existed — so the projector's derivation
(`kdm/project/derive.rs`) also tolerates a cycle it is handed: the `(record, field)` pairs on one
read every other field of their own cycle as missing, which keeps their values bounded instead of
looping, while every field outside the cycle still recomputes normally.

## Storage: the file and the replica

A `.kitable` file is a single SQLite database. Two tables hold the replica itself
(`crates/kition-kitable/src/kdm/store.rs`):

- `kition_kdm` — one row, the replica's compacted snapshot (`Replica::snapshot()`) plus a
  generation counter and an `epoch` (a random value replaced on every write, so two independently
  written copies at the same generation and sequence can still be told apart).
- `kition_kdm_changes` — an append-only log of every change since that snapshot, one row per
  `append` call, in increasing `seq` order. Opening a file loads the snapshot, then imports every
  change row in order (`store::load`); if anything is still pending afterwards the log is
  considered broken (`KitableError::Kdm`) rather than silently opened with gaps.
- **Compaction** folds the log back into the snapshot (`store::compact`): write the current
  snapshot, bump the generation, delete every change row. A commit compacts automatically once the
  log passes 500 rows or 1 MiB (`store::should_compact`); nothing but size triggers it.

The relational tables (`kition_tables`, `kition_fields`, `kition_views`, `kition_records`,
`kition_record_links`, plus normalised view configuration and history) are the **projection**: what
the HTTP API, the legacy SQL reads, and the editor actually query. Every live row keeps a `kdm_id`
(or, for a record, its `row_key`) linking it back to the object that produced it. A write inside
the runtime always does both in one SQL transaction — append the replica's changes and project them
— so a crash or a failed write leaves the file exactly as it was, never the replica and the tables
disagreeing (`kdm/commit.rs`, `kdm/project.rs`).

## Projection and derived values

`kdm/project.rs`'s `project_changes` takes the set of objects a transaction, an import, or a merge
changed (as `Replica::take_changed` reports them) and writes only the relational rows that need to
change: a table's own row for a rename or reorder, a record's row for a cell change, history rows
for each stored cell that changed. Integer ids are stable across projections — a row is matched to
its object by `kdm_id`/`row_key` and keeps its id; an object an undo brings back revives its old
row rather than getting a new one. `rebuild` instead projects the *whole* replica, used after a
migration and after a merge that could have left the incremental path unable to tell what changed
cheaply.

Derived values are recomputed in dependency order, not just for the record that changed:
`derive.rs` seeds the records a change touched, follows the links and formula/lookup/rollup
references back to whatever reads them, and processes the resulting graph in dependency order
(each record once, only when something it actually reads changed) so a lookup, a rollup, or a
link's display chip is never left stale after a merge touches a record three tables away. A field
type the legacy code never derived (`auto_number`, the created/modified stamps) still has none —
projection does not newly invent values the relational model never computed.

Two parts of a view's configuration are **not** part of the replica: the normalised
`kition_view_filter_groups`/`kition_view_filter_conditions`/`kition_view_sorts`/`kition_view_groups`
tables are plain SQLite, kept in sync with a view's `config` JSON one way
(`crates/kition-kitable/src/view_config.rs`) but never read back into the KDM or merged by it —
only the opaque `config` value on the `View` object is real, mergeable replica state. This is a
known limitation (below), not an oversight: those tables exist so the relational API can query a
filter or sort efficiently; round-tripping them into the replica field-by-field was not worth the
complexity for state that is, in practice, written by one person's view settings at a time.

## Origins and undo

Every mutation is one KDM transaction carrying an `Origin` (`crates/kition-kdm/src/origin.rs`):
who made it, and whether it counts as an undo step at all.

- **`person:session:<uuid>`** — a window's own edit, from its `Kition-Session` header.
- **`agent:run:<id>`** (or `agent:<turnId>` as the transact/table-changed contracts name it) — the
  AI agent's tools (`crates/kition-agent/src/tools/tables.rs`).
- **`system:<writer>`** — a write nothing undoes: `workflow` and `formsync` (a workflow action or
  a connected form creating or updating a record), `emailsync` (an inbound email captured as a
  record), `aifield` (an AI field's computed answer), `scenario` (template/scenario seeding),
  `template` (initial seeding before any session exists), `storage` (workspace storage
  maintenance), `repair` (post-merge invariant fixes), `migrate` (the schema-3 migration), and
  `view-width` (a column width change — deliberately excluded from undo so resizing a column
  never shows up in anyone's undo history).
- **`import`** — changes merged in from another copy of the file (below).

Undo covers **person** and **agent** transactions — data, schema, and view changes, but not
column widths — grouped the way the caller asks: `KitableFile::transact` is always one change row
and one undo step regardless of how many ops it carries (a 1,000-cell paste is one step, not
1,000), and `begin_undo_group`/`end_undo_group` lets a caller fold several separate `transact`
calls into one step (the Agent's tools wrap a whole tool call's writes this way). `system` and
`import` transactions are excluded from undo entirely — undo skips them like changes from another
replica, and they are never themselves undone — which is also what keeps a workflow's write out of
a person's undo stack even though it lands through the very same shared file handle a person's
window is using.

Undo and redo live only as long as the `KitableFile` handle that made the edits stays open: they
are not restored from the file on a later open (see Limits, below).

## The runtime: one handle per file

`crates/kition-datadoc/src/table_documents.rs`'s `TableDocuments` keeps one shared `KitableFile`
per absolute path, behind a lock, reused by every caller — HTTP routes, the Agent, email/form
sync, workflows — instead of each opening its own SQLite connection and racing the others on
`SQLITE_BUSY`. A `TableHandle` is the lock held for as long as a caller needs it; it sets the
file's origin on checkout and restores `system:unknown` on drop, so a leftover handle can never be
mistaken for a person's session. Because every writer goes through the same handle, a write one
caller makes is visible to the very next read any other caller makes on the same file — including
an already-open window's handle — with no extra staleness to account for.

### HTTP API

- `POST /v1/data-documents/{id}/transact` — applies a list of ops
  (`contracts/runtime/data-documents-transact.schema.json`: `cells.set`, `records.create`,
  `records.delete`, `records.move`, `fields.move`) as one transaction, answers the created row
  keys and the resulting `TableChange`.
- `POST /v1/data-documents/{id}/undo` / `/redo` — undo or redo this handle's last step.
- `GET /v1/data-documents/{id}/history-state` — whether undo/redo have anything to do.
- `GET /v1/data-documents/{id}/dashboards`, `PUT`/`DELETE
  /v1/data-documents/{id}/dashboards/{dashboardId}` — dashboards live in the document (the `Base`'s
  `dashboards` list), not beside it, so copying or syncing the file keeps them.

A successful `transact`/`undo`/`redo` both answers its `TableChange` to the caller and publishes it
as a `table/changed` notification on the kit bridge stream (`GET /v1/kits/bridge`,
`contracts/runtime/table-changed.schema.json`), so every other open window picks up the same
change; a window ignores the echo of its own request by comparing `origin` to its own session.
`useTableLiveChanges` (`packages/table-editor/src/table/ports/`), `useTableHistory`
(`packages/table-editor/src/table/hooks/`), and `tableLiveChangeDispatch.ts` are the editor's side of this: a
`table/changed` naming the table it has open triggers a records refetch (or a schema/view refetch,
or a dashboards refetch, depending on what changed), and undo/redo are server calls, not a
client-side history stack.

The editor (table and dashboard) lives in the `@kition/table-editor` package
(`packages/table-editor/`, see `packages/README.md`) and reaches all of this only through two
interfaces in `packages/table-editor/src/table/ports/`, provided by React context at its root:

- `TableDataSource`: the document requests, named and shaped as `kition-table-api`'s `METHODS`
  (`records.list`, `fields.create`, `transact`, `undo`, `historyState`, `dashboards.upsert`, …;
  params are the route's ids, query values, and body fields), plus `documents.get`/`open`/`list`
  and `onChange` for changes made elsewhere. Kition's is `httpTableDataSource`
  (`src/features/table/host/`): the routes above and `table/changed`, without this window's own
  echoes.
- `TableHost`: the app services the editor uses besides its data (attachment URLs and upload,
  image copy, CSV save, toasts, file import, AI fields, design from a record). Every member is
  optional; without one the editor hides what needs it. `locale()` sets the locale dates format
  with. Kition's is `kitionTableHost`.

`KitionTableProviders` gives the editor both (`TableEditorPane`, `DashboardEditorPane`, the scenario
build page, the workspace's file import dialog). `src/features/table` keeps only Kition's side:
`host/`, opening the editor in a tab, table creation from templates, and file import into a new
table. The `packages-import-nothing-from-the-app` rule in `tooling/dependency-cruiser.cjs` keeps
the package off everything in `src/`, and `app-uses-table-editor-entries` keeps the app on the
package's entries.

A workflow or form-sync write (`create_record_for_workflow`/`update_record_for_workflow`,
`crates/kition-datadoc/src/workflow_api.rs`) publishes `table/changed` too, alongside the
`RecordCreated`/`RecordUpdated` event that drives `record.created`/`record.updated` workflow
triggers: an already-open table shows a workflow's new row immediately, the same as it would show
another person's edit, rather than only on its next manual reload.

## Migration and read-only fallback

A file written before the KDM (schema version 3, relational tables only) is migrated the moment it
is opened (`KitableFile::open` → `migrate::upgrade`, `kdm/migrate.rs`): the replica is built from
the relational tables in one creating commit (`system:migrate`, not an undo step), every live
table/field/view/link row is stamped with the `kdm_id` that now identifies it, and schema version 4
is recorded, all inside one SQL transaction — a failure anywhere leaves the file exactly as it was,
schema 3, to try again next open. Tables, fields, and views get fresh object ids on migration; a
record's object id is its existing `row_key`. Two independently migrated copies of one schema-3
file become two different KDM documents (migration mints new ids), so they are never later treated
as the same document for merge purposes.

A file that cannot be migrated — a write failure, or (on a read-only mount or read-only
permissions) a file that simply cannot be written — opens **read-only**: `KitableFile::read_only()`
names why, every write is refused (`KitableError::ReadOnly`), and reads come from an in-memory
replica built straight from the relational tables rather than ever touching the file. The HTTP
layer surfaces this as `409 Conflict`, not `400 Bad Request`: the request was fine, the document
just cannot take writes right now.

## External changes

`.kitable` files are not limited to the runtime's own shared handle: a sync tool, Git, or another
machine's copy can replace the file on disk — in place, or atomically (a new inode at the same
path, as an edited copy swapped in with a rename would leave it). `KitableFile::changed_on_disk`
compares the file's current identity (inode, size, modification time) against what the handle last
saw; `reopen_merging` (`kdm/commit.rs`) is what the manager calls when it differs:

- The same document, with changes the handle lacks: those changes are imported
  (`Replica::import_changes`) under an `import` origin and repaired (`kdm/repair.rs` — orphaned
  rows, a merge's colliding names), then reprojected. Changes the handle has that the file lacks
  (the file was replaced by an older copy) are reprojected the other way, as if every live record
  were new.
- **Another document entirely** (a different `docId` at the same path): the handle switches to it
  wholesale, and the HTTP layer answers `409 Conflict` — "Data document file was replaced on
  disk" — rather than silently merging two unrelated documents.
- **No actual difference** (an identical copy, or a copy with changes this handle already had):
  nothing is imported.

A merge the manager performs is published as `table/changed` attributed to `Origin::system`'s
`external` label, since whoever wrote the file is not the request's caller
(`crates/kition-datadoc/src/source.rs`'s `open_document_as`) — this is the one case where a write
that is not a person's or an agent's still reaches an open window live, because the window needs
to know its on-disk file moved out from under it regardless of who moved it.

## Limits and known follow-ups

- **Link chips can't be reordered.** A `Link` object has no position of its own — a record's
  `link_to_record` chips show in the order their `Link` objects were created (object ids are
  creation-ordered UUID v7), which concurrent merges from two replicas may interleave differently
  on each side. Giving links an explicit order is future work.
- **Normalised filter/sort/group tables are SQLite-only.** As under Projection, above: a view's
  `config` is the real, merge-safe replica state; the relational filter/sort/group tables built
  from it are a one-way, SQLite-only convenience for the query side and are not themselves part of
  the KDM document.
- **The first undo on a handle costs more than later ones.** Undo and redo exist only for the
  life of the `KitableFile` handle that made the edits (above) — but even within one handle's
  life, the first `undo()` call costs measurably more than the next one on the same handle (see
  the benchmark below): the KDM engine's undo manager does work on its first undo that grows with
  the document. A long-lived handle (an editor window left open, a long agent run) pays this once;
  a workload that opens a fresh handle per undo would pay it every time. After it, undo, redo, and
  importing a peer's changes cost what they change plus a read of the base's and tables' lists:
  the repair after them (`kdm::repair::run_since`) covers only what the change touched, relying on
  the state before it being repaired already, and keeps the document's bases and links in an
  index carried from write to write instead of scanning every object.

## Benchmark

`crates/kition-kitable/tests/kdm_bench.rs` is a manual, opt-in benchmark (`#[ignore]`), not a
correctness test — like `documentKdm.bench.spec.ts` on the Markdown-document side. It measures
open, a first open that also migrates a schema-3 file, one cell edit, a 1,000-cell paste, undo
(first and a later call), redo, importing one cell edit of a peer replica, compaction, and a full
rebuild, at 10,000 and 100,000 records (10 fields; `KDM_BENCH_SIZES=10000,50000` picks other
sizes), and prints its numbers rather than enforcing them:

```sh
cargo test --release -p kition-kitable --test kdm_bench -- --ignored --nocapture
```

Representative numbers from a development machine, release build (a shared or loaded machine will
read higher; treat these as shape, not a guarantee):

| records | open | open + migrate | edit | 1k-paste | undo 1st | undo 2nd | redo | import | compact | rebuild |
| ------- | ---- | -------------- | ---- | -------- | -------- | -------- | ---- | ------ | ------- | ------- |
| 10,000 | ~25 ms | ~310 ms | ~20 ms | ~50 ms | ~55 ms | ~8 ms | ~8 ms | ~8 ms | ~25 ms | ~560 ms |
| 100,000 | ~490 ms | ~3.7 s | ~270 ms | ~230 ms | ~900 ms | ~120 ms | ~90 ms | ~85 ms | ~250 ms | ~6.6 s |

Against this phase's budgets at 10k (open under 1.5 s, an edit under 16 ms, a 1,000-cell paste
under 100 ms): open and the paste are comfortably inside budget; a single cell edit measured
somewhat over the 16 ms budget on this machine. Compaction and rebuild scale with the document's
total size; so does the first undo on a handle (above). Before the incremental repair, every undo,
redo, and import ran a full repair pass, about 0.9 s at 50,000 records on its own.

## Testing pointers

- Unit and integration tests sit beside or alongside the modules they cover:
  `crates/kition-kdm/tests/*.rs` (the engine itself), `crates/kition-kitable/tests/kdm_*.rs` (the
  file format, the migration, the projector, the store), and
  `crates/kition-datadoc/tests/{transact_routes,dashboard_routes,kdm_e2e}.rs` (the HTTP routes,
  the shared manager, and the `table/changed` event, together).
- `crates/kition-datadoc/tests/kdm_e2e.rs` covers, end to end across the route, manager, and event
  layers, the three behaviors the real runtime is impractical to drive from Playwright for: a
  workflow-created record reaching an already-open table live, an agent run's grouped writes
  collapsing into one undo step, and replacing the file on disk with an edited copy (a new inode
  at the same path) merging rather than being silently ignored.
- `e2e/kitable.spec.ts`'s "table/changed bridge event" describe block mocks the kit bridge stream
  and the `/v1/data-documents` HTTP API to cover the editor's own reaction to a `table/changed`
  event — including one test that injects a workflow-origin event for a newly created row and
  checks the open grid shows it without a reload.
