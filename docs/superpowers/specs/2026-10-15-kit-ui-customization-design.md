# Kit UI customization, theme presets, and kit brand colors

Date: 2026-10-15. Status: approved in discussion, awaiting spec review.

## Why

An audit of the Photo kit (kition-photo `web/`) found that its menu buttons
fail or silently do nothing, and that its editor is far from PhotoCraft's and
Photoshop's. The chosen direction is to keep each kit's editor in React on
`@kition/kit-ui` (option B), because a React editor lets a host re-skin it and
choose its menus, as WPS WebOffice's SDK does, and lets other products embed
the kits. This spec covers that customization layer, which every kit gets
from `@kition/kit-ui`. Fixing the Photo kit's dialogs and porting its panels
and tools are separate work that builds on it.

Goals:

1. A host can hide or disable any menu, command, tool, panel, ribbon tab or
   group, or document action, and add its own buttons (integrators).
2. A person can hide what they do not use, in the kit, and the host keeps it
   (Kition users).
3. Kition offers whole-application theme presets, and every kit follows the
   active one live.
4. Every kit has its own brand color, so each editor feels like its own
   application, as Word, Excel, and PowerPoint do.

Non-goals: reordering, renaming, or re-iconing a kit's own elements;
allowlists ("show only these"); per-kit theme presets; custom drop-down
buttons.

## Decisions

| Question | Decision |
| --- | --- |
| Who configures | Both integrators (code) and Kition users (UI); one config shape |
| Operations | Hide, disable, add host buttons |
| Hidden or disabled by the host | Refused on every path: menus, buttons, shortcuts, context menus, canvas tools, `ai/run` |
| Hidden by the person | Drawing only; shortcuts and the agent still run it |
| Host buttons | Button or menu item; click event; host can update disabled and pressed state |
| List style | Blocklist only; elements a kit adds later appear by default |
| Where people customize | A shared "Customize interface" dialog in the kit, saved by the host |
| Theme presets | Whole application, no per-kit override |
| Kit brand color | Declared by each kit, on by default, a host can turn it off |
| Architecture | Implemented once in `@kition/kit-ui` (rendering and enforcement) |

## Part 1: Kit UI protocol 1.2

This is an additive minor version of `kition-kit-ui/1`, specified in
kition-sdk's `docs/ui-protocol.md` (new section "UI configuration") and in
`packages/kit-protocol`. The protocol identifier stays `kition-kit-ui/1`.

### Element ids

Every element a person can see or press has an id `<kind>:<name>`:

| Kind | Example | Meaning |
| --- | --- | --- |
| `command:` | `command:filter.blur.gaussianBlur` | An engine command |
| `menu:` | `menu:Filter`, `menu:Filter/Blur` | A menu path, from the engine's English `menu` path joined with `/` |
| `tool:` | `tool:Brush` | A tool on the tool rail |
| `panel:` | `panel:layers` | A panel |
| `tab:` | `tab:insert` | A ribbon tab |
| `group:` | `group:insert/media` | A ribbon group, as `<tab>/<group>` |
| `action:` | `action:save`, `action:undo`, `action:redo`, `action:agent`, `action:more` | The document actions |
| `control:` | `control:colors` | Any other element a kit draws itself |

A pattern is an id, or an id ending in `*`, which matches every id with that
prefix (`command:file.export.*`). A `menu:` pattern also matches every menu
below it and every command in them. Ids are part of a kit's public interface:
renaming one is a breaking change, logged in the kit's change ledger.

### Configuration

`ui/initialize` gains an optional `ui` field, and the host sends the
`ui/configure` notification (`{ ui }`) to replace it while the editor is open:

```json
{
  "hide": ["command:file.export.*", "menu:Help", "panel:history"],
  "disable": ["action:save"],
  "add": [
    {
      "id": "submit",
      "place": "action",
      "label": { "en-US": "Submit", "zh-CN": "<localized label>" },
      "icon": "send",
      "shortcut": "Cmd+Enter",
      "disabled": false,
      "pressed": false
    }
  ],
  "personal": { "hide": ["menu:Filter/Video"] }
}
```

- `hide` and `disable` are the host's; `personal.hide` is the person's.
- `add[].place` is `menu:<path>` (end of that menu), `group:<tab>/<group>`
  (end of that ribbon group), or `action` (the document actions).
- `add[].icon` is a name from `@kition/kit-ui`'s icon set or a `data:` image
  URL, shown in an `<img>` so it cannot run script. Hosts serving kits must
  allow `img-src data:` in the kit package's content security policy.
- `add[].label` is a map of locales; the kit falls back to `en-US`, then the id.
- `add[].id` is the host's own name; it never collides with kit ids because
  kit ids always carry a kind prefix.

### Theme additions

`theme` gains `brand: "kit" | "host"`, default `"kit"` (Part 4).

### New methods

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `ui/configure` | host to kit, notification | `{ ui }` | |
| `ui/elements` | host to kit, request | `{}` | `[{ id, kind, label, parent, hidden, disabled }]` |
| `ui/action` | kit to host, notification | `{ id, document: { path, dirty, revision } }` | |
| `host/customize` | kit to host, request, capability `customize` | `{ personal: { hide } }` | `{}` |

The kit lists `ui-config` in its `ui/initialize` answer when it honors the
configuration. A host that relies on `hide` or `disable` for permissions MAY
refuse to show a kit that does not. The host lists `customize` in its
capabilities when it serves `host/customize`.

### Rules

- **UI-C1** A hidden element is not drawn. A menu, ribbon group, ribbon tab,
  or separator left with nothing visible is not drawn either.
- **UI-C2** A command the host hides or disables is refused on every path:
  menus, buttons, shortcuts, context menus, canvas tools, and `ai/run`
  (JSON-RPC `-32000`, `error.data.reason` `not-allowed`). `ai/commands` omits
  host-hidden commands and lists host-disabled ones with `enabled: false`.
  Hiding or disabling `action:save` also stops Cmd+S; the host's own
  `document/save` still works.
- **UI-C3** `personal.hide` changes drawing only. Host-hidden elements do not
  appear in the customize dialog.
- **UI-C4** Unknown ids and invalid entries are ignored one by one; the rest
  of the configuration applies, and `ui/initialize` never fails because of it.
- **UI-C5** The configuration is a blocklist: elements a kit adds later are
  shown unless a pattern covers them.
- **UI-C6** `ai/run` checks every step before it runs any; if one is refused,
  none run and the error names the refused command.

## Part 2: `@kition/kit-ui`

### Configuration logic

A new framework-free module, `uiConfig.ts`, parses a configuration (dropping
invalid entries with a console warning), matches patterns (prefix `*`, menu
inheritance), and answers, for an element id and, for a command, its menu
path: `hidden` (do not draw), `disabled` (draw greyed), and `denied` (refuse
to run; host configuration only).

### Where the configuration lives

The configuration belongs to the host connection returned by `connectHost()`:
its initial value comes from `ui/initialize`, `ui/configure` replaces it, and
the customize dialog changes `personal` locally and then sends
`host/customize`. `useKitSession` and every component read the same value.

Enforcement sits in exactly one place, `useKitSession`'s `run`. Menus,
buttons, shortcuts, canvas tools (kits call `session.run` directly), and
`ai/run` all go through it, so a denied command throws `not-allowed` there.
`ai/commands` filters in the same hook.

### Element catalog

The catalog is declared, not collected from what happens to be rendered,
because closed menus and inactive ribbon tabs are not mounted:

- commands and menus come from the engine's command list;
- tools, panels, ribbon tabs and groups, and a kit's own controls come from
  `defineKitUi({ tools, panels, tabs, groups, controls })`, each with an id
  and a label per locale.

In development builds a component that renders an undeclared id logs a
warning. `ui/elements` answers from this catalog.

### Shared components

| Component | Ids it honors |
| --- | --- |
| `CommandMenuBar`, `SubMenu`, `CommandItem`, `CommandButton`, `CommandTab` | `command:`, `menu:` |
| `Ribbon` | `tab:` |
| `RibbonGroup` (new `id` prop) | `group:` |
| `ToolRail`, `EngineToolRail`, tool letter keys | `tool:` |
| `PanelSection` (new `id` prop) | `panel:` |
| `DocumentActions` | `action:` |
| `KitElement` (new wrapper) | `control:` |

Host buttons are drawn by their containers: `CommandMenuBar` at the end of a
menu, `RibbonGroup` at the end of a group, `DocumentActions` in the actions.
A click sends `ui/action`. Kits write no code for them.

### Customize dialog

Shown only when the host has the `customize` capability:

- entry: a "Customize interface…" item in a new "More" menu in the document
  actions (`action:more`), in the same place in every kit; and "Hide" on the
  context menu of menu items, tools, and ribbon buttons;
- a checkbox tree: menus and their commands, tools, panels, ribbon tabs and
  their groups, document actions; with search and "Restore defaults";
- host-hidden elements are not listed;
- a failed `host/customize` keeps the change for the session and shows a
  notice that it was not saved.

### Development host

`@kition/kit-dev-host` gets a configuration panel: paste a JSON configuration
and send it live, log received `ui/action`s, switch theme presets, and keep
`host/customize` results in `localStorage`. It also exports
`checkUiIds(frame)` for flow tests: every interactive element (buttons, menu
items, tools) carries a declared id, and every declared id that should be
visible is found.

## Part 3: The ten kits

Photo, Vector, Design, Effect, and Film (menu-bar editors) and Slide, Word,
Sheet, PDF, and CAD (ribbon editors) each:

1. declare their elements with `defineKitUi`;
2. give `PanelSection` and `RibbonGroup` their ids;
3. wrap their own controls in `KitElement` (for example Photo's colors and
   options bar, Slide's notes pane, Sheet's formula bar and sheet tabs);
4. declare `ui.brand` in `kit.json` (Part 4);
5. add the configuration steps to `web/tests/flow.mjs` (Part 6);
6. are republished with `scripts/publish-kit.sh` and pinned in
   `kits/kits.lock.json`.

Photo goes first and proves the design; the other nine follow.

## Part 4: Kit brand colors

### Declaration

`kit.json` gains `ui.brand`, one color per scheme:

```json
"ui": { "entry": "index.html", "brand": { "light": "#2b5fd9", "dark": "#6b9bff" } }
```

kition-sdk's `tools/check-manifest.mjs` checks it: both values are `#rrggbb`;
`light` gives at least 4.5:1 with white text; `dark` gives at least 4.5:1 with
black text and at least 3:1 against the dark presets' surfaces.

### Effect in the kit

With `theme.brand` `"kit"`, `@kition/kit-ui` takes the brand color for the
current `colorScheme` and sets `--kit-primary`, derives `--kit-primary-soft`
(the color at low alpha), and picks `--kit-primary-text` (white or black, the
one with more contrast). It shows in the primary button (Save), the active
ribbon tab and menu, the active tool, focus rings, and a thin brand strip at
the left of the top bar. Surfaces stay white or neutral; the brand color is
never a full-width fill.

With `theme.brand` `"host"`, the host's `--kit-primary` tokens stand
(integrators who want their own color everywhere, and Kition's High Contrast
preset).

### Colors

| Kit | Light | Dark | Family |
| --- | --- | --- | --- |
| Word | `#2b5fd9` | `#6b9bff` | royal blue |
| Sheet | `#1c8649` | `#4cc47f` | green |
| Slide | `#c94b24` | `#ff8a5c` | orange red |
| PDF | `#d63636` | `#ff7070` | red |
| Photo | `#1879be` | `#5cb4ff` | sky blue |
| Vector | `#a56600` | `#ffb340` | amber |
| Design | `#d6336c` | `#ff6b9d` | rose |
| Effect | `#7c4ddb` | `#a98bff` | violet |
| Film | `#a63da8` | `#e07ae0` | plum |
| CAD | `#0e837a` | `#3cc9bd` | teal |

Every light value gives at least 4.6:1 with white text; every dark value gives
at least 7.7:1 with black text and at least 5:1 on the dark surfaces.

### Kition

A document tab's kit icon uses the kit's brand color for the active scheme.

## Part 5: Kition

### Design source of truth first

`docs/design.md` is updated before any code: it defines the four presets
below, and states that the purple primary CTA (`#5645d4`) applies to Kition's
own surfaces while a kit's primary CTA uses the kit's brand color.

### Theme presets

One source, `themePresets.ts`, defines each preset's Kition shell variables
(those in `src/app/styles.css`) and its Kit UI tokens:

| Preset | Scheme | Surface | Muted surface | Canvas | Text | Muted text | Border | Brand |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Light (default) | light | `#ffffff` | `#fafaf9` | `#f6f5f4` | `#1a1a1a` | `#5d5b54` | `#e5e3df` | kit |
| Dark | dark | `#1b1e23` | `#22262c` | `#15171b` | `#eceff1` | `#a9b0ba` | `#33373e` | kit |
| Dark Gray (`graphite`) | dark | `#323232` | `#2b2b2b` | `#252525` | `#e6e6e6` | `#a8a8a8` | `#454545` | kit |
| High Contrast | light | `#ffffff` | `#ffffff` | `#f0f0f0` | `#000000` | `#333333` | `#000000` | host (`#3a2bb8`) |

Light and Dark are today's `:root` and `.dark` values. Dark Gray is a neutral
mid-dark gray like Photoshop's, with no color cast, for judging image color;
its id is `graphite` and every locale names it plainly as a dark gray. Settings › Display
replaces Light, Dark, Auto with a preset picker plus "Follow system", which
switches between Light and Dark. There are no users to migrate: the old
`general.theme` values map directly (`light` to Light, `dark` to Dark, `auto`
to Follow system) with no compatibility code kept.

### Theme delivery fix

`KitFrame.tsx` today sends a hard-coded light theme and never sends
`ui/theme`, so kits stay light when Kition is dark (against UI-H6). It will
build the theme from the active preset and send `ui/theme` to every open kit
frame when the preset or the system scheme changes.

### Customization storage

- Kition sets no `hide`, `disable`, or `add` of its own; it sends only the
  person's `personal` configuration.
- It lists `customize` in its capabilities and handles `host/customize` in
  `KitFrame`, storing `personal.hide` per kit id in a new `kits` section of
  the desktop settings.
- Other open tabs of the same kit receive the change with `ui/configure`.
- Settings gains "Interface customization": each kit with how many elements
  the person hid, and "Restore defaults" per kit.

## Part 6: Errors and tests

Error handling is specified by UI-C2, UI-C4, UI-C6, the customize dialog's
failed-save notice, the icon and label fallbacks in Part 1, and the manifest
check in Part 4.

Tests:

- kition-sdk: unit tests for `uiConfig.ts` (prefix and menu matching, host
  and personal layers, invalid entries), for brand token derivation and
  contrast, and for `check-manifest.mjs`'s `brand` check.
- Each kit's `web/tests/flow.mjs`, in Chromium and WebKit: a hidden menu and
  a disabled command; the command's shortcut does nothing; `ai/run` is refused
  with `not-allowed` and runs no step; a host button sends `ui/action`; "Hide"
  from a context menu survives a reload; switching to a dark preset applies
  the dark brand color; an unknown id changes nothing; `checkUiIds` passes.
- Kition: unit tests that every preset defines every shell variable and Kit
  UI token and meets contrast, that `KitFrame` sends `ui/theme` on change, and
  that customization is stored and reset; an e2e test that opens the Photo
  kit, switches presets and sees the kit follow, hides an element, reopens
  the tab and still sees it hidden, then restores defaults.
- Completion gates: `pnpm test:table:e2e`, `pnpm test:kitable:e2e`,
  `python3 scripts/check-i18n.py`, and `pnpm check:desktop` when Rust changes.

## Delivery order

1. kition-sdk: protocol 1.2 and standard text, `kit-protocol`, `kit-ui`,
   `kit-host`, `kit-dev-host`, `check-manifest.mjs`.
2. Photo adopts it and is verified.
3. The other nine kits adopt it.
4. Kition: `docs/design.md`, theme presets, theme delivery fix, `customize`
   capability, settings, kit tab brand icons.
