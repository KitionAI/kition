# Kit Unified Architecture

| | |
| --- | --- |
| Status | Design proposal, 2026-10-12. Not yet normative |
| Audience | Kit authors, host and server developers, embedders, harness integrators |
| Supersedes when accepted | Nothing; it extends [kit-platform-architecture.md](kit-platform-architecture.md), [kit-protocol.md](kit-protocol.md), and [kit-sdk.md](kit-sdk.md) |
| Normative home once accepted | Kition Kit Standard 2.0 in `KitionAI/kition-sdk` (`docs/standard.md`) |

This document designs one architecture for **every** kit in Kition, the
default kits that ship with the app and the plugin kits installed on demand,
so that the same kits can

1. run in the single-user desktop app today,
2. join offline-first, real-time collaboration through a Kition server later,
   without changing their document model a second time,
3. be published as an SDK that any third party can embed, script, extend, or
   implement, and
4. be driven by any AI harness (Kition's agent, DeepSeek Harness, any MCP
   client, any model provider) through the same path a person uses.

Order of work: settle this architecture and the collaboration contract first,
then finish the single-user product on it, then widen file-format
compatibility. Section 17 turns that into phases.

## 1. Decisions taken

| # | Decision | Date |
| --- | --- | --- |
| D1 | Collaboration is **offline-first plus real-time**: every replica edits locally and merges after reconnect; online replicas see each other live | 2026-10-12 |
| D2 | The SDK serves four audiences: **embedding** editors, a **document object model API** for automation, **authoring** new kits, and **extending** existing kits | 2026-10-12 |
| D3 | Default kits become **standard kits**: same manifest, same model and change contract, same UI protocol as plugin kits. Their engines may be TypeScript or Rust. Existing React and CodeMirror editors are kept; boundaries are extracted, not rewritten | 2026-10-12 |
| D4 | React Design (`.kidesign`) is the only Design product; the standalone Rust `kit.design` is excluded from the roadmap | 2026-10-12 |
| D5 | The Kition runtime and server stay Rust. AI harness conformance is by contract (DeepSeek Harness, MCP, ACP), never by embedding another runtime | 2026-10-11 |
| D6 | **Two editions, one architecture.** Kition (single-user) is free with every kit and every single-user feature. **Kition Pro** is the paid edition: the collaboration server and everything that needs it. Both run the same kits, model, and client code; Pro adds a server, not a second code path (section 1.1) | 2026-10-12 |
| D7 | **Engines keep their language; the SDK surface is TypeScript-first.** Plugin engines stay Rust compiled to WebAssembly; default kits already in TypeScript stay TypeScript. Developers consume generated TypeScript (and Python) APIs and prebuilt packages, never Rust toolchains. Engines are not translated to React or TypeScript (section 7.3) | 2026-10-12 |

### 1.1 Editions

| | Kition (free) | Kition Pro (paid) |
| --- | --- | --- |
| All default and plugin kits, editing, import/export | Yes | Yes |
| Local KDM store, version history on the device, scoped undo | Yes | Yes |
| AI: built-in agent, bring-your-own model, MCP, DeepSeek Harness, ACP | Yes | Yes |
| Object model API and scripts, extensions, headless kits | Yes, against local documents | Yes, also against server documents |
| Embed SDK | Yes, single-user with the integrator's storage provider | Yes, plus co-editing through a Pro server |
| Real-time co-editing, presence, sharing, permissions, comments across people | No | Yes |
| Sync across a person's devices, server version history, server-side agents, previews, and exports | No | Yes |
| Self-hosted server | No | Yes (enterprise licence) |

Rules that keep the editions one architecture:

1. **Single-user is one replica.** The free app runs exactly the KDM,
   transactions, change log, and local store a Pro client runs. Joining a
   Pro server attaches a sync connector to an existing replica; it never
   converts or re-imports the document.
2. **The boundary is the server.** Everything a device runs (kits, SDK,
   standard, KDM, local store, the `kition-sync/1` client, the embed SDK)
   lives in the open repositories under Apache-2.0. The server
   implementation lives in the private `kition-pro` repository. The sync
   protocol is published so the open client is testable and Pro is
   replaceable by a compatible self-hosted server only under a Pro licence.
3. **Entitlement is enforced by the server, not the client.** The client
   shows Pro features when the signed-in account has them; the Pro server
   authenticates and checks the plan on `sync/hello`. No feature is locked by
   client-side checks, which would be bypassable and would fork code paths.
4. **Leaving Pro never strands data.** Every Pro document is also a complete
   local replica; when a subscription ends the person keeps editing locally
   and can export at any time.
5. **No Pro-only document features.** A Pro document opened by the free app
   (after export or loss of access) must render and edit identically, except
   that collaboration-only objects (comment threads from others, presence) are
   read-only history.

Proposed decisions awaiting review are marked **Proposal** in the text and
collected in section 18.

## 2. Kit inventory

### 2.1 Default kits (ship with Kition)

| Kit (proposed id) | File | Today's canonical data | Useful foundation | Main gaps for this design |
| --- | --- | --- | --- | --- |
| Document `kit.document` | `.md` | Markdown string in CodeMirror; whole-file autosave | Editor transactions, IME buffering, drafts, AI revision review | Text changes are reduced to whole-string replacement; no anchors, no causal changes, no author-scoped undo |
| Table `kit.table` | `.kitable` (SQLite) | Tables, fields, views, records, links, attachments, per-field history | Document UUID; record `row_key` UUID; partial field updates; bulk transactions | Table/field/view keys are local integers; record update is read-merge-write without one transaction; empty actor; undo resubmits old values |
| Whiteboard `kit.board` | `.kiboard` (JSON records) | `meta`, `page`, `element`, `binding`, `asset` records in `BoardStore` | `transact` produces added/updated/removed diffs with `user` or `agent` source | IDs from `Date.now()` plus a counter collide across replicas; whole-record updates; unguarded whole-file save |
| Design `kit.kidesign` | `.kidesign` (JSON) | UUID document, pages, node map, assets, styles, variants | Commands with previews, node/asset diffs, guarded save, draft recovery | Diffs replace whole nodes and the header; no property, order, or text merge |
| Dashboard (part of Table) | inside `.kitable` `meta.dashboards` | Widget, layout, and query definitions | Logical widget IDs | Whole `meta` replaced on save; identity scope implicit |
| Workflow (part of Table) | runtime stores | Trigger, action, node and edge graph | Reference validation | Whole node/edge arrays replaced; definition and execution not separated |

Gallery, media viewers, and file previews are derived browsing surfaces, not
document kits.

### 2.2 Plugin kits (installed on demand)

All are standalone repositories cloned from an upstream Rust engine, compiled
to WebAssembly behind `KitDocument`, with an embedded web UI (`kition-kit-ui/1`)
and a headless executable (`kition-kit/1`). Registry: `kits/sdks.json` and
`crates/kition-kits/src/manager.rs`.

| Kit | Formats | Model root | Local identity today | Merge class (section 6.4) |
| --- | --- | --- | --- | --- |
| `kit.presentation` | `.deckcraft`, `.pptx` | `Presentation -> slides -> shapes -> text` | `u32` from document `next_id` | Structured + text |
| `kit.word` | `.docx` | `Document -> blocks -> paragraphs/tables -> runs` | Path of indices plus byte offset; no block IDs | Rich text |
| `kit.sheet` | `.xlsx` | `Workbook -> sheets -> sparse cells` | Sheet index, numeric row/column | Grid |
| `kit.pdf` | `.pdf` | COS object graph, pages, annotations, forms | PDF object numbers, page indices | Overlay + coordinated |
| `kit.cad` | `.dxf` | `Drawing -> entity store`, blocks, layers, constraints | DXF handle from `handseed` | Structured + coordinated |
| `kit.photo` | `.psd`, `.psb`, `.pcraft` | `Document -> layers -> content`, masks, tiles | Process-wide atomic counter | Raster |
| `kit.vector` | `.vectorcraft` | `Document -> artboards/layers -> node tree` | `NodeId(u64)` from document counter | Structured + text |
| `kit.effect` | `.ecproj` | `Project -> comps -> layers -> property tree -> keyframes` | Document counter | Timeline |
| `kit.film` | `.fcproj` | `Project -> sequences -> tracks -> items` | Document counter | Timeline |

Every plugin kit is today a single-user engine: identity is allocated per
document or per process, history is whole-document snapshots, and `revision`
is a local counter. That is sufficient for one replica and is the starting
point for section 17.

### 2.3 What already generalises

The AI side is already contract-driven: the three document tools
(`<prefix>_inspect`, `_commands`, `_run`), the Kit AI bridge for live
editing, the MCP server (`POST /v1/mcp/kits`, stdio `kition-kits-mcp`), and
`@kition/dsh-kits` for DeepSeek Harness. What does not yet generalise:

- default kits are not reachable through any kit contract;
- there is no change contract (export committed changes, apply remote changes,
  causal version) in any kit;
- the only programmatic API is untyped `execute(command, json)` plus
  free-form `inspect()` JSON; there is no object model a developer can browse.

## 3. Lessons from reference SDKs

| SDK | Pattern worth adopting | Where it lands here |
| --- | --- | --- |
| Office JavaScript API | Proxy objects queued against a request context and flushed with `context.sync()`; `load()` selects properties; requirement sets version capabilities independently of app versions; add-in manifest declares commands and task panes | Object model API with batched `sync` (section 8); capability sets (section 15); extension manifests (section 9.3) |
| WPS WebOffice JS-SDK | `init({ mount, officeType, fileId, token })` mounts an iframe editor; the integrator implements a callback service for file metadata, download, upload, users, and permissions; `instance.ready()` then an async `Application` object over `postMessage` | Embed SDK and the Storage/Identity provider interfaces (section 14) |
| Blender `bpy` | `bpy.data` (data blocks), `bpy.ops` (operators with `poll()` for availability), RNA reflection of every property, add-ons that register operators and panels | Objects plus commands with `enabled` (section 9); schema reflection drives docs, typings, and agent tools (section 8.4); extensions (section 9.3) |
| VS Code / LSP | Process-isolated providers behind a versioned JSON-RPC protocol with capability negotiation; activation events | Existing Kit Protocol; activation by format and command (section 9.3) |
| Figma multiplayer, Automerge, Yjs, Loro | Per-object, per-property last-writer-wins registers; client-namespaced IDs; sequence CRDTs for text and lists; movable trees; origin-scoped undo | Kit Data Model (section 6) |

The common lesson: a stable SDK is a **typed data model plus a command
vocabulary plus events plus capability versioning**, exposed through
asynchronous, batched calls that work the same whether the document is in a
worker, another process, or on a server.

## 4. Architecture overview

```text
 Consumers  ┌────────────┬──────────────┬───────────────┬──────────────────┐
            │ Person via │ Embedder     │ Automation /  │ AI harness       │
            │ kit UI     │ (Embed SDK)  │ Object Model  │ (MCP, DSH, ACP)  │
            └─────┬──────┴──────┬───────┴──────┬────────┴────────┬─────────┘
                  │ UI protocol │ Embed API    │ Object Model    │ Tools
                  ▼             ▼              ▼                 ▼
 Session    ┌──────────────────────────────────────────────────────────────┐
            │ Kit Session: commands -> transactions, object model, events, │
            │ presence, undo scopes, capability negotiation                │
            └───────────────┬──────────────────────────────┬───────────────┘
                            │ Engine contract 2            │
 Kit        ┌───────────────▼──────────────┐   ┌───────────▼───────────────┐
            │ Kit engine (Rust or TS)      │   │ Import / export           │
            │ domain rules, validation,    │   │ (pptx, docx, xlsx, dxf,   │
            │ layout, render, tools        │   │  pdf, psd, md, ...)       │
            └───────────────┬──────────────┘   └───────────────────────────┘
                            │ typed transactions / materialised diffs
 Data       ┌───────────────▼──────────────────────────────────────────────┐
            │ Kit Data Model (KDM) replica: schema, identity, CRDT state,  │
            │ change log, version vector, blobs by content hash            │
            └───────────────┬──────────────────────────────┬───────────────┘
                            │ local store                  │ Sync protocol
                            ▼                              ▼
                 workspace + .kition store       Kition Pro server (Rust, paid)
                 (free: one replica per device)  rooms, auth, change log,
                                                 blobs, headless kits
```

Rules that keep the layers honest:

1. **One authority per document.** For a collaborative document the KDM
   replica is authoritative. The engine's domain model is a materialised view
   rebuilt or patched from KDM changes. Nothing synchronises two complete
   copies by replacement.
2. **Every mutation is a transaction.** Typing, dragging, inking, menus,
   scripts, extensions, imports, and agents all produce transactions on the
   same session. There is no side door.
3. **Files are interchange, not state.** `.pptx`, `.docx`, `.md`, and the rest
   are imported into and exported from the model. The workspace file stays
   the person's file in single-user mode (section 10).
4. **Private state stays private.** Selection, caret, zoom, viewport, tool
   state, caches, layout, and render output are never replicated as document
   data; selection and caret travel as presence.
5. **Same contract in every environment.** The page worker, the headless
   executable, and the server run the same engine against the same contract.

## 5. Core concepts

| Term | Meaning |
| --- | --- |
| Kit | A package: manifest, engine, optional UI, optional headless executable |
| Document | One logical document with a durable `docId` (UUID v7). Renaming or moving the file never changes it |
| Replica | One copy of a document's KDM state on one device or server process |
| Actor | A replica-session identity that authors changes: `actorId` = random 64-bit peer id, new per writable replica session |
| Principal | The authenticated person, agent, or service an actor acts for. Authorization uses principals, never client-claimed actor fields |
| Change | An immutable, causally ordered unit produced by one actor; identified by `(actorId, counter)` |
| Transaction | The atomic group of KDM operations a command produces; one undo step; carries `origin` |
| Origin | `{ kind: person | agent | extension | import | system, principal, label, group? }` |
| Command | A named user intent with a parameter schema; resolves targets and emits a transaction |
| Object | An addressable entity in the KDM with a stable `ObjectId` and a schema type |
| Presence | Ephemeral per-actor state (selection, caret, viewport, tool), never persisted in history |
| Blob | Immutable binary content addressed by SHA-256, referenced from the model |
| Version | A version vector or frontier identifying exactly which changes a state contains |

## 6. Kit Data Model (KDM)

The KDM is the shared, typed, replicated representation every kit declares
its document in. It is what makes collaboration, the object model API, AI
tooling, and generic tooling possible without kit-specific host code.

### 6.1 Primitives

| Primitive | Semantics | Typical use |
| --- | --- | --- |
| `Record<T>` | Map of named fields; each scalar field is a last-writer-wins register | Shape properties, cell style, layer settings |
| `Map<K, V>` | Keyed collection with add-wins semantics | Objects by id, styles by name |
| `List<V>` | Ordered sequence with stable element identity (sequence CRDT) | Paragraph runs, keyframes, path points |
| `MovableList<V>` | `List` plus atomic move, no duplicate on concurrent move | Slides, layers, tracks, sheet order |
| `Tree<V>` | Movable tree with cycle prevention | Design nodes, vector groups, board frames, outline |
| `Text` | Unicode text sequence with marks (rich-text spans) and stable anchors | Markdown, Word bodies, text frames, cell text |
| `Counter` | Commutative counter | Rare: statistics, numbering seeds |
| `BlobRef` | `{ hash, mime, size, name? }` referring to a blob | Images, media, fonts, embedded PDF bytes |
| `Ref<T>` | Typed reference to another object id; dangling references are a validation state, not a crash | Layout of a slide, record links, bindings |

### 6.2 Schema

Each kit ships a KDM schema in its package (`model/schema.json`), versioned
independently of the kit. The schema names object types, their fields and
primitives, references, and invariants. Example, abbreviated:

```json
{
  "kdm": 1,
  "kit": "kit.presentation",
  "schemaVersion": 3,
  "root": "Presentation",
  "types": {
    "Presentation": {
      "fields": {
        "slideSize": { "record": "Size" },
        "slides": { "movableList": { "ref": "Slide", "owned": true } },
        "masters": { "map": { "ref": "Master", "owned": true } }
      }
    },
    "Slide": {
      "fields": {
        "layout": { "ref": "Layout" },
        "hidden": { "boolean": true, "default": false },
        "shapes": { "tree": { "ref": "Shape", "owned": true } },
        "notes": { "text": true }
      }
    },
    "Shape": {
      "fields": {
        "kind": { "enum": ["shape", "picture", "group", "connector", "table", "chart", "media", "ink", "opaque"] },
        "transform": { "record": "Transform", "merge": "atomic" },
        "fill": { "record": "Fill" },
        "text": { "text": true, "optional": true },
        "image": { "blob": true, "optional": true }
      }
    }
  },
  "invariants": ["slide.layout.exists", "table.spans.valid"]
}
```

`"merge": "atomic"` groups coupled fields (a transform's offset and size) so
they resolve as one register instead of mixing two writers' halves.

The schema is the single source for: object model typings (section 8),
generated agent tools and documentation (section 13), validation, migration,
and the conformance suite.

### 6.3 Identity

- `docId`: UUID v7, assigned at creation or at first import, stored in the
  document's KDM root and in the local store index.
- `ObjectId`: assigned by the KDM when an object is created. With the
  reference engine it is the creating operation's `(actorId, counter)`, so two
  replicas never mint the same id, and creation is free of coordination.
- Engines keep their efficient local ids (`u32`, `NodeId`, DXF handle, PDF
  object number). Each kit owns a bidirectional **id map** from `ObjectId` to
  local id, rebuilt on load, never replicated. Export formats keep their own
  numbering; import assigns fresh `ObjectId`s and records the format id as an
  attribute so a re-import of the same file can be matched.
- Table rows keep `row_key` (already a UUID) as their `ObjectId`; tables,
  fields, and views gain UUIDs alongside their local integer keys.

### 6.4 Merge classes

Every kit maps its data to these classes. The KDM primitives implement the
generic part; the kit implements the domain rules on top (section 6.5).

| Class | Kits | Merge policy |
| --- | --- | --- |
| Structured objects | Presentation, Vector, Design, Board, CAD entities, Dashboard, Workflow definitions | Per-field registers; `atomic` groups; `Tree`/`MovableList` for order and parent; delete wins over edit, with the edit preserved in history |
| Rich text | Document, Word, text inside every other kit | `Text` with marks and anchors; paragraph split/merge as text operations; comments and selections anchored, not offset-based |
| Database | Table | Records as `Map<RowKey, Record>`; per-field registers; schema changes as typed operations; computed values derived, never replicated |
| Grid | Sheet | Rows and columns as `MovableList` of stable ids; cells keyed by `(rowId, colId)`; formulas stored with id-based references and rendered to A1 for display and export |
| Timeline | Film, Effect | Items and keyframes with stable ids; split/trim/ripple are single operations that move ids, not array edits; overlap resolved by a kit rule after merge |
| Raster | Photo | Layers and their properties as structured objects; pixel content as ordered stroke operations with deterministic inputs or as versioned tile blobs; concurrent edits to the same layer's pixels need a lease (section 11.6) |
| Overlay + coordinated | PDF, CAD constraints | PDF base bytes immutable as a blob; annotations, forms, page order, and redactions as structured objects over it; content-stream edits and constraint solving take a lease |
| Binary assets | All | Blobs by hash, transferred separately, referenced by `BlobRef` |

### 6.5 Validation after merge

Merging two individually valid transactions can still produce an invalid
document (a table span overlapping a removed column, two clips overlapping
on a no-overlap track). Each kit implements a **repair pass**:

```text
merged KDM state -> kit.validate(changedObjects) -> repair transaction (origin: system)
```

Repairs must be deterministic functions of the merged state, so every replica
produces the same repair; a replica that receives the identical repair from a
peer finds it already applied. Repairs that need a person (two incompatible
constraint edits) become a **conflict object** in the model that the UI
surfaces and a later transaction resolves.

### 6.6 Reference implementation of the KDM

**Proposal:** implement the KDM primitives on [Loro](https://loro.dev)
(MIT; Rust core with WebAssembly bindings): it provides maps, lists, movable
lists, a movable tree, rich text, counters, version vectors, shallow
snapshots, and an origin-aware undo manager in one library that runs
natively, in a worker, and on a server. Kition wraps it in a `kition-kdm`
crate and an `@kition/kdm` package so kits depend on KDM types, not on Loro,
and the backing engine can be replaced without changing the kit contract.

Alternatives considered: Yjs/Yrs (mature, rich editor bindings, weaker
movable tree and Rust-first ergonomics), Automerge (strong causal model,
heavier for large binary-adjacent documents), a custom operation log with
server rebase (fails D1 without reinventing a CRDT). The choice is gated by
the spike in phase 1 (section 17): Unicode/IME text convergence, a 500-slide
deck, a 100k-row table, 10k-entity CAD, memory in a WebAssembly worker, and
load time from a compacted snapshot.

## 7. Engine contract 2

Contract 1 (`KitDocument`) stays supported. Contract 2 adds a model-backed
document. A kit declares `"engine": { "contract": 2 }` and capability
`"kdm"`.

### 7.1 Rust (plugin kits and Rust default kits)

```rust
use kition_sdk::kdm::{Change, Doc, Origin, Transaction, Version};

pub trait KitModel: Sized {
    /// The KDM schema this engine reads and writes.
    fn schema() -> &'static kition_sdk::kdm::Schema;

    /// Builds the engine's materialised view from a KDM document.
    fn load(doc: &Doc) -> Result<Self, KitError>;

    /// Applies committed changes (local or remote) to the materialised view.
    /// `changed` lists the objects whose state differs; the engine patches
    /// only those and reports the damaged render area.
    fn apply(&mut self, doc: &Doc, changed: &ChangedObjects) -> Result<Damage, KitError>;

    /// Turns a command into a transaction against the KDM. It must not
    /// mutate the view directly; the view follows from `apply`.
    fn command(&self, doc: &Doc, tx: &mut Transaction, id: &str, params: Value) -> Result<Value, KitError>;

    /// Deterministic post-merge validation (section 6.5).
    fn validate(&self, doc: &Doc, changed: &ChangedObjects, tx: &mut Transaction) -> Result<(), KitError>;

    /// File interchange: import into an empty doc, export from the doc.
    fn import(name: &str, bytes: &[u8], doc: &mut Doc, blobs: &mut dyn BlobSink) -> Result<ImportReport, KitError>;
    fn export(&self, doc: &Doc, name: &str, blobs: &dyn BlobSource) -> Result<Vec<u8>, KitError>;

    // Rendering, tools, and commands() are unchanged from contract 1.
}
```

`kition-sdk` provides the generic half: a `KitSession<M: KitModel>` that owns
the `Doc`, the undo manager, the change log, presence, and the id map, and
implements contract 1 on top so existing hosts keep working:

| Session member (WebAssembly class) | Purpose |
| --- | --- |
| `docId`, `version()` | Identity and current version vector |
| `execute(command, params, origin)` | Runs a command as one transaction; returns `{ result, changeIds }` |
| `exportChanges(since)` | Encoded changes the caller lacks (`since` = its version) |
| `importChanges(bytes)` | Applies remote or stored changes; runs `apply` and `validate`; returns damage |
| `snapshot()`, `openSnapshot(bytes)` | Compacted state for fast load and checkpoints |
| `undo(scope)`, `redo(scope)` | Scoped by origin principal (section 12) |
| `presence()`, `setPresence(json)` | Local presence out, remote presence in |
| `objects(query)`, `object(id, fields)` | Object model reads (section 8) |
| `subscribe(filter)` | Change events for the object model and extensions |
| `import(name, bytes)`, `export(name)` | File interchange |

### 7.2 TypeScript (default kits with TypeScript engines)

The same session contract is published as a TypeScript interface in
`@kition/kit-engine`. Default kits implement `KitModel` in TypeScript against
`@kition/kdm` and run in a worker exactly like WebAssembly engines:

| Default kit | Engine | Binding |
| --- | --- | --- |
| Document | TypeScript | CodeMirror transactions map to `Text` operations through a binding (a CodeMirror-to-KDM adapter, analogous to `y-codemirror`); Markdown is import/export |
| Board | TypeScript | `BoardStore.transact` emits KDM operations instead of whole-record diffs |
| Design (`.kidesign`) | TypeScript | `designStore` commands emit field-level operations; node tree on `Tree` |
| Table | Rust (`kition-kitable`) | SQLite stays the local query index; the KDM is the replicated authority; a projector writes KDM changes into SQLite inside one SQL transaction |
| Dashboard, Workflow | Part of the Table document | Separate KDM sub-trees with their own object types |

A default kit's editor keeps its framework (React, CodeMirror). What changes
is where its store gets state from and where its mutations go.

### 7.3 Why engines are not rewritten in TypeScript

React is a UI library; it does not replace a document engine. The question is
which language the engine (model, layout, rendering, import/export) is written
in. The SDK's difficulty lies in the API surface, packaging, and contracts,
not in the engine's language, and every comparable product separates the two:

| Product | Engine | Developer API |
| --- | --- | --- |
| Microsoft Office / Office.js | C++ | JavaScript facade over an async bridge |
| WPS WebOffice SDK | C++ | JavaScript object model over `postMessage` |
| Figma | C++ compiled to WebAssembly | TypeScript plugin API; React UI |
| Blender | C/C++ | Python `bpy` |

Keeping Rust engines and a TypeScript surface is right for Kition because:

1. **One engine everywhere.** The same Rust engine runs in the page worker
   (WebAssembly), the headless executable, the Pro server, Node, and a Python
   binding. A TypeScript engine runs only where JavaScript runs, so the server
   and Python would need a second implementation or a JavaScript runtime.
2. **Fidelity and performance.** Office layout, text shaping, PDF, CAD
   geometry, raster tiles, and video decoding are CPU-heavy and
   precision-sensitive. WebAssembly keeps native and browser output identical,
   which golden-image compatibility work depends on.
3. **Cost.** The plugin engines are roughly 300k lines of Rust each and keep
   merging upstream progress (kit-platform-architecture.md section 7).
   Translating them would take years, freeze them at their current upstream
   state, and add a new class of bugs.
4. **The collaboration core is Rust too.** The KDM reference engine
   (section 6.6) is a Rust core with WebAssembly bindings, so Rust engines
   reach it in process without crossing a language boundary.

What makes Rust feel hard today, and how this design removes it for SDK users:

| Pain | Remedy |
| --- | --- |
| Untyped `execute(command, json)` and free-form `inspect()` | Generated, typed object model (section 8) |
| Building with wasm-pack and a matching Rust toolchain | Prebuilt npm packages per kit (`@kition/kit-presentation`) with the WebAssembly inside; SDK users run `npm install` only |
| Large WebAssembly modules (20 to 30 MB) | Lazy loading per kit, importers split into on-demand modules, streaming compilation, HTTP caching |
| Debugging across the bridge | Source maps for the TypeScript facade, structured `KitError` codes, engine logs through `kit.log` |
| Writing a new kit requires Rust | Contract 2 is also a TypeScript interface (section 7.2); a third party may write a kit entirely in TypeScript |

So: Rust or TypeScript is chosen per engine by what the engine does; React is
used for every kit UI (`@kition/kit-ui`); the developer API is TypeScript
first, with Python and Rust generated from the same description.

## 8. Object Model API

The object model is the typed, discoverable API that automation code,
extensions, embedders, and generated agent tools use. It is generated from the
KDM schema and the command catalogue of each kit; it is not handwritten per
host.

### 8.1 Shape

```ts
import { openDocument } from '@kition/sdk'

const deck = await openDocument<Presentation>(source)   // local file, embed instance, or server room

await deck.run(async (ctx) => {
  const slide = ctx.root.slides.add({ layout: 'title-and-content' })
  const title = slide.shapes.add({ kind: 'shape', preset: 'rect', rect: [80, 60, 800, 120] })
  title.text.insert(0, 'Quarterly review')
  title.fill.color = '#5645d4'
  slide.load(['id', 'shapes/items/id'])
  await ctx.sync()                       // one round trip, one transaction
  console.log(slide.id)
})

deck.on('changed', (event) => { /* objects, origin, version */ })
```

- **Proxies and `sync()`** (from Office.js): property reads are queued with
  `load`, writes are queued as operations, and `sync()` sends them as one
  transaction. The same code works whether the session is in a local worker,
  in a headless process, or on the server.
- **Commands are first class** (from `bpy.ops`): `ctx.commands.run('slide.duplicate', params)`
  and `ctx.commands.enabled('slide.duplicate')`. Objects cover data; commands
  cover operations with domain logic (auto-layout, chart regeneration).
- **Events**: `changed` (with origin and object ids), `presence`,
  `selection`, `saved`, `conflict`.

### 8.2 Language bindings

| Binding | Package | Transport |
| --- | --- | --- |
| TypeScript, in page | `@kition/sdk` | Worker messages |
| TypeScript, Node | `@kition/sdk` | Kit Protocol to a headless kit, or Sync protocol to a server |
| Python | `kition` (PyPI) | Kit Protocol or Sync protocol |
| Rust | `kition-sdk` client | Direct `KitSession` in process, or either protocol |

All bindings are generated from one JSON description (`schema.json` plus the
command catalogue) so they cannot drift.

### 8.3 Wire form

The object model travels as a JSON-RPC method on every transport:

```json
{ "method": "model/batch", "params": {
    "documentId": "0192f0c4-...",
    "origin": { "kind": "extension", "principal": "ext:com.example.brand" },
    "ops": [
      { "op": "create", "type": "Slide", "in": "root.slides", "at": "end", "ref": "$s",
        "fields": { "layout": "title-and-content" } },
      { "op": "set", "target": "$s", "path": "hidden", "value": false },
      { "op": "command", "id": "slide.applyTheme", "params": { "slide": "$s", "theme": "Brand" } }
    ],
    "load": [{ "target": "$s", "fields": ["id"] }]
} }
```

`$`-prefixed temporary references resolve to `ObjectId`s inside the batch.

### 8.4 Reflection

`model/describe` returns the schema and command catalogue with descriptions,
so tooling can browse a kit the way Blender's RNA lets scripts introspect
properties. Documentation and typings for every kit are generated from it.

## 9. Commands and extensions

### 9.1 Commands

Commands keep their current role (stable id, title, menu, shortcut, schema,
`mutates`, `enabled`). In contract 2, a mutating command runs inside a
transaction and returns the ids it created. It must resolve every target to
`ObjectId`s before emitting operations: replaying "bold the selection" on
another replica is wrong; replaying "set mark bold on anchors A..B of text T"
is right. Only resolved operations are replicated; command names are
recorded as transaction labels for history and audit.

### 9.2 Availability

`enabled` stays the per-state availability query (Blender's `poll`).
`disabledCommands()` stays the cheap path.

### 9.3 Extensions (add-ins)

An extension adds behaviour to one or more kits without forking them. It is
a package with `extension.json`:

```json
{
  "standard": "2.0",
  "id": "com.example.brand-check",
  "targets": ["kit.presentation", "kit.word"],
  "activation": ["onOpen:kit.presentation", "onCommand:brand.check"],
  "contributes": {
    "commands": [{ "id": "brand.check", "title": "Check brand", "menu": ["Review"] }],
    "panels": [{ "id": "brand.panel", "title": "Brand", "entry": "panel.html" }]
  },
  "permissions": ["model.read", "model.write", "network:api.example.com"]
}
```

Extensions run in a sandboxed worker (logic) and an iframe (panels), use the
object model with origin `extension`, and can never reach files, the network,
or other documents beyond their declared permissions. Panels render inside
the kit UI's extension slot through the UI protocol.

## 10. Persistence

### 10.1 Local store

Single-user mode is one replica with no server. Each document's KDM state
lives in the workspace's private store, next to the user's file:

```text
<workspace>/
  Launch.pptx                         the person's file (interchange)
  .kition/docs/<docId>/
    snapshot.bin                      latest compacted KDM snapshot
    changes/<seq>.bin                 changes after the snapshot (append-only)
    blobs/<sha256>                    blobs not already in the file
    meta.json                         docId, kit, schemaVersion, file binding, file stamp, export version
```

`.kition/` is already the workspace's private metadata directory. The store is
written with append-and-fsync for changes and atomic rename for snapshots.

### 10.2 File binding

| Event | Behaviour |
| --- | --- |
| Open a file with no store entry | Import into a new doc, bind the file (path, stamp, hash) |
| Open a bound file whose stamp matches | Load the snapshot and changes; no import |
| Bound file changed outside Kition | Import the new file into a scratch doc and apply the difference as one transaction with origin `import` (structured diff for kits that support it, whole-content replacement otherwise). Unsaved local changes are never discarded (standard H6) |
| Save | Export from the doc, write through the host atomically with the expected stamp, record the exported version |
| Rename or move the file | Rebind; `docId` unchanged |

Autosave of the KDM state is continuous; "Save" means export to the
interchange file. Kits whose native file is the KDM container (new native
formats) skip export.

### 10.3 Lossless round trip

Import records unsupported format content as **opaque preserved objects**
(`Opaque` in Presentation, passthrough parts in Word) with their
relationships, so export can write them back. Preservation is never counted
as editability; the object model marks such objects `readOnly`.

## 11. Collaboration (Kition Pro): Sync protocol and server

### 11.1 Model

Collaboration is the Kition Pro edition (section 1.1). The protocol and the
client side are open; the server is built in the private `kition-pro`
repository. Every device holds full replicas of the documents it has open or
pinned. The **Kition Pro server** relays and stores changes. Because changes merge
deterministically, the server is not an ordering authority for content; it
is the authority for **membership, permissions, durability, blobs, and
compaction**.

### 11.2 Protocol `kition-sync/1`

JSON-RPC 2.0 over WebSocket (binary frames for change payloads):

| Message | Direction | Meaning |
| --- | --- | --- |
| `sync/hello` | client → server | Auth token, client info, capabilities; the server checks the account's Pro entitlement and answers with the enabled capability sets |
| `room/join` | client → server | `docId`, client version vector; server answers with missing changes and the room's presence |
| `changes/push` | client → server | Encoded changes; server validates principal permissions, stores, acks with server sequence |
| `changes/pull` | server → client | Changes from other actors, in server-received order (any order converges) |
| `presence/set`, `presence/update` | both | Ephemeral; never stored |
| `blob/has`, `blob/put`, `blob/get` | both | Content-addressed transfer, resumable ranges |
| `lease/acquire`, `lease/release`, `lease/changed` | both | Coordinated objects (section 11.6) |
| `snapshot/get` | client → server | Compacted snapshot for a new device |
| `room/leave` | client → server | |

Offline flow: edits commit locally; on reconnect `room/join` exchanges
version vectors; both sides send what the other lacks; merge and the
deterministic repair pass (section 6.5) run on every replica.

### 11.3 Server components (Rust)

| Component | Responsibility |
| --- | --- |
| Gateway | WebSocket sessions, auth, rate limits |
| Room service | Per-document actor sets, fan-out, presence |
| Change store | Append-only per-document log with server sequence; snapshotting and compaction that keeps enough history for stale replicas up to a retention window |
| Blob store | Content-addressed object storage; reference counting per document |
| Permission service | Principals, roles (`owner`, `editor`, `commenter`, `viewer`), share links; rejects changes from principals without write permission |
| Headless kit pool | Runs the same kit engines server-side for previews, export, search indexing, validation of untrusted changes when required, and server-hosted agents |

The server reuses the kit engines through the Kit Protocol; it never has a
second implementation of a kit.

### 11.4 Trust

Clients are untrusted. The server checks that every change's actor belongs to
the authenticated session, that the principal may write, and that the change
decodes against the document's schema version. Kits with strong invariants
may opt into **server validation**: the headless kit applies the change and
rejects it if `validate` cannot repair it.

### 11.5 Schema evolution

Each change carries the schema version of its author. A replica on an older
schema keeps unknown fields untouched (KDM preserves them) and asks the
person to update the kit before editing affected objects. Migrations are
transactions with origin `system` and a deterministic migration id, applied
once per document.

### 11.6 Leases for coordinated objects

Some edits do not merge meaningfully: two people repainting the same pixels,
two edits of one PDF content stream, two conflicting CAD constraint solves.
For objects a kit marks `coordination: "lease"`, the session acquires a short
lease from the server before editing; offline edits to such objects are
allowed but land as a **conflict object** (both versions kept) if another
lease holder edited meanwhile. Everything else never waits for the network.

## 12. Undo and redo

- Undo is **scoped by principal and replica session**: a person's Undo
  reverts their own last transaction group, never a collaborator's.
- Undo is an inverse **operation** on the current state, not a snapshot
  restore. If a field was changed by someone else after the undone
  transaction, that field keeps the newer value.
- Agent edits made on a person's behalf form their own undo group, labelled
  in history ("Edited by the agent"), undoable by the person who asked.
- Whole-document snapshots remain for crash recovery and version history,
  never for undo.

## 13. AI integration

The agent is a **collaborator**: it opens a session on the document with
origin `agent`, appears in presence, and edits through transactions. This
unifies today's two paths (live bridge versus headless copy): a live editor,
a headless kit, and a server room all expose the same session.

| Surface | What a harness gets |
| --- | --- |
| Document tools (existing A3) | `<prefix>_inspect`, `<prefix>_commands`, `<prefix>_run` |
| Object model tools (new) | `<prefix>_query` (read objects by type, id, or filter with selected fields) and `<prefix>_batch` (a `model/batch`); generated from the schema with `ParameterSchemaSpec` |
| Per-command tools (existing A1/A2) | Optional, curated by manifest `agent.include` |
| Resources | `kit://<docId>/objects/<id>`, previews, the schema |

Transports, all from the same tool implementation in `kition_kits::tools`:

- Kition's own agent (Rust, DeepSeek Harness contracts);
- MCP (`/v1/mcp/kits`, stdio `kition-kits-mcp`, and the server) for any
  MCP-capable harness or model provider;
- `@kition/dsh-kits` for DeepSeek Harness;
- ACP for external agents (planned in the standard, D3).

Rules: the agent's principal is the person who started it, with the agent
scope; model-visible means logged (A10); agent transactions follow the same
permissions and unsaved-work rules as the person; previews are rendered by the
same engine.

## 14. Embed SDK

For third parties who want a Kition editor inside their product, in the
style of WebOffice SDKs.

```ts
import { KitionEmbed } from '@kition/embed'

const editor = await KitionEmbed.mount(document.getElementById('editor'), {
  kit: 'kit.presentation',            // or inferred from the file
  file: { id: 'f_123', name: 'Launch.pptx' },
  storage: myStorageProvider,         // or a server endpoint implementing the same calls
  identity: { token: await getToken() },
  collaboration: { server: 'wss://pro.example.com' },    // a Kition Pro server; omit for single-user (free)
  locale: 'zh-CN',
  theme: { colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' } },
  permissions: { mode: 'edit' },
  ui: { toolbar: 'full', panels: ['comments'] },
})

await editor.ready()
const deck = editor.document<Presentation>()       // the object model, section 8
editor.on('saved', (e) => {})
```

The integrator implements two provider interfaces, in the browser or as HTTP
callbacks on their server:

| Provider | Calls |
| --- | --- |
| Storage | `info(fileId)`, `read(fileId)`, `write(fileId, bytes, expectedVersion)`, `blob.read/write(hash)`, `lend(path)` |
| Identity | `currentUser()`, `users(ids)` for names and avatars, `permissions(fileId)` |

Internally the embed SDK is a host: it serves the existing UI protocol
(`kition-kit-ui/1`) to the kit's iframe, the Kit AI bridge if the integrator
enables an agent, and the object model to the integrator's page. Kition's
desktop app is one host built on the same packages.

Security: kit UIs run in a sandboxed cross-origin iframe; the integrator's
page talks only to the embed SDK; tokens never reach the kit iframe.

## 15. Packaging, versioning, conformance

### 15.1 Manifest additions

```json
{
  "standard": "2.0",
  "id": "kit.table",
  "distribution": "default",
  "engine": { "runtime": "rust-wasm", "module": "kition_table_sdk", "class": "TableDocument", "contract": 2 },
  "model": { "schema": "model/schema.json", "schemaVersion": 1 },
  "collaboration": { "merge": ["database"], "leases": [], "serverValidation": false },
  "objectModel": { "namespace": "Table" }
}
```

- `distribution`: `default` (ships with a host) or `plugin` (installed).
- `engine.runtime`: `rust-wasm` or `ts-worker`.

### 15.2 Capability sets

Like Office requirement sets, APIs are grouped into named, versioned
capability sets that a host or server advertises and a script can test:
`KitModel 1.0`, `KitCollab 1.0`, `KitObjectModel 1.0`, `KitExtensions 1.0`,
`KitEmbed 1.0`. Minor versions only add members.

### 15.3 Conformance levels

The standard's L1 to L4 stay. Two levels are added:

| Level | A kit | A host or server |
| --- | --- | --- |
| **L5 Model** | Contract 2; KDM schema; object model generated; import/export round trip through the KDM | Local store (section 10); object model over every transport it offers |
| **L6 Collaboration** | Passes the convergence suite (section 16) | Sync protocol; presence; scoped undo; leases |

## 16. Testing

A shared **convergence suite** in `kition-kit-conformance` runs against any
kit at L6, with fuzzed and scripted scenarios on two to five in-process
replicas:

- concurrent edits to different fields of one object keep both;
- concurrent creation from the same snapshot produces distinct ids;
- concurrent text insertion at one position, including CJK IME composition,
  emoji, and paragraph split/merge, converges without loss;
- reorder versus reorder, reparent versus reparent, delete versus edit,
  duplicate versus delete have the documented outcome and valid references;
- sheet row insertion concurrent with a formula edit keeps the intended
  reference;
- undo by one actor preserves another actor's later changes, also after
  reconnect and redo;
- delivery in any order, with duplicates and retries, yields identical state
  on every replica (state hash);
- crash after local commit and before push recovers the change;
- missing blobs arrive late without corrupting the document;
- native and WebAssembly builds produce identical state hashes from
  identical change logs;
- import, export, re-import keeps semantic equality for each kit's fixture
  corpus.

Performance budgets are added to [kit-sdk.md](kit-sdk.md) section 7 per kit:
open from snapshot, apply 1,000 remote changes, local keystroke to paint, and
memory per replica.

## 17. Roadmap

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 0. Architecture | This document reviewed; Kit Standard 2.0 draft in kition-sdk; KDM schema format; capability sets | Owner approval; standard draft merged |
| 1. KDM spike | `kition-kdm` and `@kition/kdm` over the reference engine; benchmark the scenarios in section 6.6; Document and Board as two-replica prototypes in tests | Convergence suite subset green; budgets measured; engine choice confirmed or replaced |
| 2. Single-user on the new core: default kits | Board, Document, Design, then Table on contract 2 with the local store; whole-file guards everywhere in the interim | Existing e2e green; agent and person edits share one undo model; no data path bypasses transactions |
| 3. Single-user on the new core: plugin kits | Presentation first (largest active work), then Word, Sheet, Vector; Film, Effect, Photo, CAD, PDF after, each with its merge class | L5 per kit; import/export round trip unchanged or better |
| 4. Object model and extensions | Generated typings, `@kition/sdk` in page and Node, Python binding, extension host | Scripts and an example extension run in Kition and headless |
| 5. Kition Pro: server and collaboration | `kition-sync/1` client in the open repositories; server in `kition-pro`; presence, leases, permissions, sharing, entitlement; desktop app joins rooms | L6 for the default kits and Presentation; offline merge demo across two devices |
| 6. Embed SDK | `@kition/embed`, provider interfaces, example integrator app | A third-party page edits and co-edits a deck and a table |
| 7. Compatibility | Format fidelity work per kit (for example the presentation fidelity plan), measured on corpora | Per-kit fidelity gates |

Single-user work in phases 2 and 3 is real product work, not scaffolding: it
replaces snapshot undo, unguarded saves, and colliding ids, which are bugs
for one person as well.

Until a kit reaches phase 3, keep new model work collaboration-ready: no new
document-local id allocators, no new whole-document replacement paths, no
offset-based anchors in persisted data.

## 18. Open questions

| # | Question | Proposed answer |
| --- | --- | --- |
| Q1 | Replication engine | Loro behind `kition-kdm`, confirmed by the phase 1 spike |
| Q2 | Is the KDM the on-disk native format for new documents | Yes for default kits' new files once phase 2 lands; Markdown and Office files stay interchange |
| Q3 | History retention on the Pro server | Keep full change history for 30 days, snapshots beyond; configurable per deployment |
| Q4 | Sheet formula references | Store id-based references; A1 is a view; needs a prototype with structural edits |
| Q5 | Raster collaboration depth | Layer-level merge and leases on pixel content first; stroke-level merge later if needed |
| Q6 | Extension sandbox | Worker plus iframe with declared permissions; no native extensions |
| Q7 | Default kit ids | `kit.document`, `kit.table`, `kit.board`, `kit.kidesign` (to avoid clashing with the excluded `kit.design`) |
| Q8 | Self-hosted server | The Pro server is one Rust binary with pluggable storage so enterprises and embedders can host it under a Pro licence |
| Q9 | Free-edition multi-device | Not offered by Kition; people may place the workspace in their own file sync, and the local store must tolerate that (one writer per store, detected by a lock file) |
