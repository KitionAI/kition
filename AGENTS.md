# Kition Workspace Rules

> The product name is **Kition** (kition.ai). Never introduce any historical
> product name, slug, package name, module name, app ID, environment prefix,
> database name, or dotfile directory into code or documentation. The canonical
> identity contract lives in `openspec/specs/branding/`.

## English-First Repository And Localization Boundaries (Mandatory)

- English remains mandatory for filenames, source code, comments, examples,
  fixtures, tests, commit-facing templates, generated reports, and general
  documentation.
- Approved localized content is limited to `src/i18n/locales/<locale>/`, the
  runtime message catalogs in `crates/kition-core/locales/<locale>.json`, root
  `README.<locale>.md` files, and the language switcher in `README.md`.
- Keep localized prose inside those approved files. Never hide non-English
  prose behind Unicode escape sequences.
- Localized filenames must remain portable ASCII locale identifiers, such as
  `README.zh-CN.md` or `src/i18n/locales/zh-CN/settings.json`.
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

## Kits (Mandatory)

- Read `docs/kit-sdk.md` before any kit work. It is the source of truth for
  how a kit appears in Kition, and its checklist is the definition of done
  for a new kit.
- Kit editors run in the page: the kit's engine is compiled to WebAssembly,
  runs in a Web Worker, and paints into a canvas, while Kition draws all
  chrome. Never embed a kit's native window over a tab; that was tried and
  rejected. Native kit executables run only `headless`, for the agent.
- Build every kit editor on `src/features/kits/public.ts` (`useKitDocument`,
  `KitCanvas` with `KitTool`s, `useKitEditor`, `KitEditorFrame`) and register
  it in `src/features/workspace/components/kits/kitEditors.ts` and
  `kits/sdks.json`. Put shared behavior in the template, not in one kit.
- `src/features/kits/sdk/` is the portable core of the open Kit SDK: it must
  never import the rest of Kition (`pnpm check:deps` enforces it). Shared
  strings under `workspace:kitEditor.*` must never name a kit.
- A kit SDK implements `KitDocument` from the `kition-kit-sdk` crate, exports
  it with `export_kit_document!`, and passes
  `kition_kit_sdk::testing::check_contract` in its tests and
  `pnpm check:kit-sdks` once built. Contract changes bump the version in both
  the Rust crate and `src/features/kits/sdk/kitSdk.ts`.
- Kit repositories are standalone clones (never GitHub forks). Log every
  upstream file change in their `KITION_CHANGES.md`.
- Never run a kit engine on the page's thread, never write a kit file except
  through `PUT /v1/kits/files`, and never overwrite unsaved edits when the
  file changes on disk.

## Repository Layout And Secrets (Mandatory)

- `src/` is the React renderer, `src-tauri/` the Tauri desktop shell, and
  `crates/` the Rust runtime (`kition-api` and its feature crates). They form
  one Cargo workspace; the shell runs the runtime in-process and the runtime
  serves its HTTP API on loopback only.
- The runtime is written in Rust. Never add Go code, a Go module, or a second
  runtime implementation.
- `contracts/runtime/` describes the HTTP API the renderer uses. Update the
  contract, the renderer mock, and the runtime together.
- Never commit secrets: signing keys and certificates, updater private keys,
  API keys, OAuth client secrets, portal tokens, or real passwords. They live
  only in CI secrets or on the developer's machine. Test fixtures use obviously
  fake values.
- The local API is unauthenticated, so it must only ever bind to
  `127.0.0.1` and reject requests whose `Host` is not loopback.
- Check Rust changes with `pnpm check:desktop` (format, clippy, and tests for
  the whole workspace).
