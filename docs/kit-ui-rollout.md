# Kit UI Rollout: Every Kit Draws Its Own Editor

Status record, 2026-10-12. See `docs/kit-sdk.md` section 4a for how it works.

## Decision

- Each kit implements its full editor in React inside its own repository
  (`web/`), on the shared library `@kition/kit-ui` in kition-sdk, matching
  the original application's UI.
- Kition is the shell, the platform, and the standard: files, tabs, the
  agent, theme, language, and the kit registry. It shows a kit's editor in
  an iframe over the Kit UI protocol (`kition-kit-ui/1`), so kits can also
  be embedded by other hosts.
- kition-sdk, the ten kit repositories' own code, and Kition are licensed
  Apache-2.0.

## Where Things Are

| Piece | Location |
| --- | --- |
| Standard 1.1, UI protocol | kition-sdk `docs/standard.md`, `docs/ui-protocol.md` |
| Shared editor library | kition-sdk `packages/kit-ui` (`KitShell`, `KitAppShell`, `CommandMenuBar`, `ToolRail`, `PanelSection`, `KitDocumentCanvas`, phrases, dialogs) |
| Host side of the protocol | kition-sdk `packages/kit-host`; Kition's copy in `src/features/kits/host/` (`pnpm check:kit-host`) |
| Development host | kition-sdk `packages/kit-dev-host` (each kit's `web/dev.html`) |
| Scaffold, command listing | kition-sdk `tools/new-kit-ui.mjs`, `tools/kit-commands.mjs` |
| Kition frame | `src/features/kits/kition/KitFrame.tsx`, `pickWorkspaceFile.ts` |
| Registration | `src/features/workspace/components/kits/kitEditors.ts` (`embedded`) |
| Build | `make kit-uis` or `make kit-ui-<kit>` into `public/kits/<kit>-ui/` |
| Tests | `e2e/<kit>-embedded.spec.ts`, `e2e/helpers/embeddedKit.ts`, `e2e/kit-bridge.spec.ts` (both editors) |

## The Kits

| Kit | Shell | Highlights |
| --- | --- | --- |
| Presentation | Ribbon | Pilot; thumbnails, notes, slide show |
| Word | Ribbon | Styles gallery, find and replace, contextual tabs, CJK font |
| Sheet | Ribbon | Formula bar, sheet tabs, clipboard; grid draws conditional formats, wrapped text, charts |
| PDF | Ribbon | Page tools, thumbnails, bookmarks, comments, form fields, find |
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

- Sheet: frozen panes do not freeze on the single canvas.
- PDF: fonts a PDF names but does not embed (common in Chinese PDFs) are not
  substituted with a CJK face.
- Kition's `host/pick` copies the chosen file next to the document, which is
  wasteful for large media.
- `desktop-photo-kit.spec.ts` "imports a PSD dropped from the OS" fails in
  WebKit, also without these changes; the WebKit gate does not run that spec.
- The full kit e2e is flaky under heavy machine load; two workers are stable.

## Next Steps

1. Try every kit in the desktop app (WKWebView) and compare with the original apps.
2. Close the gaps above.

`pnpm run check`, `python3 scripts/check-i18n.py`, `pnpm test:table:e2e`,
and `make kit-e2e-webkit` passed on 2026-10-12.
