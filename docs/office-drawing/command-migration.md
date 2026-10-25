# Drawing command migration

Kition Doc, Sheet and Slide each had their own commands for shapes, charts
and ink before the shared `drawing.*` commands (`KitDrawing`, in the Kition
SDK's `docs/platform/sets/drawing.md`). [The decision](decision.md) keeps the
kit commands as aliases for at least one minor version after every kit
supports the shared ones. This page lists, per kit, which kit command a shared
command covers and which kit commands have no shared counterpart. Agents
should use the shared commands; the kit commands remain for the kits' own
ribbons and for compatibility.

All three kits implement every shared command:

| Shared command | Changes |
| --- | --- |
| `drawing.insert` | Makes a shape, text box, chart or WordArt (`warp`) object |
| `drawing.delete` | Deletes objects |
| `drawing.transform` | Moves (`dx`, `dy`), turns (`rotateBy`), flips (`flipH`, `flipV`), or sets one object's `frame` |
| `drawing.format` | Fill, outline (`stroke`), geometry (preset and adjust values), effects |
| `drawing.text` | Text, paragraphs and runs, the text frame (`body`: anchor, insets, wrap, autofit), and the warp |
| `drawing.arrange` | Stacking order (`front`, `back`, `forward`, `backward`) |
| `drawing.group`, `drawing.ungroup` | Grouping |
| `drawing.connect`, `drawing.reconnect` | Connectors between objects, and their glued ends |
| `drawing.chart` | A chart's type, titles, legend, labels, axes, series formatting, and (Doc and Slide) its data |
| `drawing.ink`, `drawing.erase` | Adds ink strokes; erases the strokes a path touches |
| `drawing.describe` | Reads objects in the shared description |

## Doc

| Kit command | Shared command |
| --- | --- |
| `insert.shape` | `drawing.insert` with `geometry` |
| `insert.textBox` | `drawing.insert` with `kind: "textBox"` |
| `insert.wordArt` | `drawing.insert` with `warp` (the kit command also applies a WordArt style) |
| `insert.chart` | `drawing.insert` with `kind: "chart"` |
| `shape.fill` | `drawing.format` `fill` |
| `shape.outline` | `drawing.format` `stroke` |
| `shape.change` | `drawing.format` `geometry` |
| `shape.effects` | `drawing.format` `effects` |
| `arrange.rotate`, `arrange.rotation`, `arrange.nudge` | `drawing.transform` |
| `arrange.bringForward`, `arrange.sendBackward` | `drawing.arrange` |
| `arrange.group`, `arrange.ungroup` | `drawing.group`, `drawing.ungroup` |
| `draw.stroke` | `drawing.ink` |
| `draw.erase` | `drawing.erase` |

Doc-only: `arrange.position`, `arrange.wrap`, `arrange.align`,
`arrange.bounds` and `arrange.selectionPane` (an object's anchoring and text
wrapping in the flow of the document), the `picture.*` commands, and the
Draw tab's tool commands (`draw.pen`, `draw.pencil`, `draw.highlighter`,
`draw.eraser`, `draw.select`, `draw.shape`, `draw.state`), which choose a
pointer tool rather than change the document.

## Sheet

| Kit command | Shared command |
| --- | --- |
| `insert.shape` | `drawing.insert` with `geometry` |
| `insert.textBox` | `drawing.insert` with `kind: "textBox"` |
| `insert.wordArt` | `drawing.insert` with `warp` (the kit command also applies a WordArt style) |
| `insert.chart` | `drawing.insert` with `kind: "chart"` and a `range` |
| `shape.setText` | `drawing.text` |
| `object.move`, `chart.move` | `drawing.transform` |
| `object.delete`, `chart.delete` | `drawing.delete` |
| `chart.changeType` | `drawing.chart` `kind` |
| `chart.set` | `drawing.chart` (type, title, legend, data labels, gridlines) |
| `chart.addElement`, `chart.quickLayout` | `drawing.chart` (title, axis titles, legend, data labels, gridlines, trendlines, error bars) |
| `chart.changeColors` | `drawing.chart` `seriesFormat` colours |
| `arrange.rotate` | `drawing.transform` `rotateBy` |
| `arrange.bringForward`, `arrange.sendBackward` | `drawing.arrange` |
| `arrange.group` | `drawing.group` |
| `draw.stroke` | `drawing.ink` |

Sheet-only: `chart.selectData` and `chart.switchRowColumn` (a sheet chart
shows its cells, so its data change with its ranges, not through
`drawing.chart`), `chart.formatSelection`, `chart.shapeFill`
and `chart.shapeOutline`, `object.setAnchorMode` (how an object follows its
cells), `arrange.align` and `arrange.selectionPane`, `draw.inkToShape` and
`draw.lasso`, and the Draw tab's tool commands.

## Slide

| Kit command | Shared command |
| --- | --- |
| `shape.insert` | `drawing.insert` with `geometry` |
| `insert.textBox` | `drawing.insert` with `kind: "textBox"` |
| `insert.wordArt` | `drawing.insert` with `warp` (the kit command also applies a WordArt style) |
| `insert.chart` | `drawing.insert` with `kind: "chart"` |
| `shape.fill` | `drawing.format` `fill` |
| `shape.line` | `drawing.format` `stroke` |
| `shape.change`, `shape.adjust` | `drawing.format` `geometry` (preset and adjust values) |
| `shape.effects` | `drawing.format` `effects` |
| `shape.move`, `shape.resize`, `shape.rotate`, `shape.setBounds`, `shape.flip` | `drawing.transform` |
| `arrange.rotateLeft`, `arrange.rotateRight`, `arrange.flipHorizontal`, `arrange.flipVertical`, `arrange.nudge` | `drawing.transform` |
| `arrange.bringForward`, `arrange.sendBackward`, `arrange.bringToFront`, `arrange.sendToBack`, `arrange.reorder` | `drawing.arrange` |
| `arrange.group`, `arrange.ungroup`, `arrange.regroup` | `drawing.group`, `drawing.ungroup` |
| `shape.connect` | `drawing.connect` |
| `chart.type`, `chart.options`, `chart.data` | `drawing.chart` |
| `format.transform` | `drawing.text` `warp` |
| `format.anchor`, `format.margins`, `format.autofit`, `format.wrap` | `drawing.text` `body` |

Slide-only: `shape.merge`, `shape.freeform` (custom geometry drawn by
pointer), `shape.lock`, `shape.rename`, `shape.altText`, `shape.visible`,
`shape.quickStyle`, `shape.setDefault`, the queries `shape.presets`,
`shape.sites` and `shape.inspect`, `arrange.align` and `arrange.distribute`,
the `picture.*` commands, text formatting (`format.*` on runs and paragraphs),
and the Draw tab's tool commands.

## Removing the aliases

A kit command is removed only after its kit's ribbon, keyboard shortcuts and
tests run the shared command instead, and after one minor version in which
both exist. The kit commands without a shared counterpart stay: they carry
the kit's own layout, anchoring or data semantics, which the plan keeps in
each kit.
