# Shared Office Drawing: Architecture Decision

Status: Accepted for Phase 1 (2026-10-21). Implements Phase 0 of the
[shared office drawing editing plan](../office-editing-unification-plan.md).
The capability evidence is in [capability-matrix.md](capability-matrix.md) and
the frozen visual baseline in [baseline.md](baseline.md).

## Context

Word, Sheet, and Slide each grew their own drawing objects. The
[capability matrix](capability-matrix.md) shows three very different starting
points:

- **Slide** has a full DrawingML shape model (preset and custom geometry,
  theme style references, rich text bodies, effects), engine tools with
  selection, handles, move, resize, rotate, adjustment handles, ink strokes,
  and fine-grained KDM objects for shapes and their text.
- **Word** stores a shape as an inline object with one of eleven kinds, RGB
  fill and pen, an optional text story, and a float placement. Its editor has
  only a text tool: objects cannot be selected, moved, or resized with the
  pointer. Charts and SmartArt are flattened into drawing items and written
  back from preserved XML. `insert.wordArt` inserts formatted body text.
- **Sheet** stores a shape with a cell anchor, a kind, RGB colors, plain
  text, and the original text body and style references as raw XML strings.
  Ink points are encoded in `Shape.text`. Its editor has a cell selection tool
  and a Home tab only: no drawing user interface.

A shared module therefore has two jobs. For Slide it replaces code that
already works, so it must be extracted from that code with old/new
comparisons. For Word and Sheet it supplies the object editing they do not
have yet.

## Decisions

### D1 Shared code lives in `kition-sdk`

The shared drawing code is a new crate, `kition-drawing`, in the
`kition-sdk` repository, next to the crates every kit already depends on. It
starts as one crate with internal modules (`model`, `geom`, `edit`, `ops`,
`display`, and later `ooxml`, `chart`, `ink`). A module becomes its own crate
only when a kit needs it without the others, for example a chart-only
consumer. The shared editor controls start as kit-ui's drawing module
(`DrawingInsertGroup`, `DrawingFormatGroup`), which every kit editor already
links; they move to their own package only if they outgrow it.

`kition-drawing` depends only on `serde` and `serde_json`. Kurbo conversion
is an optional feature, because Word and Slide draw with `vello_cpu` and
`kurbo` while Sheet uses its own rasterizer. The crate never depends on a
kit, on Kition, or on any renderer.

### D2 Kits build it from the sibling SDK checkout until it is published

While Phase 1 to 3 change the crate often, kits depend on `kition-drawing`
by path, from the `kition-sdk` checkout next to them. That is the same
checkout their editors already link `@kition/kit-ui` from, and the one
Kition's kit build scripts expect, so no new requirement is added.
`kition-drawing` does not depend on the `kition-sdk` crate, so a kit's pinned
`kition-sdk` revision is unaffected.

When the plan's Phase 4 publishes the SDK revision, kits switch to the same
git revision as their `kition-sdk` dependency. A revision that changes the
drawing schema bumps the crate's minor version, and all three kits move to
it together.

### D3 Canonical units are points

Drawing coordinates are points as `f64`. DrawingML converts through 12,700
EMU per point. CSS pixels, device pixels, zoom, and DPI are view transforms
owned by the kit. Sheet's anchors stay in its own units; its adapter
converts, with round-trip tests, before any Sheet path changes. Angles are
degrees clockwise. Untouched OOXML values are written back unconverted where
the kit keeps them (D9).

### D4 One model per object, identity owned by the kit

The shared model describes one drawing object: `Transform` (offset, size,
rotation, flips), `Geometry` (preset name and adjust values, or custom
paths), `Fill`, `Stroke`, `TextBody` (paragraphs of runs with their
properties, insets, anchor, wrap, autofit), and, as later modules land,
charts, strokes, and text warp. Colors are an explicit RGB value or a theme
slot with transforms; resolving a theme slot is the kit's job (D7).

Placement is not in the shared model. Word's float and wrap, Sheet's cell
anchors, and Slide's placeholder inheritance stay in each kit. An adapter
resolves the object's frame on its page, sheet, or slide into a shared
`Transform`, and writes a changed frame back into its own placement.

Object identity is the kit's: Slide's shape ids, Sheet's shape ids, and
Word's inline object positions. The shared code addresses objects through an
opaque `ObjectKey` supplied by the adapter.

### D5 Typed, versioned commands, one mutation path

The shared operations are a typed `DrawingOp` enum: insert, delete,
transform, set fill, set stroke, set geometry, set text, and later chart,
ink, and warp operations. Each operation validates its input and applies to
the shared model. A kit runs the operation inside its own command, so the
change goes through the kit's transaction, undo history, and KDM writer. No
second undo stack exists.

Agents and editors use the same commands. The Kit Harness Protocol set
`KitDrawing 1.0` (drafted in the kit-standard repository as
`spec/sets/drawing.md`) names them `drawing.insert`, `drawing.delete`,
`drawing.transform`, `drawing.format`, `drawing.text`, and `drawing.describe`.
Existing kit commands (`insert.shape`, `shape.fill`, `arrange.rotate`, and so
on) stay as aliases until Phase 4.

### D6 Gestures preview, release commits

The `edit` module holds hit testing, handle layout, and a gesture state
machine. A pointer down on a handle or a body starts a gesture. Each move
returns a preview transform, which the kit shows without changing the
document. Release returns one `DrawingOp`, which the kit commits as one
transaction. Escape and pointer cancellation discard the preview. Overlays
for selection and handles come from the engine, as the Kit UI protocol
requires.

Slide's existing tools currently edit the document live inside an open
interaction and commit on release. They move to previews when Slide adopts
the shared gestures. Until then both paths must give the same document after
release.

### D7 Rendering through a display list

The `display` module turns an object and its resolved resources into a
display list: filled and stroked paths in object space, plus text runs
positioned by the kit's text measurement. Each kit rasterizes the list with
its own renderer. The adapter provides theme colors, fonts, and text
measurement through a trait. Shared text shaping for drawing objects is a
Phase 2 decision, made once the display lists are compared across the three
renderers.

### D8 Collaboration uses each kit's KDM objects

Each kit writes shared objects into its replica at the granularity Slide
already uses: frame and name as their own registers, text bodies as
paragraph objects with run marks, and the other properties in one
properties register per object. A whole scene in one register is not
allowed. Word and Sheet adopt this granularity when their drawing objects
move to the shared model. Their Phase 1 tests include a two-peer case.

### D9 Known edits win over preserved XML

Kits keep unknown DrawingML (Slide's `raw_ext`, Sheet's `text_body` and
`style_refs`, Word's `vml` and embedded graphics). A preserved fragment is
written back only while the properties it covers are unchanged. Editing a
covered property invalidates the fragment, and the shared codec writes the
edited object. Each kit's tests cover an edited, preserved object.

### D10 Sharing is allowed for drawing code

Kit repositories currently say that kits do not share code. They already
depend on `kition-sdk`. That rule changes, in each kit's instructions,
when the kit first depends on `kition-drawing`. Drawing code may live in
`kition-sdk` and be depended on, never copied between kits.

## Dependency and license review

`kition-drawing` is Apache-2.0, like `kition-sdk`. The first code moved in
is Slide's preset geometry (`crates/support/geom` in the Slide kit), which is
Kition's own clean-room work derived from ECMA-376. Its dependencies are
`serde`, `serde_json`, and optional `kurbo` (Apache-2.0 or MIT). No asset,
font, or vendor-derived material is added. Every kit keeps its own asset and
clean-room rules.

## Migration and version policy

- Shared types derive `serde` with `#[serde(default)]` and only add fields
  within a minor version. A removed or renamed field bumps the major version
  and comes with a reader for the old form.
- Each kit keeps reading its existing documents. Sheet's text-encoded ink
  points are read into typed strokes, and written as typed strokes from then
  on.
- Kit command names remain as aliases of the `drawing.*` commands for at
  least one minor version after every kit supports them.

## Phase 1 scope

Rectangles, ellipses, and text boxes in all three kits, as the plan states:
insert, select, move, resize, rotate, fill, outline, text, delete, undo and
redo, save, reopen, and edit again. It includes one Word reflow case, one
Sheet row insertion case, one Slide inherited-theme case, a two-peer case,
and a read-only rejection case per kit.

The order:

1. `kition-drawing` with the model, preset geometry for the three kinds,
   hit testing, handles, gestures, operations, and display lists, and its own
   tests.
2. Slide adopts the geometry and gestures behind its existing commands, with
   old/new comparisons of hit testing and handle layout.
3. Sheet gains drawing objects in its editor through the shared gestures and
   a select tool for objects.
4. Word gains object selection, handles, and moving and resizing for floating
   and inline shapes.
