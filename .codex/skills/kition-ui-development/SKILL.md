---
name: kition-development
description: Use this skill when changing the Kition frontend so Codex follows the local directory structure, naming rules, file-splitting rules, and build verification workflow.
---

# Kition UI Development

Use this skill for frontend changes in the Kition client repository.

## Required first step

- Read `docs/kition-ui-development.md` before making structural or UI changes.

## Rules

- Keep `src/app` for bootstrap, shell, routing, and global styles only.
- Keep route redirects and path normalization in app-level routing, not inside page components.
- Put generic shared controls in `src/components`.
- Put business UI in `src/features/<domain>`.
- Put editor chrome, workspace tree, tabs, and shared editor navigation in `src/features/workspace`.
- Put AI chat, agent timeline, and agent-only helpers in `src/features/agent`.
- Put Agent session state, streaming lifecycle, and model-selection hooks in `src/features/agent`.
- Keep `Shell.tsx` as route-level shell glue; do not move new Agent presentation logic or editor-page assembly back into it.
- Treat Agent as a first-class domain alongside document, table, and settings.
- Keep editor workspace pages on a stable chrome: topbar, sidebar, tab strip, editor pane.
- Keep workspace tree, media gallery, tab strip, topbar, and sidebar inside `src/features/workspace/components`.
- Keep workspace navigation helper types and workspace display logic inside `src/features/workspace/lib`.
- Keep workspace-local persistence helpers such as tabs, tree metadata, and sidebar width inside `src/features/workspace/lib`.
- Keep workspace tree shaping and folder-path helpers inside `src/features/workspace/lib`.
- Keep workspace tree state hooks and workspace tree action hooks inside `src/features/workspace/hooks`.
- Keep workspace topbar and item-menu action hooks inside `src/features/workspace/hooks`.
- Keep workspace editor-pane prop builders and panel-assembly hooks inside `src/features/workspace/hooks`.
- Keep workspace screen-level page composition inside `src/features/workspace/components`, not `src/app`.
- Keep workspace tab state and tab persistence hooks inside `src/features/workspace`.
- Keep document export dialog and rich-text editor behavior inside `src/features/document`.
- Keep document snapshot/history persistence inside `src/features/document/lib`.
- Keep document draft parsing and stored-content transforms inside `src/features/document/lib`.
- Keep document rich editor panes and markdown split panes inside `src/features/document/components`.
- Move editor chrome presentation into workspace feature components instead of growing page-level JSX inline.
- Keep desktop settings subscription and synchronization hooks inside `src/features/settings/hooks`.
- Keep table creation and table-only commands inside `src/features/table`.
- Keep table editor pane wrappers inside `src/features/table/components`.
- Use `Workspace*` names for editor shell and navigation concerns.
- Use `Document*` names for rich-text document flows.
- Use `Table*` names for structured table flows.
- Use `Agent*` names for AI chat and agent execution flows.
- Do not create or restore a `src/react` directory.
- Do not introduce new catch-all UI folders like `data/` when a domain folder already exists.
- When a file grows past roughly 800 lines, split it instead of extending it inline.
- Prefer feature hooks or feature libs over new inline helper clusters inside `Shell.tsx`.
- Prefer a workspace hook for tab open/close/activate flows instead of rebuilding tab state inline in `Shell.tsx`.
- Prefer workspace hooks for tree loading, create/delete/move flows, and root switching instead of rebuilding worktree behavior inline in `Shell.tsx`.
- Prefer workspace hooks for topbar actions such as editor mode switching, import/export entrypoints, and item-menu commands instead of rebuilding them inline in `Shell.tsx`.
- Remove dead wrappers, dead pages, duplicated helpers, and stale imports during refactors.
- Treat `src/registry` as editor-integration code, not a default place for app business logic.

## Validation

- Run `npm run build:check` after UI refactors.
- Report any remaining warnings or structural follow-up items briefly.
