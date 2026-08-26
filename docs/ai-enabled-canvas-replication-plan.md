# Kition AI-Enabled Canvas Clean-Room Replication Plan

Status: implementation in progress

Research baseline: 2026-08-24

Research inputs:

Current native implementation progress:

- completed the element definition registry and expanded shape vocabulary;
- added the highlighter tool and style-aware SVG drafts;
- extracted explicit idle, pan, brush, translate, resize, rotate, shape,
  connector, stroke, and text-editing interaction states;
- added undoable z-order commands and selection layout controls;
- added durable connector endpoint bindings with transform synchronization;
- added portable copy, cut, and paste with hierarchy and binding ID remapping;
- added edge, center, equal-gap, and resize snapping with SVG guides;
- added native groups, frames, descendant transforms, reparenting, and load
  repair for invalid hierarchy or connector bindings;
- added alignment, distribution, z-order, minimap, fit, selection zoom,
  actual-size, and camera-history navigation controls;
- added an incremental spatial index for viewport queries, selection, snapping,
  Agent context, and committed-element culling;
- added deterministic radial and Douglas-Peucker freehand simplification plus a
  10,000-element spatial-index regression fixture;
- added the first deterministic Board lint engine for disconnected semantic
  nodes, missing labels, overlapping text, and frame containment;
- added deterministic standalone SVG export with embedded workspace images and
  portable relative-path fallback;
- added bounded PNG export through transient Canvas 2D rasterization without
  introducing a second durable scene engine;
- kept `kition-board` version 1 and the native SVG renderer unchanged.

The remaining work is richer connector routing and labels, group entry and
frame clipping, deterministic graph layouts, expanded Agent context and actions,
scenario-specific image and Workflow flows, interactive large-Board performance
evidence, and launch hardening.

This is a focused continuation of
[Kition AI Board Native Development Plan](ai-whiteboard-product-plan.md). It
does not replace the existing Board, file format, store, renderer, or Agent
preview loop.

## 1. Non-negotiable direction

Kition will reproduce the useful product behavior and architectural separation
of a mature AI-enabled canvas through a clean-room native implementation.

- Do not introduce another third-party whiteboard, diagram, or canvas engine.
- Do not migrate `.kiboard` files to another schema or storage model.
- Keep `kition-board` version 1 and the normalized Kition `BoardRecord` model as
  the durable source of truth.
- Keep the native SVG scene renderer. Canvas 2D or WebGL may be used only for
  bounded transient processing such as image export, never as a second scene
  engine.
- Keep all runtime behavior behind public Kition contracts and capability
  flags. Do not recreate private runtime source in this repository.

The reference checkout is read-only research material. Implementation follows
this sequence:

1. Describe an observed user outcome in Kition terminology.
2. Add a Kition-owned requirement and failing test.
3. Design the behavior against the current Board records and design system.
4. Implement it independently inside the owning Kition feature.
5. Compare user-visible behavior, not internal code structure or naming.

## 2. Outcome

Evolve the current native Kition Board into an AI-enabled infinite canvas that
supports:

- image annotation with spatial and visual Agent context;
- AI agents that can inspect, create, edit, arrange, and review Board content;
- mixed text, drawing, images, diagrams, frames, and source-linked content;
- product prototyping that produces explicit external artifacts;
- visual workflow ideation that converts to a validated Kition Workflow draft;
- chat-driven canvas work through the existing Kition Agent drawer.

The result must remain recognizably Kition: white or light-neutral product
surfaces, project purple `#5645d4` for the primary action or selected AI state,
8px buttons, 12px cards, restrained borders, and no unrelated dark-console or
neon theme.

## 3. Current implementation baseline

The implementation starts from the Board that already exists. Do not rebuild
these completed foundations:

- `.kiboard` create, open, rename, tab restore, save, and reopen behavior;
- version 1 normalized metadata, page, element, binding, and asset records;
- `BoardStore` external-store subscriptions and record queries;
- `BoardRecordDiff`, atomic transactions, undo, redo, marks, bail, and squash;
- `BoardCommandRegistry` create, update, delete, and live-update behavior;
- native SVG pan, zoom, drawing, shapes, text, connectors, and images;
- multi-selection, brush selection, move, resize, rotate, lock, nudge, and
  duplicate-drag;
- portable workspace image paths;
- selection, viewport, and whole-Board Agent scopes;
- bounded semantic context and peripheral clusters;
- `agent_whiteboard_v1` capability and public contract;
- streamed purple preview, accept, reject, cancel, stale protection, and
  one-step undo.

The next work should close the gap between this foundation and a mature
AI-enabled canvas rather than replace the foundation.

## 4. Use-case mapping

| AI-enabled canvas scenario | Kition-native delivery |
| --- | --- |
| Image annotation | Place a workspace image, annotate it with shapes, text, arrows, and freehand marks, attach a point or region to the Agent, and optionally send a bounded rendered preview |
| Product prototyping | Use frames, reusable visual components, text, images, and links for wireframes; generate a separate prototype or code artifact only after an explicit user request |
| AI workflows | Use Board for ideation and graph editing, validate the selected graph, then create a Kition Workflow draft; never execute a Workflow from a drawing |
| AI agents | Let the existing Agent read semantic records and spatial context, propose typed operations, preview changes, receive review context, and continue over multiple turns |
| Content creation | Mix notes, text, freehand, diagrams, imported media, generated images, and Kition source cards on one Board |
| Agent starter pattern | Reproduce prompt-part and action-registry separation using Kition-owned registries and the existing Agent lifecycle |
| Workflow starter pattern | Reproduce stable ports, bindings, routing, insertion, and graph validation inside Kition's existing Board and Workflow domains |
| Chat starter pattern | Use the existing Agent drawer and context tray; do not create a second Board-specific chat application |

Initial delivery priority:

1. editor interaction and shape parity;
2. stable relationships, snapping, layout, and navigation;
3. richer Agent context and action vocabulary;
4. image annotation and content creation;
5. prototyping and Workflow conversion.

## 5. Architecture to reproduce conceptually

| Reference responsibility | Kition-native subsystem |
| --- | --- |
| Reactive normalized store | Existing `BoardStore` and `BoardRecord` model |
| Per-shape geometry and behavior | `BoardElementDefinition` registry |
| Explicit tool and pointer states | `BoardInteractionMachine` |
| Connector and relationship maintenance | `BoardBindingEngine` |
| Atomic history and cancellation | Existing record diffs, marks, bail, and squash |
| Alignment and spacing feedback | `BoardSnapManager` |
| Fast viewport and hit queries | `BoardSpatialIndex` |
| Layered scene and overlays | Native SVG scene plus bounded DOM product overlays |
| Shared command vocabulary | Existing `BoardCommandRegistry`, extended rather than bypassed |
| Agent-visible context parts | `BoardAgentContextProvider` registry |
| Agent-editable operations | `BoardAgentAction` registry |
| Canvas quality checks | `BoardLintEngine` |

These subsystem names are Kition implementation concepts. They must be designed
against current code and tests rather than copied from reference types.

## 6. Target feature ownership

```text
src/features/whiteboard/
  components/
    WhiteboardEditorPane.tsx
    WhiteboardCanvas.tsx
    WhiteboardScene.tsx
    WhiteboardSceneOverlays.tsx
    WhiteboardToolbar.tsx
    WhiteboardSelectionToolbar.tsx
    WhiteboardStylePanel.tsx
    WhiteboardContextMenu.tsx
    WhiteboardMinimap.tsx
    WhiteboardAgentPreview.tsx
  hooks/
    useBoardDocument.ts
    useBoardEditorStore.ts
    useWhiteboardEditor.ts
    useWhiteboardInteractionMachine.ts
    useWhiteboardClipboard.ts
    useWhiteboardAgentPatch.ts
  lib/
    boardCommands.ts
    boardRecords.ts
    boardSerialization.ts
    boardStore.ts
    boardElementDefinitions.ts
    boardInteractionMachine.ts
    boardBindingEngine.ts
    boardSnapManager.ts
    boardSpatialIndex.ts
    boardLayout.ts
    boardExport.ts
    whiteboardAgentContext.ts
    whiteboardAgentContextProviders.ts
    whiteboardAgentActions.ts
    whiteboardAgentPatch.ts
    whiteboardLint.ts
```

Ownership boundaries:

- Board model, geometry, rendering, tools, bindings, layout, context extraction,
  patch translation, and overlays stay in `src/features/whiteboard`.
- Agent session state, streaming, model selection, timeline, and chat stay in
  `src/features/agent`.
- workspace tabs, tree, editor chrome, and pane composition stay in
  `src/features/workspace`.
- `src/app/Shell.tsx` must not gain Board presentation or Agent logic.
- `WhiteboardEditorPane` and `useWhiteboardEditor` remain composition roots and
  should shrink as the new subsystems become responsible for behavior.

## 7. File format stability: no migration

`BOARD_DOCUMENT_VERSION` remains `1`. The implementation continues to read and
write the current Kition format:

```ts
type BoardDocument = {
  format: 'kition-board'
  version: 1
  title: string
  viewport: WhiteboardViewport
  records: BoardRecord[]
  updated_at: string
}
```

Rules:

- Do not introduce a new Board document version for this project.
- Do not convert existing files on open, save, or first edit.
- Do not add an alternate snapshot, binary payload, or embedded third-party
  store.
- Continue pretty-printed JSON with a trailing newline.
- Continue portable workspace-relative asset paths and reject host or traversal
  paths.
- Extend existing Kition records only with optional backward-compatible fields
  when a feature cannot be represented by current fields.
- Missing optional fields always receive deterministic defaults at runtime.
- Opening and saving an unchanged Board must not rewrite unrelated records.
- Tests must prove that existing version 1 fixtures remain byte-stable when no
  user-visible edit occurs.

The current record model already covers pages, elements, bindings, assets,
styles, rotation, locking, hierarchy, source references, shapes, frames,
groups, images, and connectors. Prefer making those records more capable over
adding parallel models.

## 8. Native editor workstreams

### 8.1 Element definition registry

Create a Kition-owned registry that centralizes behavior currently spread
across the renderer, geometry helpers, editor hook, and shape body.

Each definition owns:

- supported element kind and semantic subtype;
- SVG body rendering;
- page bounds and rotated bounds;
- hit testing;
- resize and rotation behavior;
- text extraction and editing rules;
- selection handles;
- style defaults and normalization;
- SVG export;
- Agent semantic conversion.

First complete set:

- rectangle, ellipse, diamond, triangle, pill, hexagon, parallelogram, cloud,
  star, heart, check, and directional arrows;
- text, sticky note, mind-map node, and flow node;
- line, straight connector, freehand, and highlight;
- image, frame, and group.

Exit gate: adding a shape type no longer requires edits across unrelated
renderer, hit-test, transform, export, and Agent files.

### 8.2 Interaction machine

Replace implicit combinations of hook state with explicit interaction states:

- idle;
- pointing canvas or element;
- brushing selection;
- translating;
- resizing;
- rotating;
- drawing shape;
- drawing freehand or highlight;
- connecting;
- panning;
- editing text;
- cropping image.

Each active state owns pointer capture, keyboard modifiers, cancellation,
commit, and cleanup. Escape must always leave a valid idle state. Live pointer
updates use one active store transaction and one final undo step.

### 8.3 Binding and hierarchy engine

Make connectors and nested structures durable:

- bind connector endpoints to element IDs and normalized anchors;
- update endpoints after move, resize, rotate, layout, group, reparent, delete,
  undo, redo, and reload;
- support straight, curved, and elbow routes;
- support connector labels;
- add group, ungroup, select child, enter group, and nested transform behavior;
- add frame adoption, drag-in, drag-out, title, and clipping behavior;
- validate or repair invalid relationships deterministically during load.

All relationship changes go through `BoardCommandRegistry` and produce normal
record diffs.

### 8.4 Snapping, organization, and layout

Add:

- center, edge, vertex, connector-anchor, equal-gap, and resize snapping;
- restrained purple SVG snap guides;
- align, distribute, stack, pack, flip, and z-order commands;
- deterministic mind-map tree layout;
- deterministic layered flowchart layout;
- pinned elements that layout commands do not move;
- insert-a-node-into-connector behavior;
- one-command undo for every layout operation.

Layout algorithms operate on current Kition semantic records, never on an
external graph file format.

### 8.5 Clipboard and navigation

Add:

- native cut, copy, paste, duplicate, and paste-at-pointer;
- ID remapping with internal bindings and hierarchy preserved;
- copy and paste between Boards without host paths;
- minimap, zoom to selection, fit Board, actual size, and camera history;
- drag and drop for workspace images and supported Kition source cards;
- keyboard shortcuts help generated from the shared command registry.

### 8.6 Rendering, indexing, and export

- Keep committed content in SVG.
- Add an incremental spatial index for hit testing, viewport queries, snapping,
  lasso selection, and off-screen Agent clusters.
- Cull off-screen elements and apply level-of-detail rules without changing
  the durable record.
- Batch pointer writes to animation frames and isolate element rerenders.
- Smooth and simplify freehand paths while preserving editable points.
- Export deterministic SVG and bounded SVG-to-PNG output.
- Resolve local images through the current workspace URL helper for scene,
  preview, screenshot, and export parity.

Performance targets remain 1,000 visible mixed elements and 10,000 total
elements on supported desktop hardware.

## 9. Agent architecture

### 9.1 Preserve the current trust loop

Keep these existing guarantees unchanged:

- `agent_whiteboard_v1` fails closed when unsupported;
- the runtime receives only bounded Kition semantic context;
- streamed patches do not mutate committed Board records;
- proposed changes render as a purple preview;
- accept is one Agent-sourced undo step;
- reject and cancel write nothing;
- stale, invalid, oversized, or unsafe patches fail before commit;
- recent user history excludes Agent-origin operations.

### 9.2 Context provider registry

Split context creation into independently testable providers:

- Board metadata and portable path;
- current request and scope;
- selected elements with complete semantic details;
- viewport bounds and visible simplified elements;
- attached shapes, points, and regions;
- peripheral spatial clusters;
- recent user commands;
- source references;
- optional bounded rendered screenshot;
- lint results;
- current review round and previous accepted action summaries.

Each provider declares its byte budget, count budget, privacy filter, and
priority. The final builder composes providers until the request budget is
reached.

### 9.3 Action registry

Extend the existing typed patch translation through Kition-owned actions:

- create, update, label, move, resize, rotate, delete, and reorder;
- connect, disconnect, and change connector routing;
- align, distribute, stack, place, group, and ungroup;
- draw freehand or highlight strokes;
- apply mind-map or flowchart layout;
- set the Agent inspection viewport;
- count or query matching elements;
- request review and send a user-facing message.

Actions validate IDs, locks, bounds, relationships, text lengths, source
references, operation count, total created area, and maximum scene growth.
Actions translate into the same `BoardCommandRegistry` used by user controls.

Keep version 1 public behavior stable. If the richer action vocabulary cannot
fit without breaking the existing public contract, add a separate
`agent_whiteboard_v2` capability and contract. This is a runtime contract
addition, not a Board file migration. Update the public contract and client
mock before changing the private runtime.

### 9.4 Review loop and canvas lints

After a material accepted patch, the Agent may receive fresh semantic context,
an optional rendered preview, and lint findings. Initial lints:

- disconnected flow nodes;
- connector crossings or missing endpoints;
- overlapping labels;
- elements outside their frame;
- missing labels on semantic nodes;
- unreadable text contrast;
- excessive spacing or inconsistent alignment;
- broken source references.

The Agent may propose a correction, but the correction uses the same preview,
accept, reject, and undo contract as every other change.

## 10. Scenario implementation

### 10.1 Image annotation

- Import, paste, or drag a workspace image onto the Board.
- Add crop, opacity, lock, replace, and fit controls.
- Allow point, rectangular region, selected annotation, or whole-image Agent
  context.
- Build a bounded rendered preview only when the selected model supports image
  input and the user explicitly sends the request.
- Keep annotations as editable vector Board elements over the image.
- Export the image and annotation region without changing the Board.

### 10.2 Content creation

- Reuse the current image-generation Agent tool and workspace artifact storage.
- Insert generation placeholders through Board commands.
- Replace placeholders with durable image elements after artifact creation.
- Support one to five variants, keep one, keep all, regenerate, remove, and
  one-step undo.
- Add Kition document, table, research, and generated-artifact source cards.
- Do not flatten source-linked content into screenshots.

### 10.3 Product prototyping

- Provide frame templates for desktop, tablet, mobile, dialog, and panel
  layouts using Kition-native records.
- Add reusable visual component groups and alignment or spacing commands.
- Let the Agent create and refine wireframes through typed Board actions.
- Generate code or a clickable prototype as a separate workspace artifact.
- Never execute generated code or an arbitrary embed inside the Board editor.

### 10.4 Visual workflows

- Treat flow nodes and connectors as semantic Board content.
- Validate trigger, action, condition, loop, and output roles before
  conversion.
- Show unresolved nodes and invalid edges in a review panel.
- Create a Kition Workflow draft only after explicit confirmation.
- Preserve links back to source Board element IDs.
- Never enable or execute the created Workflow automatically.

## 11. Implementation sequence

### PR 1: Element registry without behavior change

- Introduce `BoardElementDefinition` and register existing element types.
- Move rendering, bounds, hit testing, transforms, export, and Agent semantics
  behind definitions incrementally.
- Keep visible behavior and `.kiboard` output unchanged.

Exit gate: current component, store, serialization, Agent, and interaction tests
remain green, and a new element can be added through one registry boundary.

### PR 2: Commercial shapes, styles, and toolbar

- Complete the shape vocabulary and style properties.
- Add eraser, highlight, frame, hand, zoom, and image tools.
- Add selection toolbar, context menu, actions menu, and shortcuts help.
- Align all chrome with `docs/design.md`.

Exit gate: the native Board covers the standard drawing and editing vocabulary
needed for the priority scenarios.

### PR 3: Interaction machine

- Introduce explicit interaction states.
- Move pointer capture, modifiers, cancellation, text editing, and live
  transactions into the machine.
- Add image crop and connector creation states.

Exit gate: pointer and keyboard interactions cancel cleanly, never leave a live
transaction behind, and remain one undo step per gesture.

### PR 4: Bindings, groups, and frames

- Add durable connector anchors and routing.
- Add connector labels, groups, nested transforms, frame adoption, and repair.
- Add z-order commands.

Exit gate: relationships survive transform, save, reopen, undo, redo, and
Agent edits.

### PR 5: Snapping, layout, clipboard, and navigation

- Add snap manager and guides.
- Add organization and deterministic layout commands.
- Add clipboard relationship preservation, minimap, fit, and camera history.

Exit gate: complex Boards can be organized quickly without manual pixel
placement or broken relationships.

### PR 6: Spatial index, performance, and export

- Add incremental spatial queries and viewport culling.
- Add rendering isolation, freehand simplification, SVG export, and PNG export.
- Add 1,000-visible and 10,000-total performance fixtures.

Exit gate: large Boards remain responsive and exported output matches the SVG
scene.

### PR 7: Agent context and action registries

- Split current context into providers.
- Add point and area context, screenshot context, lints, and review rounds.
- Expand typed actions while preserving the current preview trust loop.
- Add a new public capability only if required for contract compatibility.

Exit gate: the Agent can inspect and propose the supported editor vocabulary
without directly mutating Board records.

### PR 8: Image annotation and generated content

- Add image crop, annotation context, selection rendering, and export.
- Add durable generated-image placeholders, variants, and source metadata.

Exit gate: image annotation and generation are portable, editable, previewed,
and undoable.

### PR 9: Prototyping and Workflow drafting

- Add frame templates and reusable visual component groups.
- Add explicit artifact generation from selected prototype frames.
- Add validated Board-to-Workflow draft conversion.

Exit gate: visual work can become a prototype artifact or Workflow draft
without hidden execution or data loss.

### PR 10: Accessibility, recovery, and launch hardening

- Add keyboard-only flows, focus behavior, screen-reader descriptions, small
  window handling, and high-DPI verification.
- Add corrupt-file recovery, missing-asset behavior, autosave race tests, and
  real-product screenshots.

Exit gate: the Board meets Kition accessibility, portability, recovery, and
release-evidence standards.

## 12. File-level transition map

| Current area | Planned action |
| --- | --- |
| `WhiteboardEditorPane.tsx` | Keep as a thin composition root |
| `WhiteboardCanvas.tsx` | Keep the native SVG canvas and split scene versus overlays |
| `WhiteboardElementRenderer.tsx` | Convert to definition-registry dispatch |
| `WhiteboardShapeBody.tsx` | Move subtype rendering into element definitions |
| `WhiteboardToolbar.tsx` | Keep and expand through shared command descriptors |
| `WhiteboardStylePanel.tsx` | Keep and bind controls to definition-supported styles |
| `useWhiteboardEditor.ts` | Keep as orchestration and extract interaction, binding, snapping, clipboard, and navigation logic |
| `BoardStore` and `BoardCommandRegistry` | Keep as the only mutation and history foundation |
| `boardSerialization.ts` | Keep version 1; add only backward-compatible optional fields when required |
| `whiteboardAgentContext.ts` | Compose bounded context providers |
| `whiteboardAgentPatch.ts` | Route typed Agent actions through registry validation and Board commands |
| `contracts/runtime/agent-whiteboard.schema.json` | Keep v1 stable; add a separate v2 contract only when required |
| workspace Board tabs and routing | Keep unchanged |

## 13. Test plan

### Unit tests

- definition registration, defaults, bounds, hit tests, transforms, and export;
- interaction-machine transitions, pointer capture, cancel, and cleanup;
- binding anchors, rerouting, repair, grouping, frame adoption, and deletion;
- snapping candidates, guides, layout determinism, and pinned elements;
- clipboard ID remapping with bindings and hierarchy;
- spatial-index incremental updates and viewport queries;
- freehand smoothing and simplification;
- version 1 serialization stability and portable asset paths;
- context provider budgets, privacy, priorities, screenshots, and clusters;
- Agent action validation, translation, stale checks, preview, accept, reject,
  cancel, and single-step undo;
- lint generation and review-round context.

### Component tests

- every tool and style control;
- selection toolbar, context menu, snap guides, minimap, and shortcuts dialog;
- text editing, image crop, connector creation, group entry, and frame behavior;
- Agent scope, point or region context, preview controls, and lint summaries;
- workspace tab mount, restore, rename, close, and autosave behavior;
- 1024px desktop layout and narrower overlay behavior.

### End-to-end tests

1. Create a Board, draw, save, close, and reopen without changing its format.
2. Multi-select, move, resize, rotate, copy, paste, group, frame, and undo.
3. Connect elements, transform them, save, and verify attachment after reopen.
4. Align, distribute, stack, reorder, snap, and apply layout.
5. Import an image, crop and annotate it, then export SVG and PNG.
6. Generate a streamed Agent patch, accept it, and undo it once.
7. Reject and cancel patches and verify no file change.
8. Attach a point or region and verify only bounded context is sent.
9. Generate image variants and keep one.
10. Convert a selected graph into a Workflow draft without executing it.
11. Exercise a 1,000-visible and 10,000-total performance fixture.
12. Verify keyboard-only behavior, high-DPI, and 1024px layout.

Add a dedicated `pnpm test:board:e2e` inspection command before the first new
editor interaction PR reaches completion.

## 14. Acceptance criteria

### Repository and architecture

- No source, styles, icons, assets, record names, file format, or branding are
  copied from the reference checkout.
- `.kiboard` stays on `kition-board` version 1 with no conversion path.
- `BoardStore` and `BoardCommandRegistry` remain the only durable mutation and
  history foundation.
- Board logic stays under `src/features/whiteboard`.
- Agent lifecycle stays under `src/features/agent`.
- workspace composition stays under `src/features/workspace`.

### Canvas quality

- Pan, zoom, draw, select, transform, snap, connect, group, frame, and text
  editing remain correct at every supported zoom level.
- Connectors and hierarchy survive edit, save, reopen, undo, redo, and Agent
  operations.
- 1,000 visible and 10,000 total mixed elements remain usable on supported
  desktop hardware.
- SVG and PNG exports match the visible Board and resolve local images.
- Kition design tokens control product chrome with no blue-heavy or neon theme.

### Agent trust and privacy

- Selection, viewport, point, region, and whole-Board scopes are explicit.
- Context contains no host paths, credentials, or unrelated workspace content.
- Screenshots are bounded and sent only on an explicit model request.
- Every Agent edit is validated and previewed before commit.
- Accept is one undo step; reject and cancel are zero Board changes.
- Invalid, stale, oversized, unsafe, or capability-mismatched operations fail
  closed.
- Board-to-Workflow creates a draft and never enables or executes it.

### Completion gates

- `pnpm run build:check` passes.
- focused Board unit, component, and E2E tests pass.
- `python3 scripts/check-i18n.py` passes.
- `pnpm test:table:e2e` passes.

## 15. Recommended first implementation milestone

Start with PR 1: introduce the `BoardElementDefinition` registry without
changing visible behavior or the `.kiboard` output. This creates the extension
boundary required for richer shapes, connectors, export, Agent semantics, and
future performance work while keeping the current native Board fully usable.
