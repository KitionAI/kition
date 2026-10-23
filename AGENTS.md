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
pnpm test:ktable:e2e
```

The exit code of both must be 0. Fix failures before reporting completion.

- Claude Code enforces both through the `Stop` hook in
  `.claude/settings.local.json`, which calls `scripts/post-task-e2e.sh` and
  runs each gate in turn.
- Emergency Claude-only bypass for the current session:
  `export KITION_SKIP_E2E_HOOK=1`.
- Codex has no blocking Stop hook and must run both commands manually.

The first gate is `scripts/inspect-table-widget.sh`. It covers the three GFM
table widget row and column button regressions.

The second gate is `scripts/inspect-ktable.sh`, which runs
`e2e/table-kit.spec.ts`: the Table kit's pinned package in `KitFrame` (create,
edit and save, host writes through the kit, `host/generate`, `host/action`). It
fails, never skips, when `public/kits/table-ui/` is missing. The table editor's
own interaction tests live in the kition-table repository and run there.

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
  `packages/app-ui/src/index.tsx` when possible.
- When reviewing screenshots, compare geometry, palette, hierarchy, and control
  emphasis against `docs/design.md`.

## Kits (Mandatory)

- Read `docs/kit-sdk.md` before any kit work. It is how Kition implements the
  Kit Harness Protocol (KHP, `spec/` in the private `KitionAI/kit-standard`
  repository) and the Kition kit platform (`docs/platform/` in the private
  `KitionAI/kition-sdk` repository), which are normative: kits, the host, and
  the agent conform to them, and contract changes go there first. The
  checklist in `docs/kit-sdk.md` is the definition of done for a new kit, and
  every kit ships a `kit.json` that declares its KHP version (`"khp": "1.0"`)
  and passes kition-sdk's `tools/check-manifest.mjs`.
- Kition is KHP's reference implementation, and its agent targets
  DeepSeek Harness contracts (tool definitions, session event log, SDK
  protocol) by contract, not by embedding another runtime.
- Kit editors run in the page: the kit's engine is compiled to WebAssembly
  and runs in a Web Worker, and the kit draws its own editor (its repository's
  `web/` on kition-sdk's `@kition/kit-ui`), which Kition shows in an iframe
  over the Kit UI protocol (`KitFrame`). Never embed a kit's native window over
  a tab, and never build kit editors inside Kition; both were tried and
  removed. Native kit executables run only `headless`, for the agent.
- A kit's package (`public/kits/<kit>-ui/`: editor, engine, fonts) must stay
  self-contained (platform rule UI-K1) so other applications can embed it. Kition
  ships every kit's package inside the app, as published by
  `scripts/publish-kit.sh` on a developer machine and pinned in
  `kits/kits.lock.json`. Never add builds or workflows to the private kit
  repositories' CI; their Actions minutes are limited. Register a kit in
  `src/features/workspace/components/kits/kitEditors.ts` and
  `kits/sdks.json`; see `docs/kit-sdk.md`.
- If the upstream app draws something in its own UI, port it into the kit's
  SDK crate as engine overlays or into the kit's editor, never into Kition.
- `src/features/kits/sdk/` loads a kit's engine in the page (Kition makes new
  files with it): it must never import the rest of Kition (`pnpm check:deps`
  enforces it). Shared strings under `workspace:kitEditor.*` must never name a
  kit.
- A kit SDK implements `KitDocument` from the private `KitionAI/kition-sdk`
  crate (Apache-2.0), exports it with `export_kit_document!`, and passes
  `kition_sdk::testing::check_contract` in its tests and `pnpm check:kit-sdks`
  once built. Contract changes happen in kition-sdk and bump the version there
  and in `src/features/kits/sdk/kitSdk.ts` together.
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
