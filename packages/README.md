# Packages

Source packages that Kition builds from `src/` and that run outside Kition too.

| Package | Directory | What it is |
| --- | --- | --- |
| `@kition/app-ui` | `packages/app-ui/` | Shared UI primitives: the `src/index.tsx` controls (Button, Card, Input, Select, Disclosure, …), the shadcn-style `button`, `command`, `dialog`, `input`, `popover`, `spinner`, `switch`, `tooltip`, `confirm`, `RightSheet`, their hooks, and `cn` (`utils`). |
| `@kition/table-editor` | `packages/table-editor/` | The table and dashboard editor, behind `TableDataSource` and `TableHost`. |
| `@kition/document-editor` | `packages/document-editor/` | The Markdown document: its model on the Kit Data Model and its CodeMirror editor, behind `DocumentHost`. |

## How Kition uses them

- They are not installed. Kition resolves them by path alias, in `tsconfig.json` (`paths`),
  `tooling/vite.config.ts`, and `tooling/vitest.config.ts`, and their npm dependencies (React,
  react-i18next, Radix, lucide-react, CodeMirror, recharts, …) come from Kition's root
  `package.json`. Each `package.json` here names the package and its entries only.
- `tooling/tailwind.config.ts` scans `packages/*/src`, `tsc`, ESLint, knip, dependency-cruiser,
  `scripts/check-i18n.py`, and Vitest (`packages/*/src/**/*.spec.ts(x)`) cover them like `src/`.
- Packages import nothing from `src/` (dependency-cruiser rule
  `packages-import-nothing-from-the-app`) but the Kit Data Model, which they import as
  `@kition/kdm`: Kition resolves it to its copy in `src/lib/kdm/` (`scripts/sync-kit-host.mjs`), a
  kit's build to kition-sdk's `packages/kdm`. `@kition/app-ui` imports no other package.

## `@kition/table-editor`

Entries (the app imports only these; rule `app-uses-table-editor-entries`):

- `@kition/table-editor`: the table document types, `TableDataSource` and `TableHost` with their
  providers and hooks, and helpers the app shares with the editor (CSV analysis, table actions,
  dashboard creation and metadata, timestamps). It loads no editor UI.
- `@kition/table-editor/TableEditor`, `/DashboardEditor`, `/TableFileImportDialog`.

The editor's root needs a `TableDataSourceProvider` and an `@kition/app-ui/confirm`
`ConfirmProvider`, and may have a `TableHostProvider`; every `TableHost` member is optional, and a
missing one hides what needs it. Kition's implementations
and providers are in `src/features/table/host/` (`KitionTableProviders`). The runtime contract
types the editor uses are generated into `src/generated/` by `pnpm run contracts:generate` and
checked by `pnpm run check:contracts`.

### Strings

The editor translates with react-i18next, almost entirely in the `table` namespace. Its strings
stay in Kition's `src/i18n/locales/<locale>/table.json` (the repository's localization rule). The
host provides the i18next instance: Kition registers its own globally (`src/i18n`,
`initReactI18next`); another host wraps the editor in `<I18nextProvider i18n={...}>` with the
`table` namespace loaded from those files. A few shared labels come from the `common` namespace
(`actions.cancel`, `actions.save`, `actions.close`, `actions.confirm`, `actions.showPassword`,
`actions.hidePassword`, `dialogs.rightSheet`, used by the editor and `@kition/app-ui`), so a host
loads those keys too. Dates format in `TableHost.locale()`, or the i18next instance's language.

### Styles

The packages ship no stylesheet; they use the host's. The editor needs:

- Tailwind with Kition's theme tokens (`tooling/tailwind.config.ts`, the CSS variables in
  `src/app/styles.css`) and `packages/*/src` in its content paths.
- The `.data-*` component classes (grid, toolbar, record drawer, field configuration, dashboards)
  in `src/app/styles.css`.
- `react-grid-layout` and `react-resizable` CSS, which the dashboard editor imports itself.

A host outside Kition builds these from Kition's checkout until the editor's classes move into a
package stylesheet. Visual rules follow `docs/design.md`.

## `@kition/document-editor`

Entries (the app imports only these; rule `app-uses-document-editor-entries`):

- `@kition/document-editor`: `DocumentHost` and `setDocumentHost`, the agent action types, pasted
  and dropped images (kept through the host) and their failures, and the Markdown parsers the app
  shares with the editor (wikilinks, tags, frontmatter). It loads neither the KDM nor the editor.
- `@kition/document-editor/model`: the document on the KDM: `documentSchema` (`kit.document`), the
  file text as the replica keeps it (`analyzeText`, `renderText`, `createDocumentReplica`), text
  merges, the CodeMirror binding of the replica's text (`TextBinding`), its undo and redo, and text
  sources on a replica (`replicaTextSource`, `createReplicaTextSource`).
- `@kition/document-editor/file`: a Markdown file's bytes as a replica and back
  (`importMarkdownFile`, `openStoredMarkdownFile`, `exportMarkdownFile`), with the schema, text,
  and merges, but no CodeMirror: what the Document kit's engine runs in its worker.
- `@kition/document-editor/editor`: `DocumentEditor` (CodeMirror with live preview and widgets) over
  a `DocumentTextSource`, its extensions, and `useDocumentBinding`; `/commands` its commands;
  `/clipboard` its clipboard reading; `/markdown` and `/mermaid` Markdown rendered to HTML.

The editor's CodeMirror extensions run outside React, so the page sets its `DocumentHost` once
(`setDocumentHost`) before an editor mounts; every member is optional, and a missing one hides or
skips what needs it (pasted images stay links without `images`, Copy image needs `copyImage`, images
show only self-contained URLs without `resolveImageURL`). Kition's host is
`src/features/document/host/kitionDocumentHost.ts`, installed in `src/main.tsx`; the document
session (file binding, store, history, agent review, comments) and the panes, dialogs, and panels
around the editor stay in `src/features/document`. Its strings are Kition's `document` namespace,
which the editor reads through the global i18next instance, and its styles Kition's. The Document kit (`packages/document-kit`) is this model and editor packaged as a standard kit.
