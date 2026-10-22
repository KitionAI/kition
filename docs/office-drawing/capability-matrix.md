# Shared Office Drawing: Capability Matrix

Status: Phase 0 baseline, 2026-10-21. Part of the
[shared office drawing editing plan](../office-editing-unification-plan.md);
decisions in [decision.md](decision.md).

Each cell records what the kit does today for the feature, judged from its
source and tests, not from a command name alone (plan: "a command name or
stored property alone is not evidence that editing works"). Every row is
re-verified with a test when its phase lands, and the cell then names that
test.

| Mark | Meaning |
| --- | --- |
| Y | Implemented and covered by a test |
| P | Partial: some properties or kinds, or not editable |
| N | Missing |
| ? | Not verified yet |

Columns: **Import** reads the object from the kit's Office format. **Render**
draws it. **Hit** finds it under the pointer. **UI** edits it in the kit's own
editor. **Cmd** edits it through commands, which agents use. **Undo** undoes
and redoes the edit as one step. **Collab** merges concurrent edits through
KDM at object granularity. **Export** writes the edit. **Reopen** reads the
edit back as editable data.

Source revisions at the Phase 0 baseline: Slide kit `cfa3929`, Word kit
`967b531`, Sheet kit `1271e80`, SDK `469247d`. Rows marked *(Phase 1)* were
re-verified on 2026-10-21 at Slide `1a32b3c`, Sheet `40146b0`, SDK `405a379`.

## Shapes

| Kit | Import | Render | Hit | UI | Cmd | Undo | Collab | Export | Reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Slide *(Phase 1)* | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Word *(Phase 1)* | P | Y | Y | Y | Y | Y | Y | Y | Y |
| Sheet *(Phase 1)* | P | Y | Y | Y | Y | Y | Y | Y | Y |

- **Phase 1 evidence.** Slide: `cmd/drawing.rs` tests (the `drawing.*`
  commands, undo, PPTX round trip, atomic failure, read-only refusal) and
  `tests/kdm_bridge.rs` `concurrent_drawing_commands_on_one_shape_keep_both_sides`.
  Sheet: `cmd/drawing.rs` (commands, XLSX round trip, row insertion moves the
  shape), `bindings/wasm/src/objects.rs` (pointer move, resize, rotate, Escape,
  typing, nudge, delete, reopen), `kdm-model` `tests/drawing_shapes.rs` (two
  peers, migration), and `web/tests/drawing.mjs` in Chromium and WebKit. Sheet
  import stays P: shape text keeps only plain text as an editable property.
  Word: `cmd/drawing.rs` (commands, DOCX round trip of id, preset, frame and
  text, copies get new ids), `outline.rs`, `bindings/wasm/src/objects.rs`
  (pointer move, resize, rotate, Escape, nudge, reopen), `kdm-model`
  `tests/drawing_frames.rs` (move against format on two peers, schema 3
  migration), and `web/tests/drawing.mjs` in Chromium and WebKit. Word import
  stays P: theme colours and run formatting of shapes are not modelled; colours
  are RGB.
  Ids (DR2): Word's and Sheet's are the file's drawing ids, replicated, so
  they survive both replicas and reopening a file. Slide's are the shapes'
  replica objects: the same on every replica and across reopening with the
  replica, but new when a PPTX is opened without one (DR2's SHOULD).
- **Slide:** full DrawingML model (`Geom` preset and custom, theme style
  references, effects, text bodies). Engine tools select, move, resize,
  rotate, and adjust. KDM keeps the frame, name, and text paragraphs as their
  own objects. Visual fidelity is measured separately ([baseline.md](baseline.md)).
- **Word:** eleven shape kinds, RGB fill and pen, a text story, effects, and a
  float placement. The importer maps preset names onto those kinds, so other
  presets lose their geometry. `insert.shape`, `shape.fill`, `shape.outline`,
  `shape.change`, and `arrange.*` exist. The editor's only tool is the text
  tool: no object selection, handles, or pointer moves. Shapes are KDM
  `Inline` objects anchored in paragraph text; their merge granularity is not
  verified. *(Phase 1: presets are kept and drawn from the shared catalog,
  shapes have ids, the editor selects, moves, resizes and turns objects, and a
  shape's frame is its own KDM register.)*
- **Sheet:** nine kinds plus a kept preset name, custom geometry, gradient,
  outline, rotation, and flips. Text is a plain string, with the original text
  body and style references kept as raw XML. KDM stores each shape as one
  JSON value with a position-token anchor. The editor has no drawing user
  interface. `insert.shape` and `shape.setText` exist. *(Phase 1: shapes are
  KDM objects of their own; presets come from the shared catalog; the editor
  selects, moves, resizes, turns, formats and types into shapes.)*

## Charts

| Kit | Import | Render | Hit | UI | Cmd | Undo | Collab | Export | Reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Slide | P | P | P | N | P | Y | P | P | P |
| Word | P | P | N | N | N | N | N | P | P |
| Sheet | P | P | ? | N | P | ? | P | P | P |

- **Slide:** a semantic model (type, categories, series, legend, labels,
  axes, style, palette). The writer emits a `c:chartSpace` with cached values
  and no embedded workbook, so the data cannot be edited in another
  application. Only `chart.type` is a command; editing chart data is an open
  P0 item. The whole chart is one KDM properties value.
- **Word:** charts are flattened into drawing items at import, with label
  widths estimated. They are written back from the preserved XML, so the
  file survives, but nothing is editable.
- **Sheet:** a chart subsystem (`crates/engine/chart`) resolves workbook
  ranges, and the `chart.*` commands (change type, select data, add element,
  format) edit it. The writer emits chart parts. The editor shows charts but
  has no chart user interface.

## Ink

| Kit | Import | Render | Hit | UI | Cmd | Undo | Collab | Export | Reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Slide | P | Y | Y | Y | P | Y | P | P | P |
| Word | P | P | N | N | P | Y | ? | ? | ? |
| Sheet | ? | P | N | N | P | ? | P | P | P |

- **Slide:** `ShapeKind::Ink` with typed strokes (points with pressure, color,
  width). The engine's ink tool draws pen and highlighter strokes; the eraser
  removes a whole stroke. The importer reads ink content parts. The strokes
  are one KDM properties value.
- **Word:** `draw.pen`, `draw.pencil`, `draw.highlighter`, `draw.stroke`, and
  `draw.erase` keep strokes as freeform shapes. The editor has no pen tool.
- **Sheet:** ink points are text encoded as `x,y;x,y` in `Shape.text`.
  `draw.pen`, `draw.eraser`, `draw.lasso`, `draw.stroke`, and
  `draw.inkToShape` exist. The editor has no pen tool.

## WordArt

| Kit | Import | Render | Hit | UI | Cmd | Undo | Collab | Export | Reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Slide | P | P | Y | P | P | Y | Y | P | P |
| Word | N | N | N | N | N | Y | N | N | N |
| Sheet | N | N | N | N | N | N | N | N | N |

- **Slide:** `insert.wordArt` makes a text box with large, styled runs (fill
  and outline per style number). Text warp (`a:prstTxWarp`) and text effects
  are not modelled as editable properties. The text stays editable.
- **Word:** `insert.wordArt` inserts formatted body text, not a drawing
  object.
- **Sheet:** `insert.wordArt` is listed in the feature catalog with no
  drawing object behind it.

## Reference corpus

| Kit | Shape cases | Chart cases | Ink cases | WordArt cases |
| --- | --- | --- | --- | --- |
| Slide | 168 decks under the PPTX corpus's `shape` folder | 178 decks under `chart` | 2 decks under the ink folder | Inside the shape and text decks; not separated yet |
| Word | Not separated yet | Not separated yet | Not separated yet | Not separated yet |
| Sheet | Not separated yet | Not separated yet | Not separated yet | Not separated yet |

The Word and Sheet corpora exist as archives next to the PPTX corpus. Phase 1
adds a drawing case list for each, by portable case id, before any Word or
Sheet drawing path changes.
