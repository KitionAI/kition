# Kition Quality Program Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is one branch and one worktree.

**Goal:** Reduce defect rate, make the codebase safe to change, and bring the product UI in line with `docs/design.md`, across the public client, the private runtime, and the console.

**Scope:** This document is the program-level plan and the detailed client plan. Runtime and console details live in their own repositories:

- Runtime: `docs/superpowers/plans/2026-09-27-runtime-architecture-quality-plan.md` in `KitionAI/kition-runtime`
- Console: `docs/2026-09-27-console-quality-plan.md` in `KitionAI/kition-console`

**Tech Stack:** TypeScript, React 19, Electron, CodeMirror 6, Vite, Vitest, Playwright, Go (runtime and console), Ant Design (console web).

**Baseline (2026-09-27):** `pnpm typecheck`, `pnpm lint`, and `pnpm test:unit` (4,066 tests) exit 0. Runtime and console `go vet` and `go test` exit 0. The problems below are structural, not build hygiene.

---

## 1. Assessment

### 1.1 Cross-repository findings

| Area | Finding | Evidence |
| --- | --- | --- |
| Lost intent | Source comments were stripped to whitespace during the English-only cleanup. 82 client files start with whitespace-only blocks, 2,704 whitespace-only lines in `src/`, and shell scripts such as `scripts/inspect-table-widget.sh` have blank headers. | `grep -rc '^ \{4,\}$' src` |
| Three UI stacks | Client: hand-written CSS plus Tailwind 3 plus Radix. Portal: Ant Design 6 plus Tailwind 4 plus framer-motion. Admin: Ant Design 6 plus Tailwind 4. No shared tokens or components. | `package.json` in each web project |
| Contradictory design direction | `docs/design.md` mandates purple `#5645d4` CTAs, light surfaces, 8px buttons, no pills. The console plan `UI_UX_MIGRATION.md` targets ink-only pill CTAs and an editorial style. README screenshots show a dark product. The client default theme is dark through `migrateThemeToDarkDefault`. | `src/services/desktopSettings.ts:665` |
| Local runtime is unauthenticated | The runtime listens on loopback with auth disabled and resolves a seeded debug principal. CORS restricts browsers, but any local process can call the runtime API, which can read workspace files and run approved shell commands. | Runtime plan section 2.1; `contracts/runtime/` has no auth contract |
| Table storage has two truths | Tables are registered as runtime database rows and also live as `.kitable` files. The client has a lazy "register unseen `.kitable` files" workaround in `WorkspaceScreen.tsx`. | `src/features/workspace/components/WorkspaceScreen.tsx:300-330` |

### 1.2 Client architecture findings

| # | Finding | Evidence |
| --- | --- | --- |
| C1 | `WorkspaceScreen.tsx` is a 3,867-line god component: 31 effects, 42 callbacks, 47 handlers, 69 imports, JSX starts at line 3196. It is the most-changed source file in history (22 commits). | `wc -l`, `git log --name-only` |
| C2 | No application state layer. 374 `useState` calls, 2 contexts, no router. `jotai` is installed but used only by one vendored dialog. Cross-pane coordination is done with props and portals (`topbarActionsPortal`). | `grep -rn "atom(" src` returns 0 |
| C3 | No data-fetch layer. Every hook hand-rolls `loading`, `error`, refetch, and cache. There is no invalidation model tied to file watcher events, so stale views are a recurring bug class. | `useTableEditorData.ts:57`, no `react-query` usage |
| C4 | Cross-feature import cycles: workspace to document (21) and document to workspace (8); workspace to workflow (13) and workflow to workspace (3); workflow to emailSync (11) and emailSync to workflow (6). | import graph over `src/features` |
| C5 | Two API conventions: `src/api/*.ts` plus five feature-local `api.ts` files (`workflow`, `formSync`, `emailSync`, `connections`, `media-generation`). Response types are hand-written rather than derived from `contracts/runtime/*.schema.json`. | `find src/features -name api.ts` |
| C6 | `commands.ts` is 24,590 lines with 1,681 exports after removing 31 dead declarations. 1,083 of them are commands registered in `DocumentCommandPalette.tsx` through one 1,100-line import list; most of the rest are per-command text helpers. Names such as `insertOKRCascadeTemplate` and `paragraphsToCompetitiveMatrix` indicate bulk generation. The problem is an unreviewed product surface of about a thousand palette commands, not unreachable code. | AST reference analysis over `src/` |
| C7 | Duplicate UI primitives: `Button`, `Input`, and `Dialog` exist in both `src/components/ui.tsx` and `src/registry/ui/`. `styles.css` is 9,547 lines in one file with 26 `!important` and 6 section headers. 1,686 Tailwind class lines coexist with 183 BEM class lines. | `grep -c '!important'` |
| C8 | No `ErrorBoundary` anywhere. A render error in any pane unmounts the whole window. An e2e spec named `large-doc-scroll-white-screen` exists for exactly this class. | `grep -rln ErrorBoundary src` returns nothing |
| C9 | `src/services/desktop.ts` has 129 exports covering browser sessions, bootstrap, file operations, updates, and notifications. `electron/main.mjs` is 2,238 lines with 109 functions and 71 IPC handlers registered inline. | export count |
| C10 | Keyboard handling is scattered: 55 ad-hoc `metaKey` and `ctrlKey` checks, no shortcut registry, no discoverable shortcut list. | `grep -rn "metaKey\|ctrlKey" src` |
| C11 | i18n gaps: 53 raw English JSX strings, 33 raw `aria-label` strings, and four locales (es-ES, fr-FR, pt-BR, ru-RU) each missing 302 keys versus en-US. `scripts/check-i18n.py` compares only en-US with zh-CN, so these gaps pass CI. | flattened key diff per locale |
| C12 | Test coverage is wide but CI is narrow. 60 Playwright specs exist; CI runs 2 plus the desktop subset; 37 specs are not referenced by any script; 18 use `skip` or `fixme`. The mandatory Stop hook runs a single spec. | `.github/workflows/ci.yml`, `package.json` |
| C13 | Dependency hygiene: `prop-types`, `sass`, and `tailwindcss-animate` are unused; `react-dnd`, `react-grid-layout`, `react-hammerjs`, `scroller`, `jotai-x`, `vaul`, `cmdk`, `docx`, and `recharts` are each used by one file. `DndProvider` wraps the whole app for one consumer. | import scan |
| C14 | Bundle: main chunk 1.07 MB, second chunk 663 KB, CSS 385 KB, plus eager-loaded `cytoscape` (435 KB) and `docx` (362 KB). | `ls -la dist/assets` |
| C15 | UI details visible in shipped README assets: the agent empty state renders a broken logo image, the sidebar has no sections or empty-state guidance, and tab chrome spacing is uneven. | `docs/readme/agent.webp` |

Electron process security is sound: `contextIsolation`, `sandbox`, and `nodeIntegration: false` are set on every window, navigation is guarded, and each module has a spec.

### 1.3 What is already good and must be preserved

- Whiteboard: modular `lib/board*.ts` engine with specs per module and an explicit interaction machine.
- Table grid: canvas renderer with a clear renderer and interaction layer split.
- Electron main process modules and their unit specs.
- Runtime contracts under `contracts/runtime/` and the runtime lock plus verification flow.
- Repository guards: branding, i18n, secrets, notices, performance budget.

---

## 2. Decisions required from the maintainer

These change the work materially. Defaults are stated so the plan can proceed without blocking.

| Decision | Options | Default used by this plan |
| --- | --- | --- |
| D1 Default product theme | Light per `docs/design.md`, or dark as shipped | Light default, dark stays a first-class option. `docs/design.md` and the README assets are updated together. |
| D2 Console visual direction | `docs/design.md` purple system, or the ElevenLabs editorial direction in `UI_UX_MIGRATION.md` | `docs/design.md`. The console migration document is retired. |
| D3 Client state and data libraries | Adopt `jotai` (already installed) plus TanStack Query, or keep hand-rolled hooks | Adopt both. |
| D4 Loopback runtime token | Add a per-launch bearer token to the public contract, or accept unauthenticated loopback | Add the token. This is a contract change and is sequenced first. |

---

## 3. Program phases

Order matters. Each phase leaves `main` releasable.

| Phase | Outcome | Depends on |
| --- | --- | --- |
| 0 Guardrails | CI catches regressions the plan will otherwise reintroduce | none |
| 1 Client foundation | State, data, API, and UI-kit layers exist; god components are split | 0 |
| 2 Runtime hardening | Local principal, loopback token, typed boundaries, single table storage truth | 0, contract task in 1 |
| 3 Product UI and UX | Product matches `docs/design.md`; shortcuts, empty states, i18n complete | 1 |
| 4 Console | Service split, shared web package, coverage | 0 |
| 5 Delivery | Bundle budget, lazy loading, release verification | 1, 3 |

---

## 4. Global constraints

- Keep all repository source, tests, fixtures, comments, and documentation in English.
- Do not add private runtime implementation to this repository. Runtime behavior changes go contract-first: update `contracts/runtime/` and the client mock, then implement privately, then validate as a black box.
- Never write host-identifying paths into tracked files.
- Run `python3 scripts/check-i18n.py`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, and `pnpm test:table:e2e` before declaring any task complete.
- Editor layout, scrollbar, and jitter changes must be verified in the real Electron client, not only headless.
- One task per branch and worktree. No task may exceed the file-size ceilings introduced in Phase 0.

---

## 5. Phase 0: Guardrails

### Task 0.1: Add an application error boundary

**Files:**
- Create: `src/components/AppErrorBoundary.tsx`
- Create: `src/components/AppErrorBoundary.spec.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/features/workspace/components/WorkspaceEditorContent.tsx`
- Modify: `src/i18n/locales/en-US/common.json` and `src/i18n/locales/zh-CN/common.json`

**Interfaces:**
- `AppErrorBoundary({ scope: 'app' | 'pane', onReset?, children })` renders a recoverable fallback with a reload action and reports through the existing feedback client.

- [x] Write a failing test that throws inside a child and asserts the fallback renders with the pane name and a retry button. (2026-09-27: 5 specs in `AppErrorBoundary.spec.tsx`.)
- [x] Implement the boundary and wrap `App` at `scope: 'app'` and each editor pane at `scope: 'pane'`. (`EditorPaneBoundary` in `WorkspaceEditorContent.tsx` wraps all 14 pane mounts.)
- [ ] Add an e2e assertion to `e2e/app-shell.spec.ts` that a forced pane error does not blank the shell. Needs a test-only trigger; decide whether a `?e2e-throw=<pane>` query flag in development builds is acceptable.

### Task 0.2: Dead code and boundary linting

**Files:**
- Create: `tooling/knip.json`
- Create: `tooling/dependency-cruiser.cjs`
- Modify: `tooling/eslint.cjs`
- Modify: `package.json`

- [x] Add `knip` and record the baseline in `tooling/knip.baseline.json` (2026-09-27: 278 unused exports, 248 unused types, 3 duplicate exports across 145 files). `scripts/check-knip-baseline.mjs` fails on new entries and reports fixed ones; `pnpm run check:knip:update` shrinks the baseline. Fixed on the way: `nanoid` was unused, `react-resizable` was imported but unlisted.
- [x] Add `dependency-cruiser` rules in `tooling/dependency-cruiser.cjs`: no import cycles anywhere, no cross-feature imports except through `src/features/<name>/public.ts`, shared layers never import features. Baseline `tooling/dependency-cruiser.known.json` holds 377 known violations (156 cycles, 213 cross-feature internals, 5 shared-layer leaks); `pnpm run check:deps` ignores known entries and `check:deps:update` runs in shrink-only mode.
- [x] Add ESLint `max-lines` (600 for `.tsx`, 800 otherwise) and `max-lines-per-function` (200) as errors, with baseline overrides in `tooling/eslint.cjs` listing the 25 files over the file ceiling and the 74 files with a function over 200 lines. Entries may only be removed.
- [x] Remove `prop-types` and `sass`; regenerate third-party notices. (`tailwindcss-animate` stays: `tooling/tailwind.config.ts` loads it.)

### Task 0.3: Run the whole e2e suite in CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tooling/playwright.config.ts`
- Modify: `package.json`
- Modify: every `e2e/*.spec.ts` that uses `skip` or `fixme`

- [x] Scope by exclusion instead of tags (2026-09-27): `KITION_E2E_SCOPE=ci` makes `tooling/playwright.config.ts` ignore live-service specs, Electron specs, and the quarantine list in `tooling/e2e-quarantine.json`; everything else runs in one sweep (`pnpm test:e2e:ci`, 43 files, 203 tests). Live specs keep their `inspect-*.sh` gates; Electron specs run under xvfb in two CI steps.
- [x] `scripts/check-e2e-coverage.mjs` (`pnpm run check:e2e-coverage`, also a CI step) fails when a spec file is in none of: the sweep, a package.json or shell script, or the quarantine list. Deleted `workflow-tree-workflow-leaves.spec.ts`, which contained no tests.
- [x] Triage: removed 5 empty placeholder `test.skip` bodies; the env-gated skips (live catalog, README capture, real workflow) are legitimate and stay. 15 tests across 9 files fail deterministically against the current UI (also on the commit before the cleanup) and are marked `test.fixme` with a dated reason; `kitable-table-leaf-actions.spec.ts` fails entirely and is quarantined as a file. All 16 are listed in `tooling/e2e-quarantine.json` and must be fixed or deleted, never extended.
- [x] Coverage floors in `tooling/vitest.config.ts`, enforced by `pnpm run test:coverage` (CI runs it instead of plain `pnpm test`). Measured 2026-09-27, statements: table 28%, document hooks 34%, services 64%. Raise as tests land.
- [x] Make the inspection scripts proxy-safe. Playwright's web server availability probe sends its HTTP GET through `HTTP_PROXY` even when `NO_PROXY` lists `127.0.0.1`; a proxy that answers 400 makes Playwright believe the server is up, Vite never starts, and every test fails with connection refused. (2026-09-27: `tooling/playwright.config.ts` drops the proxy variables for the runner and its children; the three single-spec gates now share `scripts/lib/run-inspection.sh`.)

### Task 0.4: Restore stripped comments

**Files:**
- Modify: the 82 client files and scripts with whitespace-only blocks (list with `grep -rlE '^ {4,}$' src scripts electron`)

- [x] Write `scripts/check-blank-comment-blocks.py`, which fails on any line containing only spaces or tabs. (2026-09-27)
- [x] Delete every blanked block (about 3,300 whitespace-only lines across roughly 130 files, each verified content-identical once blank lines are ignored) and add English module comments to `commands.ts`, `live-preview.ts`, `table-widget.ts`, `WorkspaceScreen.tsx`, `scripts/post-task-e2e.sh`, and the inspection scripts.
- [x] Add the script to `pnpm run check` as `check:blank-comments`.

---

## 6. Phase 1: Client foundation

### Task 1.1: Typed API client generated from contracts

**Files:**
- Create: `scripts/generate-contract-types.mjs`
- Create: `src/api/generated/` (generated, committed)
- Create: `src/api/client.ts`
- Modify: `src/api/request.ts`
- Move: `src/features/workflow/api.ts` to `src/api/workflows.ts`; same for `formSync`, `emailSync`, `connections`, `media-generation`

**Interfaces:**
- `api.<domain>.<operation>(input): Promise<Output>` where types come from `contracts/runtime/*.schema.json` via `json-schema-to-typescript`.
- `request.ts` keeps the error normalization and credit-exhaustion hooks, exposes a single `ApiError` class with `code`, `message`, `status`, `data`.

- [x] `scripts/generate-contract-types.mjs` (2026-09-27) writes one module per contract into `src/api/generated/` with `<Contract><Def>` names; `pnpm run check:contracts` fails CI when the output is stale. It is a small in-repo generator: `json-schema-to-typescript` is incompatible with the pinned `js-yaml` security override.
- [x] Moved `emailSync`, `connections`, and `workflows` into `src/api/`; `formSync` was split into an HTTP module (`src/api/formSync.ts`) and the local-draft orchestration that stays in the feature. Workflow body-template types and run records moved with the API; `src/lib/workflowEvents.ts` owns the change events. `media-generation/api/imageTemplates.ts` stays: it is a cloud contract with feature-local validation and moves with Task 1.5.
- [x] `emailSync`, `formSync`, `dataImports`, and `workspaceStorage` types are aliases of the generated contract types; the client only narrows `DataImportField.options` to its field-option shape. Still hand-written, no schema yet: `workflows`, `agent`, `dataDocuments`, `dashboards`, `desktop`, `models`, `presentations`, `templates`. Writing those schemas is the remaining half of this task and needs the runtime maintainer.
- [~] `src/test/contracts.ts` validates values against a contract definition with Ajv; `emailSync.spec.ts` and `dataImports.spec.ts` use it. Extend to every API spec as schemas land.

### Task 1.2: Introduce a data layer with TanStack Query

**Files:**
- Modify: `package.json` (add `@tanstack/react-query`)
- Create: `src/app/QueryProvider.tsx`
- Create: `src/api/queryKeys.ts`
- Create: `src/api/invalidation.ts`
- Modify: `src/main.tsx`
- Modify: `src/features/table/hooks/useTableEditorData.ts`
- Modify: `src/features/workspace/hooks/useWorkspaceTreeState.ts`
- Modify: `src/features/agent/hooks/useWorkspaceAgent.ts`

**Interfaces:**
- `queryKeys.document(path)`, `queryKeys.table(docId, tableId)`, `queryKeys.records(docId, tableId, viewId)`, `queryKeys.agentSession(id)`.
- `invalidation.ts` subscribes to the workspace watcher IPC events and invalidates keys by path prefix. This replaces manual refresh calls.

- [x] `QueryProvider` (desktop defaults: no focus refetch, no retries, 5s staleTime), `queryKeys.ts` (root-scoped hierarchical keys), and `invalidation.ts` wired to the file watcher, `kition:workspace-reload`, and the workflow, form sync, email sync, and connections change events. `invalidation.spec.ts` proves a `.kitable` change invalidates that document and the kitable index only, and that other roots and runtime lists stay untouched. (2026-09-27)
- [x] First migration: `useKitableChildrenIndex` reads through `useQuery` with the same return shape; renames and table-title edits patch the cache with `setQueryData`. Consumers unchanged.
- [ ] Migrate `useTableEditorData` keeping its return shape. Its setters are mutated from 52 call sites across 7 table hooks, so this needs the record cache to expose `setQueryData`-backed setters first; not started.
- [ ] Migrate the workspace tree, then documents, then agent session lists. The tree loader also opens the active document as a side effect (`useWorkspaceTreeLoader.applyWorkspaceDocumentList`), so split that out before moving the listing into a query.
- [x] The "register unseen `.kitable` files" effect moved out of `WorkspaceScreen.tsx` into `src/features/workspace/hooks/useKitableRegistration.ts` with specs for the pure selector and the once-only retry behavior. Delete it when runtime plan Task R4 ships.

### Task 1.3: Workspace state store and navigation model

**Files:**
- Create: `src/features/workspace/state/workspaceAtoms.ts`
- Create: `src/features/workspace/state/tabs.ts`
- Create: `src/features/workspace/state/panes.ts`
- Create: `src/features/workspace/state/*.spec.ts`
- Modify: `src/app/Shell.tsx`

**Interfaces:**
- Atoms: `activeWorkspaceRootAtom`, `openTabsAtom`, `activeTabIdAtom`, `sidebarAtom`, `agentPanelAtom`, `browserPanelAtom`, `settingsRouteAtom`.
- Actions as pure functions on state: `openTab(state, descriptor)`, `closeTab(state, id)`, `pinTab`, `activateTab`, with tests.
- One `WorkspaceLocation` type that serializes the current tab, pane, and settings section. Persist it per workspace root so relaunch restores the view.

- [x] `src/features/workspace/state/tabs.ts` holds every tab transition as a pure function over `{ tabs, activeTabId }` (upsert with one-logical-tab-per-kitable, close with neighbour fallback, filter, path remap after moves, kitable rename collapse, workspace switch, initial binding) with 15 table-driven specs. `useWorkspaceTabs` now only applies them, persists per root, and runs side effects after the update. This also fixes a StrictMode bug: the close callback used to run inside the state updater, so it fired twice in development. (2026-09-27)
- [ ] `jotai` atoms deferred: the tab list has exactly one consumer (`WorkspaceScreen`), so an atom store would add a second source of truth without a reader. Introduce atoms when Task 1.4 gives the command palette or the agent bridge a reason to read tab state outside `WorkspaceScreen`; `jotai-x` removal still belongs to Task 1.5.
- [x] `src/app/appLocation.ts` (2026-09-28) is the typed top-level location: `documents`, `settings` with its section, `scenario`, or `workflow` with its sub-path and history-state context. The shell parses the URL once (`readAppLocation`), applies it to the view states in one place, and closes views through `leaveAppView`, which only rewrites the URL when it names that view. The ad-hoc query and pathname parsing is gone; 13 specs cover parsing, the pathname round-trip, and leaving a view. Persisting the location per workspace root still belongs with the atoms above.

### Task 1.4: Split `WorkspaceScreen.tsx`

**Files:**
- Modify: `src/features/workspace/components/WorkspaceScreen.tsx` (target under 400 lines)
- Create: `src/features/workspace/hooks/useWorkspaceTabsController.ts`
- Create: `src/features/workspace/hooks/useWorkspaceBrowserPanel.ts`
- Create: `src/features/workspace/hooks/useWorkspaceAgentBridge.ts`
- Create: `src/features/workspace/hooks/useWorkspaceCreateFlows.ts`
- Create: `src/features/workspace/hooks/useWorkspaceDialogs.ts`
- Create: `src/features/workspace/components/WorkspaceDialogs.tsx`
- Create: one spec per new hook

**Ownership after the split:**
- `useWorkspaceTabsController`: open, close, rename, activate, restore tabs. Depends on Task 1.3 atoms.
- `useWorkspaceBrowserPanel`: browser tab inset measurement, reattach limit, navigation commands.
- `useWorkspaceAgentBridge`: agent insertion context, table and whiteboard agent context changes, preflight.
- `useWorkspaceCreateFlows`: template, kitable, workflow, form, and folder creation entry points.
- `WorkspaceDialogs`: every lazily-loaded dialog with its open state from `useWorkspaceDialogs`.

- [~] Extract one hook at a time. Done 2026-09-27: `useWorkspaceBrowserPanel` (BrowserView attach, layout, re-attach budget, toolbar commands; the re-attach rule is a pure, tested function and the session sync is its own inner hook because the 200-line function ceiling caught the first draft) and `useWorkspaceWorkflowCreateMode` (create-mode dialog state, template / scratch / chat branches, post-create routing). Then `useWorkspaceTemplateDialogs` (the new-document and new-table template pickers with their post-create routing and template follow-ups) and `useWorkspaceWhiteboardAgentBridge` (the registry of open boards' Agent bridges: capability probe, patch routing with fallback to the active board, preview cancel, context building; 3 specs). Then `useWorkspaceTableAgentContext` (which table the Agent is talking about: per-path contexts published by table editors, browser-origin resolution, the remembered last target, lazy hydration from the runtime). Then `useWorkspaceAgentBrowserAutomation` (the Agent side of the embedded browser: opening tabs for `browser.open_required` events, the pre-turn preflight, and the once-per-event auto-continue with its attempt budget). Then `useWorkspaceAgentTurnContext` (the context attached to every Agent turn: the render-time base context, the browser-enabled flag, the cursor-aware image insertion anchor, the preflight indirection, and the send-time finalization with live browser page enrichment). Then `useWorkspaceKitableOpeners` (opening table, dashboard, workflow, global workflow, and board tabs; deferred container opens that wait for the children index). Then `useWorkspaceTreeRowActions` (rename and delete dispatch for real files and virtual kitable leaves, with the three near-identical "view deleted, fall back to another view" handlers collapsed into one). Then `useWorkspaceCreateFlows` (the new-folder dialog, the table file import input and dialog, the create menu opened on a .kitable container, and the sidebar actions that add a table, dashboard, or form to a kitable). Then `useWorkspaceAgentPanel` (the Agent sidebar as a panel: open/history state, which sessions show as tabs, the active one, per-workspace persistence, first-chat auto-create, and the sidebar width CSS variable). Then `useWorkspaceAgentChatEntryPoints` (every way a chat starts from elsewhere: a document's ask-the-Agent action, onboarding guides, tree nodes added as context, a workflow node's ask-AI pill, and the AI workflow builder, all through one "open the panel and reuse or create a session" rule). Then `useWorkspaceTabControllers` (closing a tab with the design flush and workflow-workbench rules, Cmd/Ctrl+W, keeping the tree focused on the active tab's file, opening a file into the right tab type, the search palette's open-path requests; also deleted an unreferenced gallery opener). Then `WorkspaceDialogs` (every modal rendered from the hook results that own their state; each dialog keeps its own lazy chunk). Then `WorkspaceAgentPane` (the Agent sidebar wired to the active session from the Agent hook result, the model and hosted-account controls, and the pane-aware empty state; the account feature gained its `public.ts`). Then `useWorkspaceSidebarNavigation` (routing a sidebar row click to the right tab, including the virtual kitable rows). Then `useWorkspaceCreateMenu` (the sidebar create menu's handlers as one spreadable bundle: workspace versus kitable-container mode, new document, folder, table, design, board, workflows, table file import). Then (2026-09-28) `WorkspaceEditorFrame` (the editor column: the .kitable container sidebar next to the active pane or the workflow workbench, with the sidebar's actions passed as one bundle), `activeKitable.ts` (which container the active tab belongs to and which sidebar section it highlights, as pure tested functions), `workspaceTabStripActions.ts` (the tab strip's activation and context-menu handlers), and `state/closeScope.ts` (one tested rule for close others, left, right, and all, now shared by the tab strip and the Agent chat tab bar instead of two hand-written copies). Then `useWorkspaceDocumentTitleRename` (renaming the active document from its inline title: the disk move, then the tree, kitable index, snapshots, Agent-modified paths, tabs, and drafts follow the new path; the snapshot and path-set remaps are pure functions in `lib/documentRename.ts`; 4 specs with mocked services), `useWorkspaceBrowserTabEvents` (the open-browser-tab event: the payload-to-tab mapping moved into `lib/browserTabs.ts` as `buildWorkspaceBrowserTab`, and the request resolution that reuses a matching tab or falls back to the Agent's last table target is a pure function with specs), `useWorkspaceAgentComposer` (sending from the composer, including the ask-for-folder-access step when the draft names a local path; 4 specs), and `useWorkspaceErrorNotice` (the one workspace error toast). Then the Agent grouping: `WorkspaceAgentChrome` (the chat tab bar and the floating launcher, driven by the `useWorkspaceAgentPanel` result as one bundle; the close scopes reuse `closeScope.ts`), `lib/agentTurnUpdate.ts` (the per-render turn-context input as a pure function with specs for table, browser, and workflow tabs), and `useWorkspaceDocumentTranslation` (selection translation bound to the Agent model and the saved default language). Extracting the turn update briefly dropped the line that tells the whiteboard bridge which board is active; the two whiteboard e2e specs caught it before the commit. Then the document and sidebar groupings: `WorkspaceScreenSidebar` now takes the tree state, tree actions, row actions, chat entry points, and chrome as bundles and builds the panel props itself (`buildWorkspaceSidebarPanelProps`, with specs for the desktop-only affordances and the refresh notice); `WorkspaceScreenEditor` takes the document session, browser panel, table Agent context, Agent panel, whiteboard, template dialogs, and workflow openers as bundles (`buildWorkspaceEditorContentProps`, with specs for the derived title and busy state, revision decisions, the open-Agent focus, and the empty-state template dialogs). The Agent floating launcher moved behind the agent feature's `public.ts`. Then `WorkspaceScreenTopbar` (the tab strip, item menu, and toolbar slot from the chrome, topbar-action, derived-state, document-session, and tab bundles; specs cover the toolbar portal gating, the item menu closing before export and reveal, and the text style update). `WorkspaceScreen.tsx` went from 3,832 to 992 lines; every layout surface now takes hook bundles. Remaining: the tab-session wiring (`useWorkspaceTabs` callbacks and the refs that break hook ordering cycles) and the hook dependency chain itself, which is where the last 600 lines live; reordering that chain changes call order and needs its own review.
- [~] Break the cross-feature cycles through `public.ts` entries. Landed: `workflow` (`openWorkflowRoute`, `WorkflowRouteContext`, `createWorkflowFromMode`), `table` (`KitableTemplateDefinition`), `formSync` (`setupTemplateFormSync`), `emailSync` (`requestEmailSyncSetup`), `document` (`DocumentCreationPreset`), `whiteboard` (`WhiteboardAgentBridge`, `runtimeSupportsWhiteboard`), `agent` (browser tab payloads, intent and continuation helpers, turn context builders, `useWorkspaceAgent`), `account` (`useKitionAccount`, `getKitionAccountLinks`, `isKitionAccountSessionUsable`). Every extracted hook imports other features only through these, and `WorkspaceScreen` now reaches the agent and account features only through their entries, which retired 21 baselined boundary violations (369 to 348).
- [~] Apply the same treatment to `WorkflowHomePage.tsx` (2,249 lines) and `DesktopSettingsPage.tsx`. Done 2026-09-28 for the settings page: each pane lives in `src/features/settings/sections/` (General, Account, Display, Runtime, Developer, About), the section list and its searchable-copy sources are `sectionRegistry.ts`, and the sidebar search is `settingsSearch.ts` with the filter as a pure function (3 specs: the haystacks, the default layout, and the Advanced-label rule). The Display pane's two groups became components so no function exceeds the 200-line ceiling; both ESLint baseline entries for the page are gone. Two dead helpers (`Label`, `formatSettingsDateTimeParts`) were deleted. The moved imports go through new `public.ts` entries for `emailProviders`, `analytics`, `updates`, and `support` (and two additions to `account`), which retired 8 baselined boundary violations. `DesktopSettingsPage.tsx` went from 1,249 to 178 lines. `WorkflowHomePage.tsx`, first pass (2026-09-28): `lib/workflowPatches.ts` holds the Save patch, the trigger type and table patches with required-field pruning, the draft reset for an action type change, the filter node factories, the dry-run sample row, the trigger table picker options, and the run status counts, all pure with 9 specs; `useWorkflowTriggerEditor` commits trigger edits through one shared PATCH path and keeps the dangling-field-ref confirmation; `useWorkflowGraphEditing` owns delete, duplicate, disable, and insert on the node chain. Second pass: the 930-line JSX return became region components under `pages/home/` (the detail and index topbars, the run-test header and the unresolved-template and build banners, the canvas node cards, the trigger drawer panel, the add-record, record-action, and email drawer panels sharing one panel context, the page and drawer save rows, and the empty state with its launcher and inline picker). The canvas status light and the action node's inline error precedence are pure functions in `lib/workflowNodePresentation.ts` with 6 specs. The page went from 2,249 to 1,150 lines; every function is under the 200-line ceiling except the page itself, which is still on the baseline. Remaining there: the hook wiring, as with `WorkspaceScreen`.

### Task 1.5: One UI kit

**Files:**
- Create: `src/components/ui/` with one file per primitive: `button.tsx`, `input.tsx`, `textarea.tsx`, `select.tsx`, `dialog.tsx`, `drawer.tsx`, `sheet.tsx`, `tooltip.tsx`, `popover.tsx`, `switch.tsx`, `badge.tsx`, `card.tsx`, `spinner.tsx`, `empty-state.tsx`, `skeleton.tsx`, `page-header.tsx`, `command.tsx`
- Delete: `src/components/ui.tsx`, `src/registry/ui/*`, `src/components/RightDrawer.tsx`, `src/components/RightSheet.tsx` after migration
- Create: `src/components/ui/index.ts`
- Create: Storybook-free visual spec `e2e/ui-kit.spec.ts` that renders every primitive in every variant on a hidden route and screenshots them

**Rules the kit enforces (from `docs/design.md`):**
- Primary button: `#5645d4` background, white text, 8px radius, `10px 18px` padding, pressed `#4534b3`, disabled hairline background with muted text.
- Card: 12px radius, hairline border, light shadow, white surface.
- No pill buttons except explicitly tagged `shape="pill"` for filter chips.
- Focus ring visible on every interactive primitive.

- [ ] Build the primitives on Radix with `class-variance-authority`, sourcing every color, radius, and spacing from CSS variables in `src/app/styles/tokens.css`.
- [ ] Codemod imports from both old locations; remove the duplicates.
- [ ] Add an ESLint restriction that forbids importing `radix-ui` outside `src/components/ui/`.

### Task 1.6: Split `styles.css` into layers

**Files:**
- Create: `src/app/styles/tokens.css`, `base.css`, `primitives.css`, `layout.css`
- Create: `src/features/<feature>/<feature>.css` per feature for feature-scoped rules
- Modify: `src/app/styles.css` becomes an `@import` list using `@layer tokens, base, primitives, layout, features`
- Modify: `src/app/styles.spec.ts`

- [ ] Move rules file by file, using cascade layers so specificity no longer needs `!important`. Target zero `!important` outside `base.css` print rules.
- [ ] Keep the existing `styles.spec.ts` assertions passing, and add one that fails if any feature CSS file defines a raw hex color instead of a token.
- [ ] Run the desktop e2e set and check in the Electron client that editor scroll and layout are unchanged.

### Task 1.7: Editor commands and shortcut registry

**Files:**
- Split: `src/features/document/editor/editor/commands.ts` into `commands/inline.ts`, `commands/blocks.ts`, `commands/lists.ts`, `commands/headings.ts`, `commands/tables.ts`, `commands/links.ts`, `commands/footnotes.ts`, `commands/frontmatter.ts`, `commands/transform.ts`, `commands/navigation.ts`
- Create: `src/features/document/editor/editor/commands/registry.ts`
- Create: `src/lib/shortcuts/registry.ts` and `src/lib/shortcuts/useShortcut.ts`
- Modify: `src/features/document/editor/editor/DocumentCommandPalette.tsx`

**Interfaces:**
- `CommandDescriptor { id, titleKey, group, run, when?, shortcut? }`.
- `registerShortcut(scope, combo, commandId)`; scopes are `global`, `editor`, `table`, `whiteboard`, `agent`. One `ShortcutsDialog` lists them.

- [x] Delete declarations with no references anywhere (31 found by transitive AST analysis, done 2026-09-27). Add `knip` so the check is repeatable.
- [ ] Review the 1,083 palette-registered commands as a product surface. Keep commands that map to a documented editor capability; move template insertions (`insert*Template`, `insert*Dashboard`, `insert*Mermaid*`) into the template library as data instead of code; delete one-off text transforms that no documentation or test describes. Target under 200 registered commands.
- [ ] Group the remaining commands by domain file; each command gains a descriptor with an i18n title key. The palette renders from the registry instead of a hand-maintained list.
- [~] Replace the 55 ad-hoc `metaKey` and `ctrlKey` checks with `useShortcut`, one file per pull request, starting with `WorkspaceScreen.tsx` and `Shell.tsx`. (2026-09-28: `src/lib/shortcuts.ts` parses `Mod+Shift+F` combos and matches events with exact modifiers, with specs; `src/lib/useShortcut.ts` binds one combo to a window keydown. `Shell.tsx` (search, command palette, vault launcher) and `useWorkspaceTabControllers` (close tab, the former `WorkspaceScreen` handler) use it. The remaining checks are inside editors and canvases, where they handle drag, selection, and cell editing rather than app shortcuts; review them file by file.)
- [~] Add `e2e/shortcuts.spec.ts` covering palette open, save, new document, toggle sidebar, and toggle agent panel. (2026-09-28: the file exists and covers Cmd/Ctrl+W closing the active tab while ignoring extra modifiers; the two palettes are covered in `app-shell.spec.ts`. Save, new document, sidebar, and agent panel have no app-level shortcut yet; add them with the registry work above.)

### Task 1.8: Split desktop services and the Electron main process

**Files:**
- Split: `src/services/desktop.ts` into `src/services/desktop/runtime.ts`, `browserSession.ts`, `bootstrap.ts`, `files.ts`, `window.ts`, `export.ts`, `index.ts`
- Split: `electron/main.mjs` into `electron/ipc/browser-session.mjs`, `electron/ipc/files.mjs`, `electron/ipc/export.mjs`, `electron/ipc/window.mjs`, `electron/ipc/updates.mjs`, each exporting `register(ipcMain, context)`
- Create: `electron/ipc/index.spec.ts` asserting every channel in `electron/channels.mjs` has exactly one handler
- Modify: `electron/preload.cjs` to expose a typed surface generated from `channels.mjs`

- [ ] Move handlers group by group with the existing specs green after each move.
- [ ] Add a preload type file `src/types/desktopBridge.d.ts` so renderer calls are typed end to end.

---

## 7. Phase 2: Runtime hardening (contract-facing tasks only)

Private implementation detail lives in the runtime plan. These tasks are the public halves.

### Task 2.1: Loopback session token contract

**Files:**
- Create: `contracts/runtime/local-session.schema.json`
- Modify: `contracts/runtime/runtime-info.schema.json`
- Modify: `electron/backend-supervisor.mjs`, `electron/local-runtime.mjs`
- Modify: `src/api/request.ts`
- Modify: `src/test/` mock runtime

- [ ] Define the contract: Electron generates a random token per launch, passes it through an environment variable to the runtime, and the client sends it as a bearer header. `runtime-info` reports `auth: "local-token"`.
- [ ] Implement the Electron and client halves behind a capability flag so an older runtime still works.
- [ ] Add a black-box e2e that a request without the token is rejected once the runtime reports the capability.

### Task 2.2: Single table listing contract

**Files:**
- Modify: `contracts/runtime/workspace-storage.schema.json`
- Modify: `src/api/dataDocuments.ts`

- [ ] Specify one endpoint that lists every table container under a workspace root from the file system, with the runtime index as a cache rather than a source of truth.
- [ ] Remove the client-side registration workaround after the runtime ships it.

---

## 8. Phase 3: Product UI and UX

### Task 3.1: Resolve the theme decision (D1)

- [ ] If light default: remove `migrateThemeToDarkDefault`, set `theme: 'light'` in defaults, keep dark as an option, recapture README assets with `pnpm capture:readme:assets`.
- [ ] If dark default: update `docs/design.md` and `AGENTS.md` to describe a dark product default and light option, and define dark tokens for every color in the design system.
- [ ] Either way: `styles.spec.ts` asserts every token has both light and dark values.

### Task 3.2: Workspace chrome polish against `docs/design.md`

**Files:**
- Modify: `src/features/workspace/components/WorkspaceSidebar.tsx`, `WorkspaceTree.tsx`, `WorkspaceTabStrip.tsx`, `WorkspaceTopbar.tsx`
- Modify: `src/features/agent/components/AgentChatPanel.tsx`
- Modify: `src/components/KitionLogoMark.tsx`

- [ ] Fix the broken agent empty-state logo: inline the SVG mark instead of an `img` with a public URL that is not resolvable in packaged builds. Add a desktop e2e that the mark renders.
- [ ] Sidebar: sections for documents, tables, whiteboards, workflows, with counts, a consistent 8px row rhythm, and an empty state with a create action per section.
- [ ] Tab strip: equal padding, close affordance on hover, pinned indicator, overflow menu. Compare against the geometry rules in `docs/design.md`.
- [ ] Agent panel: prompt suggestions as secondary buttons with 8px radius, model selector as a standard select, context chips using the badge primitive.
- [ ] Verify every change in the Electron client on macOS and record screenshots in the pull request.

### Task 3.3: Loading, empty, and error states

- [x] `src/components/states.tsx` (2026-09-28): `Skeleton` and `SkeletonRows` (a labelled status region), `EmptyState` (icon, title, description, one action slot), and `InlineError` (role alert, three sizes, optional retry button), with specs.
- [~] Every query-backed pane uses them. (2026-09-28: the vault launcher's raw loading text became skeleton rows, the translation card's loading rows use `Skeleton`, and the eleven hand-written destructive error boxes across the workflow launcher, index page, home page, drawer panels, and banners are `InlineError`. `scripts/check-i18n.py` now fails on `Loading...` or `Loading…` inside a `.tsx` under `src/`; the ESLint `no-restricted-syntax` block stays at warn level because 87 hex-color warnings already live there and `pnpm lint` runs with `--quiet`. Remaining: the empty states in the workspace, Agent, and workflow features still render their own markup and should move onto `EmptyState`.)

### Task 3.4: i18n completeness gate

**Files:**
- Modify: `scripts/check-i18n.py`

- [ ] Extend the script to fail when any locale lacks a key present in `en-US`, and when `.tsx` files contain raw sentence-case text nodes or raw `aria-label` strings outside an allowlist.
- [ ] Fill the 302 missing keys per locale; fix the 53 raw strings and 33 raw labels.

### Task 3.5: Accessibility pass

- [ ] Replace the 6 clickable `div` elements with buttons.
- [ ] Ensure every dialog, drawer, and sheet traps focus and restores it on close (test with Playwright keyboard navigation).
- [ ] Add `prefers-reduced-motion` handling to every animated transition in the kit.

---

## 9. Phase 4: Console

See the console plan. Client-facing dependency: the shared web design package ships tokens that match `src/app/styles/tokens.css`, so the website and the product look like one brand.

---

## 10. Phase 5: Delivery

### Task 5.1: Bundle diet

- [~] Lazy-load `cytoscape`, `docx`, `katex`, `mermaid`, and `recharts` at the feature boundary; assert in `scripts/check-performance-budget.mjs` that the initial JS is under 900 KB decoded and CSS under 250 KB. (2026-09-28: those five already load in their own chunks. A sourcemap build attributed the startup chunk instead: the Markdown parser reached it through the Agent turn context's image insertion resolver, which is now loaded with the editor chunk through `loadMarkdownImageInsertionResolver` in the document public entry. Startup JS went from 1.51 MB to 1.40 MB decoded, 0.46 MB to 0.43 MB gzip; the budget ratchets to 1.5 MB / 480 KB. Second pass the same day: the design document library (its serializer uses zod) and board file creation now load on first use through `loadDesignLib` and `loadBoardFile` in their feature public entries; the zod schemas for per-field AI config moved to `types/aiConfigSchemas.ts` so the startup path only imports the zod-free helpers; a dead `getAIConfigSchemaForField` was deleted. Startup JS is 1.32 MB decoded / 0.41 MB gzip. On the way, the filter tree types moved into `src/types/tableFilter.ts` and the table shared library stopped importing the filter barrel, which broke the type-layer cycle through the filter components and retired 17 more baselined violations. Still in the startup chunk: `axios`, `tailwind-merge`, and the workspace screen itself. CSS is 0.37 MB and waits on Task 1.6.)
- [x] `DndProvider` is gone from `main.tsx`: nothing used `react-dnd` (the table grid has its own drag hook), so the two packages and their `dnd-core` and `redux` dependencies are removed and the third-party notices regenerated.

### Task 5.2: Release verification

- [ ] `pnpm run check` runs `knip`, dependency-cruiser, blank-comment check, and i18n completeness.
- [ ] The Stop hook keeps `pnpm test:table:e2e`, and `prepare-release.yml` runs the full nightly suite before tagging.

---

## 11. Sequencing and estimates

Estimates are engineer-weeks of focused work, assuming one engineer per repository in parallel.

| Phase | Client | Runtime | Console |
| --- | --- | --- | --- |
| 0 | 1.5 | 0.5 | 0.5 |
| 1 | 6 | 0 | 0 |
| 2 | 1 | 4 | 0 |
| 3 | 3 | 0 | 0 |
| 4 | 0 | 0 | 3 |
| 5 | 1 | 0.5 | 0.5 |

Recommended start order: 0.1, 0.2, 0.3 in the first week. Then 1.1 and 1.2 together, because every later client task consumes the typed API and the query layer. Task 1.4 must not start before 1.3 lands.

## 12. Definition of done for the program

- No source file in `src/` or `electron/` exceeds the Phase 0 ceilings without a baseline entry, and the baseline is empty.
- `knip` reports zero unused exports and dependencies.
- dependency-cruiser reports zero cross-feature cycles.
- Every `contracts/runtime` schema has a generated type and a mock fixture.
- CI runs every e2e spec file at least nightly.
- The product screenshots in `docs/readme/` match `docs/design.md`.
