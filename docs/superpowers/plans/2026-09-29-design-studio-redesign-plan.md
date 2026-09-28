# Design Studio Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Public contract changes come first, then the client mock, then the private runtime, per the closed runtime boundary in `AGENTS.md`.

**Goal:** Turn the Design feature from a bare poster editor into the place where a Kition user produces finished visual assets (posters, covers, social cards, product shots with copy) with the Agent and the image studio doing the heavy lifting, while the editor stays precise enough to fix the last 10 percent by hand.

**Status of this document:** an assessment and a proposed direction. Section 3 lists the decisions the maintainer should confirm before Phase 1 starts. Everything else is ready to execute.

---

## 1. What exists today

Measured on 2026-09-29 at commit 5ba3fe07. Screenshots were taken through the mock backend at 1440 by 900.

### 1.1 Scope of the current editor

| Area | Today |
| --- | --- |
| Document | One artboard per file (`pages: [DesignPage]`), `.kidesign` JSON, revision counter, autosave with recovery (`designSession.ts`). |
| Node types | text, image, rectangle, ellipse, line, group. 2,000 node cap. |
| Text | One style per node: 3 system fonts (Arial, Georgia, Courier New), size, weight (400 or 700), align, line height, letter spacing. No rich text, no text styles, no font loading. |
| Images | Workspace assets by path, crop in source pixels, "Use in design" from finished generated images, "Create design from image". Missing-asset banner. |
| Editing | Select, move, resize, rotate handles, snap to siblings and artboard with guides, group, reorder, duplicate, undo and redo, clipboard, layer list, inspector with numeric fields. |
| Starters | Four fixed layouts (editorial, event, promotion, quote) rendered from code in `designStarters.ts`. |
| Export | PNG or JPEG of the artboard through an SVG render to canvas. No SVG, PDF, or multi-size export. |
| Agent | None. The Agent pane maps a design tab to the generic gallery context and receives no document state; its three suggested prompts only produce text in the chat. No design patch contract exists. |
| Tests | 3 unit spec files (model, session, snapping), 3 e2e files with 7 tests, one of them a 520-layer performance check. |

### 1.2 Why it reads as simple

- **Nothing carries the user past the blank artboard.** Four starters, no brand colors, no fonts beyond system defaults, no sizes beyond four presets. The image studio produces rich posters next door, but a finished image lands in Design as a single locked layer with no editable headline.
- **The Agent cannot touch the canvas.** The Whiteboard has a typed context and patch contract (`agent-whiteboard.schema.json`), a preview layer, and accept or reject. Design has a chat empty state that suggests "write a headline" and then leaves the user to paste it.
- **Precision tools stop at the inspector.** Alignment only against the artboard center, no distribute, no smart layout, no constraints when the artboard is resized, no rulers or margins, no text auto-fit.
- **Output is one raster.** Marketing work needs the same design in several sizes and formats, and a way to hand it to a document, a table row, or a Board.

### 1.3 What is worth keeping

- The pure model under `src/features/design/lib/`: matrix transforms, bounds, snapping, and commands are tested and small. Everything below builds on them rather than replacing them.
- The session and recovery behavior, the missing-asset handling, and the portable `.kidesign` format with in-workspace asset paths.
- The performance budget the e2e enforces (520 layers with 20 images stays interactive).

---

## 2. Direction

### 2.1 Product framing

Design becomes **Design Studio**: the output stage of the visual pipeline. The image studio and the Agent generate; Design composes, applies the brand, adds editable copy, and exports in every size the user needs.

Three principles:

1. **Start from something.** Every new design begins from a template, a generated image, a Board frame, or a table record, never from an empty artboard unless the user asks for one.
2. **The Agent edits the design, the user approves.** The same preview, accept, and reject loop the Whiteboard already has, driven by a typed patch contract.
3. **Manual tools are for finishing.** Alignment, distribution, constraints, text styles, and multi-size export exist so a nearly-right result becomes right in a few clicks.

### 2.2 Approaches considered

| Approach | Summary | Verdict |
| --- | --- | --- |
| A. Polish the current editor | Better inspector, more starters, SVG export. | Cheap, but leaves the blank-artboard problem and no Agent path. Not enough on its own. |
| **B. AI-native studio on the existing model (recommended)** | Keep the `.kidesign` model, add templates as data, a design patch contract, brand kits, text styles, layout tools, and multi-size export, in that order. | Reuses tested code, matches how the Whiteboard grew, ships value each phase. |
| C. Embed a third-party design engine | Drop in an external editor library. | Conflicts with the closed runtime boundary, the i18n rules, offline use, and the portable file format. Rejected. |

Approach B is the plan below.

### 2.3 Interaction sketch

```
┌─ Topbar: title · Saved · Undo/Redo · Size ▾ · Brand ▾ · [Generate ▾] · [Export ▾] ─┐
├ Tools ┬ Panel (Templates | Layers | Assets | Text styles) ┬ Artboard(s) ┬ Inspector ┤
│  ▸    │ Templates: search, categories, brand-aware       │            │ Position  │
│  T    │ previews rendered from the same data the canvas   │  ┌──────┐  │ Fill      │
│  ▣    │ uses (no separate thumbnails to keep in sync)     │  │      │  │ Text style│
│  ○    │                                                   │  │      │  │ Layout    │
│  ⌇    │ Assets: workspace images, generated results,      │  └──────┘  │ (align,   │
│  ⧉    │ drag onto the artboard                            │            │  distribute,│
│  ⚙    │                                                   │  Agent preview overlay │
└───────┴───────────────────────────────────────────────────┴────────────┴───────────┘
```

- The **Generate** menu opens the image studio scoped to the current artboard size, with the template's `editableText` landing as a text layer instead of baked pixels.
- The **Agent preview overlay** draws proposed changes as translucent layers with an accept and reject bar, identical to the Whiteboard's `WhiteboardAgentPreview`.
- **Brand** applies a brand kit (colors, fonts, logo) to the selection or the whole design; templates declare which slots take brand values.
- **Size** switches artboard presets and, with constraints on, reflows layers instead of leaving them in the top-left corner.

---

## 3. Decisions for the maintainer

The plan proceeds under the first option of each item unless told otherwise.

- **D1. Font strategy.** (a) Bundle a small open-license family set (Inter, a serif, a mono, a display face) with the desktop app and embed them in exports; (b) system fonts only, as today. Bundling changes the packaged size by a few megabytes and needs license files in `docs/legal`. The plan assumes (a) because exports must look the same on every machine.
- **D2. Agent patch scope for v1.** (a) Text, style, and layout operations only, images through the existing generation flow; (b) also let the Agent create image layers from a prompt inside the patch. The plan assumes (a): it keeps the contract small and reuses the image studio's tested path.
- **D3. Multi-page.** (a) Keep one artboard per file and add "size variants" of the same design; (b) real multi-page documents. The plan assumes (a): variants cover social-size sets, which is the concrete need, and the file format stays a `[DesignPage]` tuple.
- **D4. Brand kit location.** (a) A workspace-level `.kition/brand.json` with colors, fonts, and a logo path; (b) per-design only. The plan assumes (a) so templates and the Agent share it.

---

## 4. Contracts (public repository first)

All new runtime behavior is specified as JSON Schema under `contracts/runtime/`, mirrored to the private runtime repository, validated in `src/test/contracts.ts` specs, and mocked in `e2e/` before the runtime implements it.

- **`agent-design.schema.json`** (new): `context` (artboard size, brand kit summary, selected layer ids, compact layers with kind, bounds, text, style, and role hints) and `patch` (operations: `text.set`, `style.set`, `layer.create` for text and shapes, `layer.move`, `layer.resize`, `layer.reorder`, `layer.delete`, `layout.align`, `layout.distribute`, `artboard.background`). Mirrors the Whiteboard contract's shape so the runtime can share the preview and validation code paths. Capability flag `agent_design_v1`.
- **`agent-image-generation.schema.json`** (extend): a `designTarget` next to `whiteboardTarget` so a generated image lands on a named artboard and, when the template has `editableText`, the headline arrives as a separate `text` layer.
- **`template-package.schema.json`** (extend): a `design` template kind with slots (`headline`, `body`, `image`, `logo`, `accent`) and brand bindings, so design templates ship as data alongside the existing table and Board templates.

---

## 5. Phases and tasks

Each task is one branch on `main`, lands with unit specs for pure logic and an e2e for the user-visible path, and passes the standard gates (`pnpm run check`, the CI e2e sweep, `pnpm test:table:e2e`). UI work follows `docs/design.md`: 8px buttons, 12px cards, purple primary, light surfaces.

### Phase 1: Foundations (model and contract) — 2 weeks

- [ ] **1.1 Text styles and fonts.** Add `textStyles` to the document (name, font, size, weight, line height, letter spacing, color) and a `styleId` on text nodes; the inspector edits the style or detaches it. Bundle the font set (D1a) with `@font-face` in `design.css` and embed in exports. Specs: style application and detach; export renders the bundled font.
- [x] **1.2 Layout constraints.** Each node gains `constraints: { horizontal: 'left' | 'center' | 'right' | 'scale', vertical: 'top' | 'center' | 'bottom' | 'scale' }`; artboard resize reflows children by constraint. Pure function `applyArtboardResize(doc, nextSize)` with table-driven specs; e2e: switching from poster to story keeps the headline centered.
- [x] **1.3 Alignment and distribution commands.** `align` gains left, right, top, bottom against the selection or the artboard; add `distribute` (horizontal, vertical, equal gaps). Selection toolbar shows them, keyboard shortcuts through `useShortcut`. Specs on the command reducer; e2e for one align and one distribute.
- [x] **1.4 Design patch contract.** Write `agent-design.schema.json`, generate types, add `designAgentContext.ts` (context builder, pure, tested against the contract) and `designAgentPatch.ts` (validate and apply a patch into the command reducer as one undo step). Mirror the schema to the runtime repository. No UI yet.
- [ ] **1.5 Template data model.** Extend the template package schema with the `design` kind; convert the four code starters into data under `public/templates/design/` with slots and previews rendered from the data; `DesignLibrary` reads the package. Specs: slot filling and brand binding; e2e: choosing a template produces the expected layers.

### Phase 2: Generate and edit with the Agent — 2 weeks

- [ ] **2.1 Agent context and preview.** The Design tab reports `paneContext: 'design'` with the design context; add `DesignAgentPreview` (translucent proposed layers, accept and reject bar) reusing the Whiteboard preview's structure; patches apply through 1.4. Mock the stream in e2e as `whiteboard-agent.spec.ts` does; assert a headline change previews, applies on accept, and reverts on reject in one undo step.
- [ ] **2.2 Image studio into the artboard.** "Generate" in the topbar opens the image studio scoped to the artboard size; results arrive through the `designTarget` extension as an image layer with the template's editable headline as a text layer. e2e with the mocked generation events.
- [ ] **2.3 Brand kit.** `.kition/brand.json` (D4a) with colors, fonts, and logo path; a Brand menu applies it to the selection or design; templates bind slots to brand values on insert. Settings gets a small brand editor. Specs for binding resolution; e2e for applying a brand color to a selection.
- [ ] **2.4 Start-from surfaces.** New design from: a template (default), a generated image (existing action, now keeping text editable), a Board frame (rasterize or import shapes), a table record (fields fill template slots, one design per row through the existing batch table scenario). Each entry is a small adapter into the template slot filler.

### Phase 3: Finishing and output — 1.5 weeks

- [ ] **3.1 Size variants.** A design keeps named variants (poster, story, square, landscape) that share layers and differ by constraints and overrides; the topbar Size menu switches and creates them. Export offers "all variants". Specs on the variant override merge; e2e: create a story variant and export both.
- [ ] **3.2 Export formats.** SVG (already the render path) and PDF (through the existing document PDF pipeline) join PNG and JPEG; export presets remember scale and background. Contract test that the SVG is valid and embeds fonts.
- [ ] **3.3 Canvas polish.** Rulers and margin guides, smart spacing guides between three or more layers, text auto-fit within its box, image fit and fill modes, Alt-drag duplicate, arrow-key nudge with Shift. Each with a spec on the pure helper and one e2e assertion.
- [ ] **3.4 Hand-off.** "Insert into document" (Markdown image link to the exported asset), "Send to table" (attachment cell on the source record), and "Copy as image" reuse the existing clipboard and asset paths.

### Phase 4: Quality and consistency — 1 week

- [ ] **4.1 Localize** every new string in all six locales through the existing parity check; no raw strings pass the i18n baseline.
- [ ] **4.2 Accessibility.** Inspector fields labelled, toolbar buttons with names and shortcuts in tooltips, focus order through the panels, reduced motion respected by the preview overlay.
- [ ] **4.3 Performance.** Keep the 520-layer e2e green; add a 2,000-layer variant behind the budget; virtualize the layer list.
- [ ] **4.4 Documentation.** A `docs/design-studio.md` user guide with screenshots captured through `pnpm capture:readme:assets`, and a README scenario entry.

---

## 6. Sequencing and estimates

Phase 1 unblocks everything; 1.1 to 1.3 can run in parallel, 1.4 and 1.5 after the contract review. Phase 2 needs the runtime side of 1.4 and the image studio extension; the client lands first behind capability flags so an older runtime keeps today's behavior. Phase 3 is client-only. Total: about six and a half weeks of focused work for one engineer, less with the tasks split.

## 7. Definition of done

- A user can produce a branded, multi-size poster from a template or a generated image without leaving Kition, with the Agent rewriting copy and colors on request and the user approving each change.
- Every operation the Agent can perform is documented in `contracts/runtime/agent-design.schema.json` and validated by a spec.
- The design feature has pure-logic specs for constraints, alignment, distribution, variants, templates, and patches, and at least ten e2e tests covering the main flows.
- `docs/design.md` rules hold across the editor in both themes, verified in the Electron client on macOS with screenshots.
