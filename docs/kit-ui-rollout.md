# Kit UI Rollout: Every Kit Draws Its Own Editor

Status record, 2026-10-12; updated 2026-10-15 when Kition's own kit editors
were removed. See `docs/kit-sdk.md` section 4 for how it works.

## Decision

- Each kit implements its full editor in React inside its own repository
  (`web/`), on the shared library `@kition/kit-editor` in kition-sdk, matching
  the original application's UI.
- Kition is the shell, the platform, and the standard: files, tabs, the
  agent, theme, language, and the kit registry. It shows a kit's editor in
  an iframe over the Kit UI protocol (`kition-kit-ui/1`), so kits can also
  be embedded by other hosts.
- kition-sdk, the ten kit repositories' own code, and Kition are licensed
  Apache-2.0.
- The kit repositories are named `KitionAI/kition-<kit>` (`kition-doc`,
  `kition-pdf`, …) and are checked out next to Kition as `../kition-<kit>`.
- Chinese text in the web editors uses Droid Sans Fallback (Apache-2.0) from
  `KitionAI/kition-fonts`, checked out as `../kition-fonts`, handed to each
  engine's `addFont`. Noto CJK is Source Han renamed; the kits' asset
  rules forbid it, so no kit ships it. PDF also substitutes the face for
  Chinese fonts a PDF names but does not embed.

## Where Things Are

| Piece | Location |
| --- | --- |
| Standard 1.1, UI protocol | kition-sdk `docs/platform/kits/ui.md`, kition-sdk `docs/platform/reference/ui-protocol.md` |
| Shared editor library | kition-sdk `packages/kit-editor` (`EditorFrame`, `catalogTabs`, `commandMenuTabs`, `ToolRail`, `PanelSection`, `KitDocumentCanvas`, phrases, dialogs) |
| Host side of the protocol | kition-sdk `packages/kit-host`; Kition's copy in `src/features/kits/host/` (`pnpm check:kit-host`) |
| Development host | kition-sdk `packages/kit-dev-host` (each kit's `web/dev.html`) |
| Scaffold, command listing | kition-sdk `tools/new-kit-ui.mjs`, `tools/kit-commands.mjs` |
| Kition frame | `src/features/kits/kition/KitFrame.tsx`, `pickWorkspaceFile.ts` |
| Registration | `src/features/workspace/components/kits/kitEditors.ts` |
| Build | `make kit-uis` or `make kit-ui-<kit>` into `public/kits/<kit>-ui/` |
| Tests | `e2e/<kit>-embedded.spec.ts`, `e2e/helpers/embeddedKit.ts`, `e2e/kit-bridge.spec.ts` |

## The Kits

| Kit | Shell | Highlights |
| --- | --- | --- |
| Slide | Ribbon | Pilot; thumbnails, notes, slide show |
| Doc | Ribbon | Styles gallery, find and replace, contextual tabs, Chinese face |
| Sheet | Ribbon | Formula bar, sheet tabs, clipboard; grid draws conditional formats, wrapped text, charts; headings and frozen panes stay in view (Standard E10 pinned bands) |
| PDF | Ribbon | Page tools, thumbnails, bookmarks, comments, form fields, find; Chinese fonts a PDF does not embed |
| CAD | Ribbon | Engine tools, layers palette, command line, drafting modes |
| Photo | Menu bar | Ported canvas tools, options bar, layers, CJK type |
| Vector | Menu bar | Tool flyouts, Transform, Appearance, Align, Pathfinder, Layers, Swatches |
| Design | Menu bar | Pages, Layers, Swatches, Styles; glyph fallback for new documents |
| Effect | Menu bar | Timeline, transport, Transform keyframes, MP4 render |
| Film | Menu bar | Track timeline, playback with sound, media through `host/pick`, stepped MP4 export |

Every kit keeps its editor flow test in its repository: `pnpm test:flow` in
`web/` (or `node tests/flow.mjs webkit`) drives the development host in
Chromium or WebKit; all ten pass in both. In Kition each kit also has its
embedded spec, run in both browsers.

## Known Gaps

- Kition's `host/pick` copies the chosen file next to the document, which is
  wasteful for large media.
- The full kit e2e is flaky under heavy machine load; two workers are stable.

## Next Steps

1. Try every kit in the desktop app (WKWebView) and compare with the original apps.
2. Close the gaps above.

`pnpm run check`, `python3 scripts/check-i18n.py`, `pnpm test:table:e2e`,
`pnpm test:kitable:e2e`, and `make kit-e2e-webkit` passed on 2026-10-12.
