# Native Design Suite Plan

Status: local creation-to-export suite implemented and verified.
Server catalogs and Design-aware generation remain separate delivery phases.

Date: 2026-09-08

## Implementation progress

The client now includes a native React/SVG editor under `src/features/design/`.
No dependency or source from the reference editor has been added. Basic editing,
local image loading, saving, export, and native image copy work without starting
the private runtime.

| Area | Implemented behavior |
| --- | --- |
| Workspace integration | Design creation in the root or a selected folder, `.kidesign` files, tabs, tree icons, rename, move, duplicate with a new document ID, and reopening |
| Composition | One fixed artboard, presets/custom dimensions, editable text, local images, rectangle/ellipse/line tools, and four original editable layouts |
| Editing | Selection, marquee, move/resize/rotate, flip, center alignment, drag snapping to artboard/layer edges and centers, layers, grouping, visibility/locking, crop, and object clipboard |
| History | Bounded record changes, one committed pointer gesture per undo step, text/nudge coalescing, and cancelable drag previews |
| Durability | Serialized guarded writes, root/path capture, flush before navigation/file moves, recovery drafts, external-change detection, and save-a-copy/reload actions |
| Assets | Workspace-relative references, desktop-local image reads, browser asset storage, missing-image feedback, and consistent still-frame normalization for image rendering |
| Output | Artboard-sized PNG/JPEG, transparency checks, frozen export revisions, and desktop-native image clipboard |
| Agent handoff | Create a design from image preview or use a completed chat image in the captured open design; the current conversation stays available |
| Layout | One optional tool panel, bounded inspector overlays for narrow editor panes, both application themes, and reachable controls with chat open at 1024px |

Validation entry points are `pnpm test:design:unit` and
`pnpm test:design:e2e`. Browser tests check representative exported pixels,
transparent PNG, JPEG, composed text, reopening, undo, layers, clipboard
payloads, canceled gestures, and responsive layout. The Electron test uses the
real workspace bridge with runtime image HTTP disabled; it covers local images,
rename/move/reopen, export, native clipboard pixel equality, OS paste, and
image-to-design creation. A separate 520-layer browser scenario includes
20 image layers and records pointer-event-to-next-animation-frame timings.

Verification on 2026-09-08:

- Full unit run: 383 files, 4047 tests passed. After final UI refinements,
  127 focused Design/workspace/Agent/desktop tests passed.
- Design E2E: 7 browser and Electron scenarios passed.
- `pnpm run build:check`, ESLint, branding, product-language, and
  `python3 scripts/check-i18n.py` passed.
- Mandatory `pnpm test:table:e2e`: 13 tests passed, exit code 0.
- Local Chromium measurement on macOS ARM64: 40 pointer samples, 14.3 ms
  median and 39 ms P95 to the next animation frame for 520 objects including
  20 image layers sharing one decoded source. This is not a painted-frame or
  cross-platform performance guarantee.
- The build retains its existing warning about chunks exceeding 500 kB.

Remaining release scope is explicit:

- Fonts currently use three system families: Arial, Georgia, and Courier New.
  The proposed top-level font inventory, owned embedded fonts, and missing-font
  substitution review are not implemented. Cross-platform typography may vary.
- Export currently exposes 1x artboard output. The renderer supports scaling,
  but there is no output-scale control or editable asset-package export yet.
- The tests move files inside a workspace; moving a complete workspace between
  machines still needs a portability check with real assets and fonts.
- The performance scenario is a local regression measurement, not a guarantee
  for every computer or a stress test with 20 distinct maximum-size images.
- Phase 3's server-managed editable layout catalog and Phase 4's gated Design
  generation targets, image replacement, masks, and reviewed object patches
  remain unimplemented. The existing image prompt catalog is not relabeled as
  an editable Design layout catalog.

Phase 1's local end-to-end slice and most Phase 2 editing tools are implemented.
This status does not claim that every v1 acceptance criterion or later phase
has shipped.

## 1. Product decision

Add **Design** as a native Kition workspace suite, with posters as its first
complete use case. Users create a design from the existing workspace create
menu, compose images and editable text on a fixed-size artboard, save the
editable source, and export or copy the finished image.

The file extension is `.kidesign`, the workspace format is `design`,
and the editor domain is `src/features/design`. These names distinguish an
editable design from an exported PNG and from an infinite Board.

The implementation is owned by Kition and uses React and TypeScript. The
downloaded `vue-fabric-editor` is a behavioral reference only. Do not embed its
application, copy its editor core, install `@kuaitu/core`, add Vue, mount an
iframe, or create a build dependency on a sibling checkout. Its components,
styles, templates, fonts, hosted APIs, and material catalogs are not inputs to
the shipping application.

The initial rendering direction is native SVG with React, DOM text editing,
and Canvas 2D for raster export, building on the approaches already exercised
by Kition's Board. Fabric.js is not a planned dependency. Validate text,
transforms, clipping, and export fidelity in Phase 0 before expanding tools.

Basic design creation and editing run locally. They require no InvokeAI
deployment, Python service, GPU server, or online account.

## 2. Reference investigation

The inspected upstream checkout is
[`ikuaitu/vue-fabric-editor`](https://github.com/ikuaitu/vue-fabric-editor/tree/b3bdcfb0bd6d8f98e7483cf561ac03ba56c0d889),
revision `b3bdcfb0bd6d8f98e7483cf561ac03ba56c0d889`.

It separates an editor coordinator from tools for workspace sizing, selection,
transforms, layers, grouping, history, fonts, and materials. Its Vue panels
invoke those tools and react to selection changes. The relevant patterns are
the user behaviors and boundaries below, not its plugin implementations or
Fabric serialization format.

| Reference behavior | Kition implementation direction |
| --- | --- |
| Fixed workspace rectangle, fit-to-view, pan and zoom | Artboard record plus transient viewport state |
| Selection-specific controls and property panels | Typed selection model and React inspector |
| Move, resize, rotate, flip | One transform command path for gestures and numeric fields |
| Layer ordering, visibility, locking | Ordered document tree, exposed through an accessible layer list |
| Group and ungroup | Parent-local transforms that preserve world-space appearance |
| Undo and redo | Explicit command transactions with gesture coalescing |
| Import and export hooks | Typed, testable asset and export services |
| Font and material panels | Kition font inventory and workspace/Console resource adapters |

Reference entry points include `src/views/home/index.vue`,
`packages/core/Editor.ts`, and the `WorkspacePlugin`, `LayerPlugin`,
`GroupPlugin`, and `HistoryPlugin` modules. Do not reproduce their global
canvas selectors, global shortcut registration, dynamic API mutation, or
whole-editor reload behavior for undo.

## 3. Existing Kition integration points

| Concern | Existing owner | Required change |
| --- | --- | --- |
| Workspace create menu | `src/features/workspace/components/WorkspaceCreateMenu.tsx` | Add a Design entry to workspace creation, including folder-scoped menus |
| Creation coordination | `src/features/workspace/hooks/useWorkspaceBoardCreation.ts` | Follow its workspace write/open pattern in a separate Design creation hook |
| Tree format, titles and icons | `src/features/workspace/lib/workspace.ts` | Recognize `.kidesign` and provide a Design icon and translated label |
| Desktop format classification | `electron/workspace-document-formats.mjs` | Support Design listing, text read/write, organization, and reopening |
| Desktop/browser bridge types | `src/services/desktop.ts` | Add the format and keep browser preview behavior consistent |
| Tab lifecycle | `useWorkspaceTabs.ts` and `workspacePersistence.ts` | Add a Design tab with rename, move, restore, and workspace isolation |
| Editor composition | `WorkspaceEditorContent.tsx` | Lazy-load the native Design pane |
| Geometry and export precedents | `src/features/whiteboard/lib/whiteboardGeometry.ts` and `boardExport.ts` | Reuse suitable pure primitives after extracting genuinely shared responsibilities |
| Image artifacts and clipboard | `workspaceFiles.ts`, `copyImageToClipboard`, workspace import helpers | Resolve existing assets, import images, copy rendered output |
| Agent image results | `AgentImageResultCards.tsx` | Offer a downstream placement action for editable designs |

Review all exhaustive format switches, persisted tab validation, recent-file
restoration, file watchers, and branch rename handling. A menu entry alone is
not a completed integration. Keep `WorkspaceScreen.tsx` as composition glue;
place new orchestration in workspace hooks and the editor in Design.

## 4. User flows

### 4.1 New design

1. Select Design from the existing workspace or folder create menu.
2. Create `Untitled design.kidesign` in that folder, using the existing unique
   naming behavior for collisions, and open its workspace tab.
3. Show a ready-to-edit 1080 x 1440 portrait artboard. A compact size picker
   offers square, portrait, story, landscape, and custom dimensions.
4. Make starter layouts visible in the editor's initial library view; inserting
   text or an image is also immediately available.
5. Rename through the existing title/tab workflow and autosave document edits.

Creation does not require an account or an initial multi-step setup dialog.
The first canvas is usable while optional online catalogs load.

### 4.2 Compose a poster

- Add a heading, body text, image, rectangle, ellipse, or line.
- Select objects on the canvas or in the layer list; use the same selection
  and commands from both surfaces.
- Drag and resize with visible handles, rotate, align, group, reorder, lock,
  and hide objects. A locked object remains selectable from the layer list
  for unlocking.
- Edit text directly on the artboard. Font size, weight, color, alignment,
  line height, and letter spacing live in the contextual inspector.
- Crop an image inside its frame without changing the source asset. Background
  images can be locked so text remains easy to select above them.
- Undo one user action at a time, then export or copy the artboard.

### 4.3 Start from a generated or existing image

- The workspace image preview provides `Create design from image`.
- An Agent image result provides `Use in design`, targeting the active Design
  tab or explicitly creating a new design when no suitable target is active.
- A new design adopts the image's natural dimensions, places it as an image
  layer, and keeps it available as a background under new editable text.
- An existing design inserts it into the active artboard with a fit-to-artboard
  initial placement, as one undoable action.
- The originating Agent conversation and original image remain available.

Generated pixels are an image layer. Text already baked into a generated PNG
does not become editable text automatically. New Kition text objects and
native layout templates retain editable text; changing baked content remains
an image-editing task.

### 4.4 Save, reopen, and export

- Autosave preserves editable objects, groups, crop settings, and asset refs.
- Reopening restores the same composition and fonts or reports missing fonts.
- Export PNG at the artboard dimensions or an explicit output scale; JPEG
  requires a selected background when the artboard has transparency.
- Copy the rendered artboard as an image through the existing clipboard
  service. Copying selected objects within Design uses a separate structured
  clipboard payload and remaps object IDs on paste.
- Exported images are new assets; they do not overwrite the editable source or
  its input images. Save/export failure retains the current editing state.

## 5. Layout and visual rules

Keep the existing workspace sidebar, tabs, editor area, and Agent sidebar.
Design supplies the content inside its editor tab:

- a compact top toolbar for title/save status, undo/redo, size, and export;
- a narrow tool rail for text, images, shapes, layouts, and layers;
- an expandable library/layer panel and a central artboard on a neutral stage;
- a contextual property inspector; and
- quiet zoom and fit controls at the bottom of the stage.

Follow [design.md](design.md) and [product-ui-style.md](product-ui-style.md):
semantic theme tokens, purple primary actions, white/light neutral defaults,
8px controls, and 12px cards and floating panels. Canvas content colors are
user data and remain independent of the application theme.

Avoid accumulating an inspector, material browser, and chat as three permanent
wide sidebars. At widths of 1440px and above, panels may coexist when the
artboard retains useful space. Below that, collapse the library to its tool
rail and put Design properties in a bounded overlay when Agent chat is open.
Preserve the existing visible Agent session and composer. Do not silently close
chat or create a second session to make room for Design tools.

At 1024px, creation, canvas selection, text editing, properties, and export must
remain reachable without horizontal application overflow. Below 1024px, use
the repository's overlay behavior. Hide inactive inspector groups instead of
placing every tool permanently above the canvas.

## 6. Document and asset model

### 6.1 Durable source

`.kidesign` is a versioned JSON document with a Kition schema. It is not a
serialized DOM tree, an SVG export, or an upstream/Fabric JSON document.

The proposed top-level fields are:

| Field | Meaning |
| --- | --- |
| `format` | Constant `kition-design` |
| `version` | Document schema version, initially 1 |
| `id` | Stable design ID, independent of file path |
| `title` | User-visible design title |
| `revision` | Monotonic content revision within this document |
| `pages` | Artboards with IDs, dimensions, backgrounds, and ordered root node IDs |
| `nodes` | Normalized node records keyed by stable IDs |
| `assets` | Workspace-relative asset references and image metadata |
| `fonts` | Font family/weight/style requirements and optional owned font asset refs |
| `provenance` | Optional source image and immutable layout-template origin |

Version 1 exposes one artboard per file. The schema represents pages explicitly
so later multi-artboard support can migrate without conflating canvas size
with object geometry. Do not display nonfunctional page management in v1.

### 6.2 Nodes and transforms

Support text, image, rectangle, ellipse, line, and group nodes. Each node has
an ID, name, visibility, lock state, opacity, local bounds, an affine transform,
and type-specific properties. An ordered child-ID list on an artboard or group
is authoritative for membership and paint order; parent lookup is derived.

- Persist transforms in parent-local coordinates with one documented matrix
  convention. Do not store competing authoritative x/y/rotation/scale values.
- Groups cannot contain themselves or introduce cycles. Reparenting, grouping,
  and ungrouping preserve world transforms and stacking order.
- Numeric inspector values and pointer handles use the same geometry helpers.
- Crop rectangles use source-image coordinates; frames and transforms use
  document coordinates. Viewport zoom never changes document geometry.
- Nodes outside the artboard remain editable, but export clips to the artboard.
- Text width, wrapping, and line metrics are determined by one layout service
  used for editing, display, hit regions, and export.

Validate unique IDs, finite geometry, supported types, parent/child integrity,
crop bounds, and explicit object/page limits. Invalid or newer-version files
must not be silently rewritten as empty documents. Preserve original bytes
and present a recoverable error or a supported read-only view.

### 6.3 Portable assets

Use the workspace-owned asset model described in
[workspace-portable-storage.md](workspace-portable-storage.md). Reuse the
content-addressed store when its public capability is available; otherwise
import through the existing desktop workspace file bridge with a durable
workspace-relative path.

An asset reference contains its ID, relative path, MIME type, natural dimensions,
and content hash when available. Keep temporary display URLs out of the file:
no localhost origins, blob URLs, host paths, or access tokens.

Import assets before committing nodes that reference them. Preserve source
assets across undo, failed imports, replacement, and export; asset cleanup is
separate from object deletion. Resolve relative paths from the workspace root
so moving the design between folders does not break its images.

The complete workspace is portable. Copying a single JSON `.kidesign` outside
that workspace does not include its image/font assets; a later editable-package
export must collect those assets and rewrite references explicitly. PNG/JPEG
exports are self-contained from the first release.

### 6.4 Saving and recovery

- Autosave committed edits after a short debounce; pointer previews, selection,
  zoom, and pan do not produce content revisions or extra undo entries.
- Bind each save to workspace identity, document ID, file path, and revision.
  Serialize writes and ignore obsolete async completions after a switch.
- A rename remaps the active save target; a duplicate receives a new document
  ID. Closing a tab or workspace flushes pending edits or exposes a recoverable
  failure instead of dropping work.
- Keep last-saved revision and recovery draft separate from undo history.
- Detect external file changes before overwriting them. Preserve both versions
  and offer reload or save-a-copy when an external change conflicts with edits.
- Add atomic/revision-aware write behavior through the desktop bridge if the
  existing implementation cannot provide the necessary guarantees. Changes to
  remote runtime behavior follow the public-contract boundary.

## 7. Native editor architecture

Proposed feature structure:

```text
src/features/design/
  components/
    DesignEditorPane.tsx
    DesignCanvas.tsx
    DesignElementRenderer.tsx
    DesignSelectionOverlay.tsx
    DesignTextEditor.tsx
    DesignToolbar.tsx
    DesignToolRail.tsx
    DesignLayerPanel.tsx
    DesignInspector.tsx
    DesignLibrary.tsx
  hooks/
    useDesignEditor.ts
    useDesignPointer.ts
    useDesignTextEditing.ts
    useDesignClipboard.ts
    useDesignAutosave.ts
  lib/
    designTypes.ts
    designStore.ts
    designCommands.ts
    designHistory.ts
    designGeometry.ts
    designTextLayout.ts
    designSerialization.ts
    designAssets.ts
    designExport.ts
    designFile.ts
```

File names are proposed responsibilities, not a requirement to add empty
wrappers. Split by behavior as implementation grows and keep composition
components small.

`DesignStore` owns document state. Components subscribe to selected records;
the inspector, canvas, and layers do not maintain separate mutable copies of
the document. Selection, viewport, active tool, and drag previews are transient
per-editor state.

Every mutation passes through typed commands: insert, patch, remove, transform,
reorder, group, ungroup, crop, replace asset, and change artboard properties.
A pointer gesture begins a transaction, previews changes, and commits once.
Escape cancels it. Text composition remains a single coherent editing session;
canvas shortcuts must not intercept IME input or native text selection/paste.

Undo stores bounded command changes and before/after records. Coalesce typing
and repeated nudges with explicit boundaries. Switching tabs preserves each
editor's own history while mounted. Reopening restores saved content; durable
undo across application restarts is not a v1 requirement.

Reuse existing workspace I/O, image clipboard, notifications, shared controls,
and suitable geometry/export helpers. Extract cross-domain pure utilities with
regression tests rather than depending on Board-specific records, bindings,
mind maps, or mounted editor internals.

No runtime plugin framework, arbitrary executable template code, or dynamic
method registry is needed for the initial tools. Typed commands and narrowly
owned services provide the extension boundary.

## 8. Rendering, fonts, and export

- Render document objects as SVG. Keep handles, guides, selection, and crop
  controls in a separate overlay excluded from export.
- Use an aligned DOM editor for text entry and real IME composition. Render
  saved text through the shared text layout service; do not rely on exporting
  a `foreignObject` or capturing the whole application with a screenshot.
- Start with fonts already available to Kition and explicitly licensed font
  assets. Do not copy font binaries from the reference repository.
- Await font and image decoding before export. Report missing resources and
  offer an explicit fallback; do not silently substitute during export.
- Export from a frozen document revision using the same geometry and clipping
  rules as preview. Resolve images to embedded bytes, rasterize the artboard,
  and verify output dimensions and alpha handling.
- Never persist browser taint-prone remote URLs as the only source for an
  editable image. Imported assets should be available through the workspace
  asset resolver before export.
- Bound canvas dimensions and total export pixels, with an actionable message
  when a requested export exceeds supported memory limits. Do not silently
  lower the requested resolution.

SVG export, PDF printing, CMYK workflows, and text-to-outline are later work.
PNG/JPEG export and image clipboard support are v1 release requirements.

## 9. Layout templates and AI images

### 9.1 Editable templates

A Design layout template is a versioned `.kidesign`-compatible object graph
with assets, font requirements, dimensions, and named editable fields. Applying
one creates new object IDs and records its immutable template version.

The existing image catalog contains prompt recipes that produce raster images.
Its templates can generate a background or illustration for a design; the
catalog does not imply editable text or layered layout data. Do not relabel the
existing image templates as native Design templates.

Provide original, programmatically defined starter layouts for the first local
release. Keep basic starters and custom dimensions usable offline. Later, reuse
Console's search, pagination, versioning, thumbnail, localization, and access
infrastructure for a distinct `design` catalog with validated declarative
payloads. Do not compile the production design catalog into the client or reuse
the reference project's material/font servers.

Use a field mapping such as heading, subtitle, image, and accent color to make
template changes predictable. Reapplying a layout to a populated design needs
an explicit preview; it must not silently discard user-created objects.

### 9.2 Existing Agent integration

Image generation remains in the current Agent chat, governed by
[unified-agent-image-generation-plan.md](unified-agent-image-generation-plan.md).
Design owns the placement of reviewed artifacts and the editing of independent
text/shapes around them. It does not gain a separate generation wizard or hidden
Agent session.

The first image handoff uses existing completed artifacts and local placement,
so the native editor and `Create design from image` flow do not depend on a new
runtime release.

Starting generation from a Design context requires a public contract extension:

- a `design` surface and a typed `image.target.design` containing design path,
  document/page ID, expected revision, and optional selected image-node ID;
- a separately advertised capability, proposed as
  `agent_image_generation_design_v1`, before sending the extended target;
- a Design target adapter in workspace context capture and client stream mocks;
- reviewed placement into the originally captured target, with a stale-target
  message if the file, page, node, or revision has changed.

Do not send Design as a fake document or Board target to older runtimes.
Image-node replacement retains the node's layout frame and offers a fit choice
when the replacement aspect ratio changes. Confirmed placement is one undoable
command and keeps the original image available.

### 9.3 Later AI editing

Selection masks, region replacement, and structured layout changes are later
extensions. Masks must map precisely between document geometry and source image
pixels. Both the chosen provider and runtime must advertise the required
behavior; the current reference-image edit request does not establish mask
support.

For future object-level Agent edits, publish Design context and patch schemas
first. Validate allowed commands, stable IDs, document revision, and request
deduplication before applying one reviewed transaction. Implement private model
or runtime behavior only in the private runtime repository.

## 10. Delivery phases

### Phase 0: model and rendering validation

- Define the versioned Design schema, transform convention, and command types.
- Build a representative artboard with editable text, overlapping shapes, a
  cropped image, and a transformed group.
- Verify round-trip serialization, IME entry, group/ungroup geometry, and raster
  export fidelity with available fonts.
- Measure interaction on a declared reference machine with approximately 500
  objects and 20 image layers. This is a validation target, not an existing
  performance claim; record results before committing to the full tool set.

Exit gate: no unresolved text/export or transform correctness issue. This phase
alone is not a delivered Design suite.

### Phase 1: complete creation-to-export slice

- Register the format, tree entry, create action, tab, rename/move handling,
  desktop/browser I/O, and session restoration.
- Deliver a default artboard, text/image/basic shape insertion, selection,
  moving/resizing, deletion, undo/redo, autosave, PNG export, and image copy.
- Import from workspace files and clipboard and create a design from an image
  opened in the existing preview pane.

Exit gate: create a poster, edit it, close/reopen or restart, and export the same
composition. The source file and its assets remain within the workspace.

### Phase 2: usable poster suite, v1 release

- Add layer management, grouping, rotation/flip, alignment, guides, crop,
  contextual typography controls, presets, and original starter layouts.
- Complete JPEG output, copied-object paste, missing-resource feedback, save
  recovery, external-change detection, and responsive inspector behavior.
- Add `Use in design` to existing Agent image artifacts, preserving the current
  conversation and captured destination.
- Verify the editor in both themes, with chat open, and across workspace moves.

Exit gate: all v1 acceptance criteria below pass. Do not label an empty canvas
or a toolbar-only implementation as complete.

### Phase 3: server-managed editable layouts

- Publish the Design catalog schema and mock responses in the client repo.
- Implement catalog management and publication in `kition-console` with the
  established deployment process and active environment.
- Add native layout search, pagination, previews, immutable versions, and
  offline behavior without bundling a production catalog.

Exit gate: an authorized published template produces editable nodes and opens
correctly after its assets are cached. Catalog availability does not affect
ordinary local design editing.

### Phase 4: Design-aware generation and AI editing

- Add the gated Design generation target through public contracts, client
  mocks, and private runtime black-box validation.
- Reuse the current chat for generation and replacement review.
- Add masks and reviewed object patches only after their separate public
  capabilities and provider behavior are verified.

Exit gate: generated results cannot be inserted into the wrong file or overwrite
intervening edits, and every accepted placement is undoable.

Multi-artboard editing, PSD import, arbitrary SVG editing, curved/path text,
barcode tooling, plugin marketplaces, and print-production features are beyond
v1. They do not block a useful native poster editor.

## 11. Acceptance and verification

The v1 end-to-end scenario is: create Design in a selected folder, change its
size, add an image and editable heading, crop the image, align and group objects,
reorder and lock layers, undo/redo, rename and move the file, close/reopen it,
and export/copy the resulting poster.

Required evidence:

- creation and reopening work through the real Electron workspace bridge;
- file and asset references survive moving the complete workspace;
- text, clipping, z-order, alpha, dimensions, and representative pixels agree
  between preview and exported PNG/JPEG;
- text remains editable after save/reopen, including IME-composed content;
- the native clipboard contains an image that can be pasted into another input;
- dragging/nudging, grouping, crop, and template insertion have coherent undo
  boundaries, without intercepting text or chat shortcuts;
- save failure, corrupted/newer files, missing assets/fonts, canceled image
  loading, and stale async completions preserve existing work;
- inactive tabs release pointer/keyboard listeners and cannot mutate the
  active workspace;
- artboard and controls are usable at 1024px and at wider sizes with Agent chat;
- the build contains no Vue app, `@kuaitu/core`, reference-repository source,
  copied upstream assets, sibling-path dependency, or material-service URL.

Keep semantic model/history tests focused on invariants and use real browser
rendering for geometry, text entry, export, and responsive layout. Read localized
test content from approved locale resources instead of embedding non-English
fixtures in general source files.

Implementation checks include the focused Design/workspace/Electron suites,
`pnpm run build:check`, ESLint, branding, product-language, and
`python3 scripts/check-i18n.py`. Run the mandatory `pnpm test:table:e2e` gate
before declaring a delivery complete; all required checks must exit 0.

Keep the implementation progress section aligned with the verified delivery.
Passing repository checks alone does not establish editor behavior; retain the
browser and desktop evidence for creation, editing, persistence, and export.
