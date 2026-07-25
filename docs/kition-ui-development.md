# Kition UI Development Guide

This document defines the front-end structure and coding rules for the Kition client.

## Architecture

Use the following directory responsibilities consistently:

```text
src/
  app/          App entry, shell layout, global styles, top-level routing
  components/   Shared presentational UI building blocks
  features/     Product features grouped by domain
  api/          HTTP client wrappers
  services/     Runtime integration, desktop helpers, side-effect services
  lib/          Shared low-level utilities
  types/        Shared TypeScript types
  registry/     Shared UI primitives (vendor-style snippets) reused across features
```

Editor workspace layout should follow a consistent chrome:

- topbar: workspace switcher, status, view actions, export actions
- sidebar: document tree, create entrypoint, media sections, AI entrypoint
- tab strip: open document, table, agent, and gallery tabs
- editor pane: tabs, contextual alerts, active editor surface

Recommended ownership for editor chrome:

- `src/features/workspace/components/WorkspaceTopbar.tsx`
- `src/features/workspace/components/WorkspaceSidebar.tsx`
- `src/features/workspace/components/WorkspaceTabStrip.tsx`
- `src/features/workspace/components/WorkspaceEditorPane.tsx`
- `src/features/workspace/components/WorkspaceTree.tsx`
- `src/features/workspace/components/WorkspaceMediaPanel.tsx`

Recommended ownership for editor content panes:

- `src/features/document/components/DocumentRichEditorPane.tsx`
- `src/features/document/components/DocumentSplitEditorPane.tsx`
- `src/features/table/components/TableEditorPane.tsx`

Current feature split:

- `src/features/agent`: AI chat, agent execution timeline, model selection, and agent-only interaction flows
- `src/features/document`: rich-text document editing and document workspace flows
- `src/features/table`: structured table editing and table-specific panels
- `src/features/workspace`: editor chrome, workspace navigation, tabs, tree, and media navigation
- `src/features/settings`: desktop settings surfaces

## Naming

- Use `Workspace*` for editor shell, navigation, tabs, tree, and layout chrome.
- Use `Document*` for rich-text document concerns.
- Use `Table*` for structured table and record concerns.
- Use `Agent*` for AI chat, orchestration panels, and agent-specific execution UI.
- Do not add new catch-all `data/` UI directories.
- Do not reintroduce `src/react`; React is the implementation, not a domain boundary.
- Prefer domain-first names over technology-first names.

Examples:

- `TableEditor.tsx`
- `TableAgentPanel.tsx`
- `WorkspaceSidebar.tsx`
- `DocumentExportDialog.tsx`
- `DesktopSettingsPage.tsx`

## File Placement

- Put entry glue only in `src/app`.
- Keep route redirects and path normalization in top-level routing, not inside page components.
- Put reusable generic controls in `src/components`.
- Put domain logic, domain pages, and domain-specific panels inside `src/features/<domain>`.
- Keep editor shell, navigation tree, workspace tabs, and chrome helpers inside `src/features/workspace`.
- Keep workspace-local persistence helpers such as tree metadata, tabs, and sidebar width inside `src/features/workspace/lib`.
- Keep workspace tree shaping, flattening, folder-path derivation, and tree-order helpers inside `src/features/workspace/lib`.
- Keep workspace tree state hooks and workspace tree action hooks inside `src/features/workspace/hooks`.
- Keep workspace topbar and item-menu action hooks inside `src/features/workspace/hooks`.
- Keep workspace editor-pane prop builders and panel-assembly hooks inside `src/features/workspace/hooks`.
- Keep workspace screen-level composition inside `src/features/workspace/components`, not in `src/app`.
- Keep workspace tab state, activation flow, and tab persistence hooks inside `src/features/workspace`.
- Keep document formatting, document export, and rich-text editor behavior inside `src/features/document`.
- Keep document snapshot/history persistence inside `src/features/document/lib`.
- Keep document draft parsing and stored-content transforms inside `src/features/document/lib`.
- Keep active document session state, draft cache, and autosave hooks inside `src/features/document`.
- Keep document rich editor panes and markdown split panes inside `src/features/document/components`.
- Keep table creation, table editor behavior, and table-only commands inside `src/features/table`.
- Keep table editor pane wrappers inside `src/features/table/components`.
- Keep Agent-specific config, timeline formatting, and chat UI inside `src/features/agent`.
- Keep Agent session state, streaming lifecycle, and model-selection hooks inside `src/features/agent`.
- Keep desktop settings subscription and synchronization hooks inside `src/features/settings/hooks`.
- Let `src/app/Shell.tsx` stay focused on route-level shell chrome, modal routing, and app-wide entry concerns.
- Let workspace screen components own editor-page composition, portal consumption, and feature orchestration.
- Do not place new Agent presentation logic back into `src/app/Shell.tsx`.
- Keep `src/registry` focused on editor integration. Do not place app-level business UI there unless the change is truly editor-registry specific.

## Size And Split Rules

- `src/app/App.tsx` must stay thin. It should only hold app bootstrap concerns.
- When a file grows beyond roughly 800 lines, split it before adding more behavior.
- If a component owns multiple panels, extract the panels into sibling files.
- If two files repeat model-building, formatting, or mapping logic, move it into `lib/` inside the feature or `src/lib/` if it is cross-feature.

Transition note:

- `src/app/Shell.tsx` remains a transition file. Do not keep expanding it inline. New behavior should be added through extracted subcomponents or feature utilities.
- `src/features/table/components/TableEditor.tsx` is a container. Keep it focused on view composition, local UI state wiring, and feature orchestration.
- `Shell.tsx` should trend toward orchestration only: routing, workspace state, persistence, and cross-feature coordination.
- `TableEditor.tsx` should trend toward orchestration only: derived view state, panel assembly, and event routing.
- Put table document loading and record window loading inside `src/features/table/hooks/useTableEditorData.ts`.
- Keep `src/features/table/hooks/useTableEditorActions.ts` as a thin composition hook.
- Put table view config state, active-view config hydration, and view config persistence inside `src/features/table/hooks/useTableViewState.ts`.
- Put table title, field, view, CSV, and table-level command actions inside `src/features/table/hooks/useTableStructureActions.ts`.
- Put record mutations, row ordering, kanban moves, and AI field execution inside `src/features/table/hooks/useTableRecordActions.ts`.
- Put table selection state, context-menu state, preview state, and kanban drag UI state inside `src/features/table/hooks/useTableEditorUiState.ts`.
- Put table filter/sort/group/grid footer summaries and other pure derived editor state inside `src/features/table/hooks/useTableEditorDerivedState.ts`.
- If `TableEditor.tsx` needs new behavior, prefer a feature hook or sibling component before adding more inline helper functions.
- Keep `TableEditor.tsx` as a composition root only. View-mode switching, footer status blocks, and record context-menu behavior should live in sibling components.
- Keep `TableEditorToolbar.tsx` as a composition root only. Title/view navigation and property/action controls should live in sibling toolbar subcomponents.
- Keep `TableEditorToolbarPropertyBar.tsx` as a composition layer only. Hidden-field, filter, sort, group, cover, and add-property popovers should live in dedicated toolbar control components.
- Prefer a dedicated workspace screen/container under `src/features/workspace/components` instead of rebuilding editor-page assembly inside `src/app/Shell.tsx`.
- Keep `WorkspaceScreen.tsx` focused on state orchestration. Sidebar assembly and editor assembly should be split into sibling workspace screen components when the screen grows.
- Workspace tree, gallery, tab strip, topbar, and sidebar should continue living under `src/features/workspace`.
- Document export and rich-text editor logic should continue living under `src/features/document`.
- Agent is a primary product capability. Prefer moving Agent work into `src/features/agent` even when the shell currently owns the surrounding workspace state.
- Table-scoped Agent panels may stay under `src/features/table/components` as presentation wrappers, but session state, streaming logic, model resolution, and timeline formatting belong in `src/features/agent`.
- Prefer feature hooks or feature libs over new inline helper clusters inside `Shell.tsx`.
- Prefer a workspace hook for tab state instead of re-implementing tab open/close/activate logic inside `Shell.tsx`.
- Prefer workspace hooks for tree loading, create/delete/move flows, and root switching instead of rebuilding worktree behavior inline in `Shell.tsx`.
- Keep `useWorkspaceTreeActions.ts` as a thin composition hook.
- Put workspace document-list hydration, root switching, and local-folder reveal actions inside `src/features/workspace/hooks/useWorkspaceTreeLoader.ts`.
- Put workspace create-document, create-table, and create-inside flows inside `src/features/workspace/hooks/useWorkspaceTreeCreateActions.ts`.
- Put workspace delete/move/reorder node flows inside `src/features/workspace/hooks/useWorkspaceTreeNodeActions.ts`.
- Prefer workspace hooks for topbar actions such as editor mode switching, import/export entrypoints, and item-menu commands instead of rebuilding them inline in `Shell.tsx`.
- Prefer a document hook for active document state, draft state, open/save flows, and autosave instead of rebuilding them inline in `Shell.tsx`.
- Keep `useWorkspaceDocumentSession.ts` focused on active-document orchestration, document switching, and draft restoration.
- Keep autosave timers, shortcut save, unload guards, and persistence sequencing inside `src/features/document/hooks/useWorkspaceDocumentAutosave.ts`.
- Keep opened-document draft cache types and cloning helpers inside `src/features/document/lib/openedDocumentDrafts.ts`.

## Cleanup Rules

- Remove dead pages, dead wrapper files, and duplicated utilities when found.
- Avoid one-line indirection files unless they provide a stable public boundary with real value.
- Reuse `src/lib/utils.ts` for shared `cn`-style helpers instead of duplicating them.

## Implementation Workflow

When changing UI code:

1. Identify the owning domain first: `app`, `workspace`, `document`, `table`, `settings`, or shared.
2. If the change is AI-chat or agent-run related, default ownership is `agent`.
3. Place new code in the smallest responsible scope.
4. Keep feature-local helpers near the feature.
5. Delete stale code that becomes unused after the refactor.
6. Run `npm run build:check` before finishing.

## Review Checklist

- Does the file live in the correct domain directory?
- Is the naming aligned with `Workspace*`, `Agent*`, `Document*`, and `Table*`?
- Did the change avoid growing shell files unnecessarily?
- Was dead code removed if the refactor made it obsolete?
- Did `npm run build:check` pass?
