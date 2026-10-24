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

- **Phase 2, adjust handles and arrange (2026-10-22).** kition-sdk's shared
  gestures add adjust handles (`adjust_handles`, `hit_adjust`,
  `Gesture::adjusting`: a drag previews the new outline and commits one
  `drawing.format`), now in Word's and Sheet's editors (Slide had its own).
  `drawing.arrange` (`KitDrawing 1.4`, DR21; `kition_drawing::arrange`)
  moves objects in their stack in all three kits, and Shape Format's shared
  Arrange menus run it. Word keeps a floating object's place in the stack
  (`relativeHeight`) and lays a page's floating objects out in that order;
  inline objects have no place in it. Sheet keeps charts above shapes, so
  each moves among its own kind, and now saves the drawing part in the order
  it draws (charts were written under shapes). Evidence: the kits' engine
  tests (`floating_objects_move_in_the_stack…`,
  `shapes_and_charts_move_in_their_stacks…`,
  `objects_move_in_the_slides_stack…`, `a_shapes_adjust_handle_reshapes_it…`)
  and the Word and Sheet `web/tests/drawing.mjs` runs in Chromium and WebKit.
  Groups (`KitDrawing 1.4`, DR22): `drawing.group` and `drawing.ungroup` in
  Slide and Word, with a group described as kind `group` and its `members`
  (their ids kept through grouping and, in Word, through saving); a group
  moves, resizes and turns with its members, and a member is described where
  the group shows it but is changed through its group (`unsupported`
  otherwise). Word's editor adds objects to the selection with Shift, and
  Shape Format's shared Group and Ungroup run the commands (Word
  `web/tests/drawing.mjs`, Chromium and WebKit). Sheet groups too (since
  2026-10-23): a group's key is an object id, the group is one object in the
  sheet's list, moving or sizing it carries its members, and the editor
  selects and drags it as one, with Shift adding to the selection
  (`shapes_group_move_and_resize_together…`, Sheet browser runs).
  Gradient fills (`KitDrawing 1.4`, DR23): described and set through
  `drawing.format` in all three kits, from Shape Format's shared gradient
  presets in Word and Sheet (Slide's own Format pane sets them there). Word
  shapes now keep gradients at all: read from and written as `a:gradFill`,
  and painted by the rasteriser (PDF export draws the first colour for now).
  Evidence: each kit's `gradient_fills_…` engine test, Word's
  `a_gradient_fill_runs_from_its_first_colour_to_its_last` pixel test, and the
  Word and Sheet browser runs in Chromium and WebKit.
  Shadow and glow (`KitDrawing 1.4`, DR24): described and set through
  `drawing.format` in Slide and Word, from Shape Format's shared Effects menu
  in Word and Sheet (Slide's own Format pane sets them there). Sheet shapes
  keep them since 2026-10-23 (read from and written as `a:effectLst`, drawn
  under the shape).
  Word's PDF export now paints gradient fills as shadings. Evidence: the
  `shadows_and_glows_…` engine tests, Word's `a_gradient_fill_is_a_shading`
  PDF test, and the Word and Sheet browser runs in Chromium and WebKit.
  Rich text in shapes (DR8): `drawing.text` takes paragraphs with alignment
  and runs with font, size, bold, italic, underline and colour in all three
  kits, and `drawing.describe` reports them; Word writes them into the text
  box story, Sheet into a text body it draws and saves, Slide into its text
  body (each kit's `shape_text_takes_runs_…` test, save and reopen included).
  A colour is read as `#RRGGBB` or a theme slot wherever one goes.
  Connectors (`KitDrawing 1.4`, DR25): `drawing.connect` glues one between two
  shapes' sites in all three kits, and its ends follow the shapes in the same
  step. In Word and Sheet they follow every edit that moves a shape (a drag,
  a nudge, rows or columns inserted under it), not only `drawing.*` commands;
  Slide reroutes after every edit already. `drawing.reconnect` moves one end
  to another site or frees it, and in Word and Sheet a selected connector's
  ends drag with the pointer, snapping to sites in reach
  (`kition_drawing::connect::EndDrag`). Slide takes `drawing.reconnect`, and
  its canvas already drags connector ends onto sites and glues a line drawn
  from one shape to another in one drag. Evidence: the
  `connectors_follow_…` engine tests and the bindings'
  `a_connectors_end_drags_onto_another_shape_in_one_step` tests. A line from
  Insert › Shapes becomes a connector once its ends are dragged onto two shapes
  (`a_plain_line_glued_at_both_ends_…`, save and reopen included). In Word and
  Sheet, Insert › Shapes arms a shape (`draw.shape`) and a drag on the page or
  sheet draws it; a line drawn from one shape's site to another's is made with
  `drawing.connect`, a connector in one undo step
  (`kition_drawing::connect::CreateDrag`; the bindings'
  `a_shape_chosen_in_insert_shapes_…` tests and the Word and Sheet browser
  runs). Kits without `draw.shape` keep inserting at their default place.

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
- **Word and Slide:** a chart made here, or whose data were edited, is saved
  with a new embedded workbook of its data (`c:externalData`, the series bound
  to its ranges), so another application can edit the data as cells again. A
  type the description does not edit (bubble, stock) keeps its data as
  written. Sheet's charts show its own cells and need no workbook.
- **Formatting:** the description carries the category and value axes
  (bounds, major unit, number format, shown), the data-label position and
  each series' line width, marker and smoothing. Chart Design's shared Format
  group (Format Axis, Label Position, Format Series) sets them through
  `drawing.chart`, and each kit's browser test sets them, undoes them and, in
  Word and Slide, saves and reopens them. Slide writes them into its chart
  model, so they draw at once; Word patches the part and its renderer draws
  fixed major units, markers, smooth lines and label positions. Sheet takes a
  series' smoothing; its model has no axis scale, label position, line width
  or marker yet, so `drawing.chart` refuses them as unsupported and the
  editor does not offer them. Trendlines and error bars (DR16b) are
  described, set from Chart Elements › Trendline and Error Bars (on every
  series) or `seriesFormat`, saved and reopened in all three kits; the shared
  `kition_drawing::chart::trend` fits them and measures them, Word and Sheet
  draw them over unstacked series, and Slide draws them with its own renderer.
  Evidence: the `trendlines_…` engine tests and each kit's `chart.mjs` in
  Chromium and WebKit. Combinations on two axes (DR16c): a series' own type
  and `secondary` are described and set from Format Series or `seriesFormat`
  in all three kits, kept through saving; the shared codec groups series by
  type and axis, makes and removes the secondary axes, and keeps series in
  their `c:order` (reading, patching and binding a workbook). Word now draws a
  chart's every chart type, with a secondary value axis labelled on the right.
  Evidence: the `combinations_…` codec test, each kit's secondary-axis engine
  test, and Word's and Sheet's `chart.mjs` in Chromium.

- **Visual fidelity (Slide, 2026-10-22):** against the frozen baseline's chart
  set and settings, data table rows and the plot area border now follow the
  reference: mean SSIM 0.9506 to 0.9528, median 0.9645 to 0.9662, 1,167 of
  1,971 slides better and 380 worse. Strict passes stay at 1. Every chart deck
  sets its text in fonts the kits cannot ship (Microsoft YaHei, PingFang, and
  others), so no chart slide can reach the strict gate until open decision F1
  in the [baseline](baseline.md) is made; the best slide without that
  limit still differs in anti-aliasing and pattern-fill phase. Installed fonts
  are now found by their names in other languages, which helps on machines
  that have them (Windows with Microsoft YaHei), not in the measurement.

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
| Slide | Y | P | P | P | Y | Y | Y | Y | Y |
| Word | Y | P | P | P | Y | Y | Y | Y | Y |
| Sheet | Y | P | P | P | Y | Y | Y | Y | Y |

Text warp is `KitDrawing 1.3` (DR26 to DR28). The shared geometry is
`kition_drawing::warp`: each preset is an envelope (the curves the text's top
and bottom follow) or an arch, approximating Office's preset families rather
than their exact guide formulas, so warped text is not yet a strict-fidelity
match. Every kit lays its text out flat, stretches the glyph outlines over the
text area and bends them with that geometry. `drawing.text` and
`drawing.insert` take `warp` (a preset, `{preset, adjust}`, or `null`), and
`drawing.describe` reports it. Shape Format's shared Transform menu
(`DrawingWarpMenu`) offers 14 presets in every kit. Hit testing and the caret
use the flat text in every kit.

- **Slide:** `insert.wordArt` makes a text box with large, styled runs (fill
  and outline per style number). The body keeps a warp's preset and its
  adjust values, drawn with them and set by `drawing.text`. Warped text is drawn without its paragraph animation
  states and text effects. WordArt Styles › Transform runs `format.transform`
  on the selection.
- **Word:** a shape keeps its warp with adjust values (`wps:bodyPr/a:prstTxWarp`).
  The display list draws warped text as filled paths, so PDF export bends it
  too; underlines and highlights in warped text are not drawn. `insert.wordArt`
  still inserts formatted body text, not a drawing object.
- **Collaboration:** a warp set by one person and a move of the same shape
  by another both stay (Word's `drawing_frames` and Sheet's `drawing_shapes`
  replica tests). A shape's properties other than its frame and text are one
  field in Word and Sheet: two people changing two different ones at once
  (say a warp and a fill) keep one person's change, the same on every
  replica, which DR14 allows but Office does not do.
- **Sheet:** the warp lives in the shape's kept text body, with its adjust
  values. The page draws it bent with the shape, and printing to PDF fills
  the same bent outlines (in the page's face, Ubuntu Light).

## Reference corpus

| Kit | Shape cases | Chart cases | Ink cases | WordArt cases |
| --- | --- | --- | --- | --- |
| Slide | 168 decks under the PPTX corpus's `shape` folder | 178 decks under `chart` | 2 decks under the ink folder | Inside the shape and text decks; not separated yet |
| Word | Not separated yet | Not separated yet | Not separated yet | Not separated yet |
| Sheet | Not separated yet | Not separated yet | Not separated yet | Not separated yet |

The Word and Sheet corpora exist as archives next to the PPTX corpus. Phase 1
adds a drawing case list for each, by portable case id, before any Word or
Sheet drawing path changes.
