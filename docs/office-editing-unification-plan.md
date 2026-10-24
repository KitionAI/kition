# Shared Office Drawing Editing Plan

Status: In progress. This plan covers implementation of editable charts, ink, WordArt, and shapes across Kition Word, Sheet, and Slide. Phase 0 is recorded in [the decision](office-drawing/decision.md), [the capability matrix](office-drawing/capability-matrix.md), and [the frozen baseline](office-drawing/baseline.md); Phase 1's three-kit shape slice is implemented in Slide, Sheet, and Word. Phase 3's chart slice (shared chart description, `drawing.chart`, DrawingML codec, shared Insert › Chart and Chart Design controls) is implemented in all three kits; charts are their own replica objects in every kit, so concurrent edits of one chart's members merge (DR14); Word and Slide save edited charts with an embedded workbook of their data, and axis, data-label and series formatting is editable through shared Chart Design controls (Sheet takes smoothing only); trendlines and error bars (`KitDrawing 1.1` DR16b: shared regressions and error amounts, set from Chart Elements or `seriesFormat`) are drawn and editable in all three kits; chart visual fidelity has improved against the baseline but no chart slide can meet the strict gate until open decision F1 (fonts the kits cannot ship) is made, as the capability matrix records. The ink slice (shared strokes, `drawing.ink` and `drawing.erase`, pen and eraser gestures, shared Draw controls) is implemented in all three kits. The WordArt slice's text warp (`KitDrawing 1.3`: shared warp geometry, `warp` on `drawing.text` and `drawing.insert`, warped rendering, the shared Transform menu) is implemented in all three kits; warp adjustment handles, exact Office warp formulas, and editing the text in its warped form remain open.

Build these capabilities as optional shared libraries in `kition-sdk`, with shared editor controls used by each kit. Each kit retains its document layout, anchoring, data binding, and file packaging. A feature is complete when a user can insert it, edit it, undo and redo changes, collaborate, save, reopen, and continue editing it in all three kits.

The rendering target remains 99.9% similarity for the agreed reference corpus. Editing correctness and visual similarity are separate mandatory acceptance dimensions; neither substitutes for the other.

## Existing implementation and gaps

Paths in this table are relative to the named repository.

| Repository and source | Current behavior | Required change |
| --- | --- | --- |
| `kition-word`, `crates/formats/docx/src/read/chart.rs` | Chart import produces `Vec<GraphicItem>` and estimates label widths. | Preserve chart series, categories, axes, bindings, and formatting as editable semantic data; generate drawing items from that model. |
| `kition-word`, `crates/engine/engine/src/cmd/insert.rs` | `insert.wordArt` inserts ordinary formatted text. | Create an editable drawing object with text, text effects, and warp parameters. |
| `kition-word`, `crates/engine/engine/src/cmd/draw.rs` | Drawing commands already support strokes and whole-stroke erasure. | Extract reusable stroke behavior while preserving Word anchoring and transaction behavior. |
| `kition-sheet`, `crates/engine/engine/src/cmd/draw.rs` | Ink point parsing uses `Shape.text`. | Migrate to typed stroke data, with a reader for existing documents. |
| `kition-sheet`, `crates/engine/chart/src/` | Chart resolution and drawing already form a separate subsystem. | Retain workbook range resolution in Sheet; share semantic chart layout and rendering. |
| `kition-slide`, `crates/support/geom/src/`, `crates/engine/model/src/`, `crates/render/render/src/` | Substantial geometry, style, text, and chart support already exists. | Extract capabilities incrementally, with evidence from fixtures; do not assume every existing implementation is correct or fully editable. |
| `kition-sdk`, `crates/` and `packages/` | Shared document contracts, KDM, convergence tooling, and kit UI infrastructure exist. | Add optional drawing domain modules without making unrelated kits depend on Office rendering. |

Inventory commands, UI controls, import, export, collaboration, and rendering separately. A command name or stored property alone is not evidence that editing works.

## Architecture and ownership

Follow [the kit SDK architecture](kit-sdk.md) and the normative Kit Standard. Define new cross-kit contracts in `kit-standard` first, then implement them in `kition-sdk`. Update affected repository architecture instructions that prohibit sharing before introducing dependencies. Align Rust toolchains and dependency versions during extraction.

The dependency direction is kit adapter and editor -> shared editing and rendering -> shared model and geometry. Shared modules must not import a kit, Kition's renderer, or its runtime. Each kit compiles the libraries into its own worker engine and bundles the UI, engine, and fonts in its self-contained package.

The following are proposed logical modules. Establish boundaries before deciding how many Cargo crates to publish.

| Shared module | Responsibilities |
| --- | --- |
| Drawing model | Stable object IDs; transforms; groups; styles; theme references; shape geometry; rich text; chart definitions; typed ink strokes; extension preservation. |
| Geometry and rendering | Preset and custom paths, adjustment formulas, bounds, clipping, fills, strokes, effects, shared text measurement, display lists, and consistent native/WASM output. |
| Editing | Selection, hit testing, handles, gesture state, command validation, edit operations, and selection overlays. |
| Chart engine | Series and axis semantics, resolved data, chart layout, element selection, and rendering. Workbook formulas remain outside this module. |
| Ink engine | Stroke acquisition, smoothing, pressure handling, selection, erasure, and stroke splitting. |
| DrawingML codecs | Common shape, style, text, chart, and supported ink serialization. Document package ownership stays with each kit. |
| Shared editor controls | Shape gallery, format inspector, chart data editor, pen controls, and WordArt controls, built on `@kition/kit-ui`. |

All document mutations run through the worker engine. Shared UI sends typed commands and reads selection descriptions; it must not maintain another authoritative object model. Engine overlays provide selection and editing geometry. Native headless execution uses the same commands and model as the browser editor.

### Boundaries that remain in each kit

| Kit | Adapter responsibilities |
| --- | --- |
| Word | Inline and floating anchors; paragraph and page attachment; wrapping; pagination and reflow; headers and footers; document relationships. Body text layout remains in Word. |
| Sheet | One-cell, two-cell, and absolute anchors; move and resize with cells; row and column mutations; merged or hidden cells; viewport and freeze-pane transforms; range references and formula recalculation. |
| Slide | Slide coordinates; master, layout, theme, and placeholder inheritance; slide-local relationships; animation references and object identity mapping. |

Adapters expose placement resolution, theme/font resources, data resolution, transaction application, and package access. Do not flatten these differences into one generic absolute-position field.

Use explicit unit types at boundaries. The proposed canonical drawing coordinate is a point using `f64`; OOXML geometry converts through 12,700 EMU per point. CSS pixels, device pixels, zoom, and DPI are view transforms. Preserve original values when an untouched property can be serialized without conversion loss. Add conversion tests before migrating Sheet's existing pixel-based paths.

## Editing capabilities to deliver

| Feature | First usable milestone in all three kits | Required follow-through |
| --- | --- | --- |
| Shapes | Insert rectangle, ellipse, and text box; select; move; resize; rotate; change fill and outline; edit text; delete; undo and redo. | Full inventoried preset coverage; custom paths and point editing; adjustment handles; connectors; groups; alignment and distribution; stacking order; gradients, image fills, effects, and text layout. |
| Charts | Insert and select a chart; edit categories and series in a data grid; change type; edit title, legend, axes, and labels; move and resize; save and reopen with editable data. | All types and properties in the compatibility matrix, including combination charts, secondary axes, error bars, trendlines, data labels, and advanced formatting where represented in the corpus. |
| Ink | Draw pen and highlighter strokes; adjust color and width; select and move strokes; erase a stroke; undo and redo; retain editable stroke data after reopening. | Pressure-aware strokes with deterministic fallback; lasso and multi-selection; segment erasure; stroke splitting; grouping and supported ink-to-shape conversion. Preserve available tilt and timing data. |
| WordArt | Insert a distinct object; edit actual text; change font, size, fill, outline, and a warp preset; move and resize; undo and redo. | Warp adjustment handles; rich text; alignment and autofit; gradients and effects; text input, caret and selection behavior under transformations. |

Every milestone includes visible controls in each kit's editor, keyboard access, command support for agents, read-only behavior, and persistence. A screenshot, flattened image, or text converted permanently to outlines does not satisfy editable content acceptance.

### Interaction and command contract

Define typed, versioned commands for object creation and deletion, transforms, style changes, text editing, chart data and property changes, and ink operations. Command names are finalized with the standard; existing kit commands remain compatibility aliases during migration.

Dragging uses transient previews. Pointer release commits one transaction; Escape or pointer cancellation discards the preview. One gesture creates one undo step. Multi-object changes are atomic, and selection does not mutate the document. Include mouse, touch, pen, keyboard nudging, focus transfer, and input method composition in the interaction matrix.

Describe selected objects and available properties through the existing kit model interface. Mixed selections return mixed values explicitly. Unsupported commands return structured errors, and unavailable controls expose their limitation rather than reporting success without changing the object. UI actions and agent commands must produce equivalent document changes.

### Model and collaboration contract

Integrate shared edits into each kit's existing KDM transactions and undo history. Do not add a separate drawing undo stack. Represent independently editable object properties, chart elements, text, and strokes with stable identities and appropriate KDM structures; avoid storing an entire scene as one last-writer-wins JSON blob.

Specify concurrent edit behavior for text versus formatting, chart data versus axis formatting, stroke deletion versus movement, grouping versus deletion, and local undo after remote changes. Clipboard duplication allocates new IDs and remaps group, connector, chart, and document references. Cross-kit paste preserves supported editable content and reports unsupported properties.

Keep layout, hit-test indices, display lists, and autofit caches derived from canonical data. Cache invalidation must include fonts, themes, bounds, content, and inherited properties. Recompute derived values without producing recurring collaboration repair edits or mutating a read-only document.

### Persistence contract

Import DOCX, XLSX, and PPTX objects into the shared semantic model while retaining their adapter-owned anchors and relationships. Export edits through the appropriate format adapter. Reopening the file must recover the edited properties and object identities needed within the document.

For charts, retain and update applicable embedded workbooks, formulas, and data caches consistently. Sheet owns live range bindings; Word and Slide expose embedded chart data through the shared data editor. Preserve external references without silently fetching or rewriting them.

Preserve unknown extension data and unsupported properties when their owning objects survive an edit. Known edited fields take precedence over preserved raw XML. Define ownership and invalidation rules so stale raw data cannot overwrite user edits. Inventory ink representations and fallback relationships per format; an exported preview must coexist with retained editable stroke data where the target supports it.

## Delivery phases

### Phase 0 Contracts and baseline

Create an architecture decision and capability matrix covering the four features in all three kits. Each row records import, render, hit testing, UI editing, commands, undo, collaboration, export, and reopen status, with fixture references. Record the source revisions, fonts, renderer, image dimensions, and strict comparison settings used by the current compatibility workflow.

Inventory `golden_ppt/shape` and `golden_ppt/chart/` including the full-property samples using their existing on-disk names. Use portable case IDs in new English reports. Add equivalent Word and Sheet fixtures, including existing failures and anchor-sensitive examples. Freeze the reference corpus and expected output before measuring improvement.

Deliver model and command schemas, adapter interfaces, migration/version policy, dependency and license review, and shared module ownership. Exit when a minimal three-kit vertical slice can be implemented without each kit inventing a different model or transaction protocol.

### Phase 1 An editable shape across all three kits

Extract only the model, geometry, style, command, and interaction subset needed for rectangles, ellipses, and text boxes. Wire it into all three worker engines and editors. Demonstrate insert -> text/style edit -> drag/resize -> undo/redo -> save -> reopen -> edit again in DOCX, XLSX, and PPTX.

Include one Word reflow case, one Sheet row/column insertion case, and one Slide inherited-theme case. Include a two-peer collaboration case and a read-only rejection case. A shared fill or geometry fix must pass all three kits without duplicating the implementation. This is the first implementation delivery, before a broad extraction of the Slide engine.

### Phase 2 Complete the shared drawing foundation

Migrate preset/custom geometry, effects, rich text, group transforms, connectors, adjustment handles, and selection tools in tested increments. Implement shared inspectors and property descriptions. Use differential rendering and editing fixtures to identify behavior changes before switching a feature's authoritative implementation.

Retain each kit's anchor and document layout behavior. Establish shared text shaping, font resources, and measurement for drawing objects without replacing Word body layout or Sheet cell layout. Exit when the common feature modules can build on stable geometry, text, commands, and persistence boundaries.

### Phase 3 Charts Ink and WordArt

Run these feature streams in parallel after the required foundation interfaces stabilize. Each stream delivers its first usable milestone across all three kits, then completes the inventoried advanced properties.

For charts, first replace Word's flattened import with semantic objects. Adapt Sheet's data resolver and Slide's chart model and renderer into the shared chart contract. Deliver the shared data editor and element inspector, then work through the full-property corpus. Shared text measurement must replace approximate character-width placement.

For ink, extract reusable stroke operations, migrate Sheet's text-encoded points, and implement shared tool state and erasure. Preserve stroke identity, undo boundaries, and format-specific editable representations. Add pressure and segment erasure only with persistence and convergence tests.

For WordArt, replace ordinary-text insertion with a shared drawing text object. Implement warp layout, text editing, selection, and effects over the shared text model. Verify input method composition and caret behavior while keeping export paths and derived outlines separate from canonical text.

### Phase 4 Compatibility convergence and release

Close remaining property gaps against the frozen visual and editing matrix. Run import-edit-export-reopen tests and native/WASM comparisons, remove superseded implementations after migration acceptance, and update command aliases and migration documentation.

Publish SDK revisions and kit packages through the established developer-machine workflow, pin all three kits to the tested versions, and update Kition package locks. Keep previous bundles and tested file migrations available for rollback. No new private-kit CI workflows are required by this plan.

## Five parallel workstreams

Use five workstreams for implementation, with one owner for each shared file or schema. Phase 0 and the first vertical slice establish dependencies before broad parallel work. If fewer execution slots are available, queue work without merging ownership boundaries.

| Stream | Ownership | Dependency and integration responsibility |
| --- | --- | --- |
| 1 Shared drawing foundation | Common model, geometry, styles, text substrate, selection, command schemas, and migration primitives. | Publishes interfaces and reviewable increments for other streams. |
| 2 Charts | Chart semantics, layout, data editor, formatting controls, and chart codec helpers. | Consumes shared geometry/text; coordinates workbook bindings with adapters. |
| 3 Ink | Typed strokes, pen tools, hit testing, erasure, and ink codec helpers. | Consumes transforms and transactions; owns legacy ink migration tests. |
| 4 WordArt | Drawing text editing, warp geometry, effects controls, and WordArt codec coverage. | Consumes shared text and shape interfaces; owns text-editing acceptance. |
| 5 Kit integration and verification | Three adapters, kit command registration, package wiring, end-to-end fixtures, and compatibility reports. | Integrates each feature into all three kits continuously and reports regressions. |

Stream 5 owns adapter files; feature streams submit interface requirements and tests rather than editing the same files concurrently. The integration owner must not become the only person testing features: each feature owner supplies unit, persistence, and interaction coverage with the implementation. Shared schema changes require coordinated updates and cannot land as incompatible partial migrations.

## Acceptance and verification

### Functional acceptance

For every supported feature/property row, verify UI edit -> canonical model change -> rendered result -> undo/redo -> export -> reopen -> another edit in all three kits. Check exact semantic values where the format permits them and documented numeric tolerances where it does not.

Test single and multiple selection, groups, transforms, clipboard, document anchors, zoom, keyboard focus, input method composition, Unicode text, font fallback, chart data dependencies, and read-only behavior. Include Chromium and WebKit interaction checks and execute both native and WASM engines.

Run KDM convergence scenarios with multiple peers, offline/reconnect edits, seeded interleavings, and undo after remote operations. Verify unknown-property preservation and legacy-document migration. Measure engine responsiveness, memory, and bundle size against frozen representative fixtures and the budgets in the SDK specification.

### Visual acceptance

Retain the existing strict similarity metric and freeze its configuration during Phase 0. A required case passes only at a score of at least 0.999 under that metric. Report pass counts, failures, and score distributions per object/property and page or slide; a corpus mean cannot hide failures. Include object-region checks so blank page area cannot conceal a materially wrong object.

Measure both untouched imports and edited-then-reopened documents. Use fixed fonts, reference images, viewport, raster scale, and renderer versions. Do not introduce blur, extra masking, looser thresholds, or regenerated reference images to inflate the score. Record renderer/font differences explicitly and fix or resolve them before declaring the relevant compatibility case complete.

Architecture extraction is complete only after its functional gates and no-regression checks pass. The overall compatibility objective remains open until every required case reaches 99.9%; extracting shared code alone does not meet that objective.

### Repository and release gates

Run the affected SDK and kit test suites, format/lint checks, contract checks, and convergence tests. Validate built engines with `pnpm check:kit-sdks`, check dependency boundaries with `pnpm check:deps`, and validate each manifest using the Kit Standard's `tools/check-manifest.mjs`. Record kit changes in their `KITION_CHANGES.md` files.

For Kition changes, run `python3 scripts/check-i18n.py`, `pnpm test:table:e2e`, and `pnpm test:ktable:e2e`. Run `pnpm check:desktop` when Rust changes affect the Kition workspace. Shared editor controls follow [the design specification](design.md), and all published packages remain self-contained.

## Migration risks and controls

| Risk | Control |
| --- | --- |
| A universal model loses Word, Sheet, or Slide behavior. | Keep anchor, layout, inheritance, and data-binding semantics in explicit adapters; require a representative test from each kit in every migration step. |
| A large extraction causes regressions that cannot be isolated. | Deliver one editable vertical slice first, then migrate property groups with old/new comparisons. Use one authoritative mutation path at a time. |
| Different font metrics or coordinate conversions prevent convergence. | Normalize units and shared drawing text measurement early; freeze fonts and test native/WASM output. |
| Shared data appears editable but export discards changes. | Make edit-export-reopen checks part of each milestone, including embedded chart data and retained ink points. |
| Schema or SDK changes break existing documents or packages. | Version schemas, test migrations, retain command aliases, and pin compatible SDK/kit revisions together. |
| Parallel work creates five separate implementations. | Stabilize the common contract first, assign module/file ownership, and integrate all three kits throughout development. |

The first implementation deliverable is the three-kit shape editing slice in Phase 1, accompanied by contracts and baseline fixtures from Phase 0. Further deliveries are accepted by demonstrated editing and persistence behavior, with visual progress reported against the unchanged 99.9% target.
