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
| Slide | P | P | Y | Y | Y | Y | Y | P | Y |
| Word | P | P | Y | Y | Y | Y | Y | P | Y |
| Sheet | P | P | Y | Y | Y | Y | Y | P | Y |

*(Phase 3, charts: all three kits implement `KitDrawing 1.1` charts through
kition-sdk's `kition_drawing::chart`, the shared description (`ChartSpec`),
the `drawing.chart` change and the DrawingML chart codec. Insert › Chart and
Chart Design are the shared kit-ui controls in every kit, so a person's edit
and an agent's are the same command. Each kit has a native test and a
Chromium and WebKit browser test that inserts, edits, undoes, saves, reopens
and checks read-only refusal.)*

- **Slide:** the semantic model maps to and from the shared description by
  position, so a series keeps its look. The kept chart part is patched with
  the shared codec instead of dropped, so formatting Slide does not model
  survives an edit: saving patches the kept part to the chart (an edit leaves it
  alone) and uses it when it reads back as the model. The data grid edits
  categories and series. A chart is its own KDM object (schema version 4), one
  map entry per member, so concurrent edits of one chart's title and data both
  stay.
- **Word:** a chart is described from its part; `drawing.chart` patches the
  part, keeps it on the chart object and draws it again. Inserted charts get
  a new part. Charts now move and resize (SmartArt diagrams stay frozen), and
  their frames are their own replica register, so a move and an edit made at
  once both stay. Chart text takes letters its font lacks from a fallback
  face. An edited chart keeps its description, not a patched part: the part
  stays as read or made and is patched when drawn or saved. In the replica
  (schema version 5) the description is its own object, one map entry per
  member, and the drawing is made again on every read, so concurrent edits of
  one chart's members all stay.
- **Sheet:** a chart shows its cells: it is described with the values its
  ranges hold, and its type, titles, legend, labels, gridlines and series
  colours change by command; categories and series are refused (DR16), and
  the editor has no data grid. Charts are now drawing objects the pointer
  selects, moves and resizes. Charts are KDM objects of their own (schema
  version 4: anchor register, one map entry per member, ranges still stored as
  positions), so concurrent edits of different charts, or of one chart's
  members, all stay; a schema 3 replica migrates its charts on the first
  write.
- **All kits:** an edit that changes the data detaches it from the embedded
  workbook (literal values, no stale `c:externalData`), so another
  application shows the edited values but cannot edit them as cells (open:
  rewriting the embedded workbook). Element-level formatting (axes, number
  formats, trendlines, error bars) is preserved but not yet editable.

## Ink

| Kit | Import | Render | Hit | UI | Cmd | Undo | Collab | Export | Reopen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Slide | P | Y | Y | Y | Y | Y | P | Y | Y |
| Word | P | P | Y | Y | Y | Y | Y | Y | Y |
| Sheet | P | P | Y | Y | Y | Y | Y | Y | Y |

*(Phase 3, ink: all three kits implement `KitDrawing 1.2` ink through
kition-sdk's `kition_drawing::ink`: the shared stroke (tool, colour, width,
points with pressure), `drawing.ink` and `drawing.erase`, a pen gesture that
previews and adds one stroke on release, and an eraser whose swept path takes
the strokes it touches on release, each one undo step. The Draw tab is the
shared kit-ui `InkGroup` in every kit, driving the same `draw.*` commands and
`draw.state`. Each kit has native tests and a Chromium and WebKit browser test
that draws, undoes, erases, saves, reopens and checks read-only refusal.)*

- **Slide:** strokes stay in the slide's ink layer (one ink shape). The eraser
  was a point test that pushed an undo step per pointer event; it is now the
  shared swept-path gesture, one step per drag. Saved ink (a group of `Ink N`
  freeforms) now reads back as ink instead of a group of shapes; pressure is
  not kept in the file (read back as 0.5). The ink layer is one KDM properties
  value: two people drawing on one slide at once keep one side's strokes
  (open).
- **Word:** a stroke is a floating freeform (the existing `draw.stroke`); the
  editor now draws and erases with the pointer, which it could not before.
  Each stroke is its own inline object, so concurrent strokes merge.
- **Sheet:** a stroke is an `Ink` shape (its own KDM object). The editor now
  draws and erases with the pointer; a stroke's width is kept exactly and its
  pen (pencil, highlighter) in its outline's opacity. Saved ink was written as a
  rectangle holding its points as text; it is now an open freeform path that
  Excel draws and Kition reads back as ink.

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
