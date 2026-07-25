# Kition Workspace Rules

> The product name is **Kition** (kition.ai). Never introduce any historical
> product name, slug, package name, module name, app ID, environment prefix,
> database name, or dotfile directory into code or documentation. The canonical
> identity contract lives in `openspec/specs/branding/`.

## English-Only Repository (Mandatory)

- Every tracked filename and every tracked text file must use English for
  documentation, UI copy, examples, fixtures, tests, comments, commit-facing
  templates, and generated reports.
- Translate user-facing content into natural English. Never hide non-English
  prose behind Unicode escape sequences.
- Multilingual document parsing may use Unicode Script properties or clearly
  named `String.fromCodePoint(...)` constants when the behavior is required.
- Run `python3 scripts/check-i18n.py` before completion. The command must exit 0.

## Host Privacy And Portable Paths (Mandatory)

- Never write a real local username, home directory, workspace absolute path,
  or any other host-identifying information into a Git-tracked file. This
  includes docs, Markdown links, comments, configuration, scripts, log samples,
  reports, and generated output.
- Repository docs and Markdown links must use repository-relative paths.
  Command examples must use portable placeholders such as `$HOME`,
  `$REPO_ROOT`, `<repo-root>`, or `<workspace>`.
- Scripts must discover the repository at runtime from their own location,
  `git rev-parse --show-toplevel`, or an explicit environment variable. Never
  hardcode `/Users/<name>/...`, `/home/<name>/...`, or
  `C:\\Users\\<name>\\...`.
- Do not copy temporary local links from an AI response into repository docs.
  Check tracked changes for accidental host paths before committing.
- Path-handling tests may use clearly fictional fixtures such as
  `/Users/alice/...` or `/home/test-user/...`. Test data must never use a real
  username.

## Task Completion Gate (Mandatory E2E Check)

Before any AI agent declares a task complete, it must run:

```bash
pnpm test:table:e2e
```

The exit code must be 0. Fix failures before reporting completion.

- Claude Code enforces this through the `Stop` hook in
  `.claude/settings.local.json`, which calls `scripts/post-task-e2e.sh`.
- Emergency Claude-only bypass for the current session:
  `export KITION_SKIP_E2E_HOOK=1`.
- Codex has no blocking Stop hook and must run the command manually.

The inspection implementation is `scripts/inspect-table-widget.sh`. It
covers the three GFM table widget row and column button regressions.

## UI Source Of Truth

- Read `docs/design.md` before any frontend, CSS, layout, component, or visual
  review task.
- Treat `docs/design.md` as the design source of truth, not loose inspiration.
- If the current UI conflicts with `docs/design.md`, move the UI toward the
  document.

## Required Design Rules

- Primary CTA uses the project purple `#5645d4`.
- Default product surfaces stay white or light neutral.
- Standard buttons use an 8px radius.
- Standard cards use a 12px radius.
- Do not turn ordinary product buttons into pills.
- Use restrained borders and light shadows on normal product cards.
- Avoid unrelated dark-console, neon, or blue-heavy themes unless the design
  specification explicitly calls for them.

## Implementation Approach

- Push design fixes into shared tokens and shared primitives before page-local
  overrides.
- Prefer shared styles in `src/app/styles.css` and shared controls in
  `src/components/ui.tsx` when possible.
- When reviewing screenshots, compare geometry, palette, hierarchy, and control
  emphasis against `docs/design.md`.

## Closed Runtime Boundary (Mandatory)

- This repository contains only the React/Electron client, public contracts,
  mocks, fixtures, and black-box tests.
- Go runtime source, internal tests, implementation design, and private OpenSpec
  changes belong only in the private `KitionAI/kition-runtime` repository.
- Never recreate `api/`, a root `config/`, a Go module, `go run`, `go build`, or
  any runtime source fallback in this repository.
- Client development uses `pnpm dev`. Private integration uses
  `KITION_API_BINARY=<runtime-binary> pnpm dev`.
- Packaging may use only a verified Release asset, an explicit runtime binary,
  or the pinned verified runtime cache.
- The client may depend only on `contracts/runtime/`, HTTP behavior, and
  capability flags. Never copy private implementation details into code,
  comments, tests, or docs.
- For cross-repository runtime behavior changes, update the public contract and
  client mock first, then implement the private runtime and validate it as a
  black box with a local binary.
