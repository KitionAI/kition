# Kition Product UI Style

## Selected Direction

Kition adopts **Direction A: Quiet Workspace** as the product UI style baseline.

This direction is a conservative refinement of the current product UI. It keeps
the app calm, document-first, and tool-focused while tightening consistency
across the workspace shell, editor, tables, settings, workflow, and agent
surfaces.

## Design Intent

Kition should feel like a quiet, capable AI workspace: precise, light,
trustworthy, and efficient. The interface should support repeated work in
documents, tables, workflows, and agents without visual noise.

The product should not feel like a marketing page inside the app. Use brand
color as a clear action and selection signal, not as decoration.

## Core Tokens

### Color

- Primary action: `#5645d4`
- Primary pressed: `#4534b3`
- Canvas: `#ffffff`
- Sidebar / soft surface: `#fafaf9`
- Secondary surface: `#f6f5f4`
- Hairline border: `#e5e3df`
- Strong border / input border: `#c8c4be`
- Primary text: `#1a1a1a`
- Secondary text: `#5d5b54`
- Tertiary text: `#787671`
- Disabled / quiet text: `#a4a097`
- Active soft purple: `#f1effb`
- Active purple text: `#2d236f`
- Success soft: `#d9f3e1`
- Warning soft: `#ffe8d4`
- Info soft: `#dcecfa`

### CSS Variable Mapping

Product surfaces consume tokens through CSS variables defined in
`src/app/styles.css`. The variables are stored as HSL channel triples so
that Tailwind utilities (`bg-background`, `text-foreground`, `border-border`,
etc.) and the shadcn primitives can compose them. Use these variables in code,
not raw hex; the hex values above are the light-mode resolution of these
variables.

| Role | Hex (light) | CSS variable | Tailwind utility examples |
|---|---|---|---|
| Primary action / focus ring | `#5645d4` | `--brand`, `--primary`, `--ring`, `--sidebar-active` | `bg-brand`, `ring-ring`, `bg-primary` |
| Primary pressed | `#4534b3` | `--brand-active` | `bg-brand-active` |
| Canvas | `#ffffff` | `--background`, `--surface-strong` | `bg-background` |
| Sidebar / soft surface | `#fafaf9` | `--surface-soft`, `--sidebar-background` | `bg-surface-soft` |
| Secondary surface | `#f6f5f4` | `--secondary`, `--muted`, `--sidebar-accent` | `bg-secondary`, `bg-muted` |
| Hairline border | `#e5e3df` | `--border` | `border`, `border-border` |
| Soft hairline | – | `--hairline-soft` | `border-hairline-soft` |
| Strong / input border | `#c8c4be` | `--hairline-strong`, `--input` | `border-hairline-strong` |
| Primary text | `#1a1a1a` | `--foreground`, `--card-foreground`, `--popover-foreground` | `text-foreground` |
| Secondary text | `#5d5b54` | `--secondary-foreground` | `text-secondary-foreground` |
| Tertiary / sidebar text | `#787671` | `--muted-foreground`, `--subtle-foreground`, `--sidebar-foreground` | `text-muted-foreground` |
| Active soft purple | `#f1effb` | `--accent` | `bg-accent` |
| Active purple text | `#2d236f` | `--accent-foreground` | `text-accent-foreground` |
| Success soft | `#d9f3e1` | `--success-background` (border `--success-border`, text `--success-foreground`) | `bg-success-background` |
| Warning soft | `#ffe8d4` | `--warning-background` (border `--warning-border`, text `--warning-foreground`) | `bg-warning-background` |
| Info soft | `#dcecfa` | `--tint-sky` | `bg-tint-sky` |
| Destructive soft | – | `--destructive-background` (border `--destructive-border`) | `bg-destructive-background` |
| Card / dialog elevation | – | `--shadow-soft`, `--shadow-floating`, `--shadow-toolbar`, `--shadow-elevated` | `shadow-[var(--shadow-soft)]` etc. |

Rules:

- Do not hardcode hex in product components. If a value needed in code is not
  yet listed here, first add it to `styles.css` (light + dark) and to this
  mapping table.
- The `--tint-*` family (`peach`, `rose`, `mint`, `lavender`, `sky`, `yellow`,
  `yellow-bold`, `cream`, `gray`) is intended for status chips, illustration
  backgrounds and feature tints; keep them out of regular toolbar/sidebar
  surfaces.
- `--ring`, `--brand` and `--primary` resolve to the same hue in light mode but
  may diverge in future themes; use the role-specific variable, not whichever
  alias happens to match.

### Dark Mode

Dark mode is a first-class product surface, not an inverted afterthought.
Implementations must keep the same product structure (white-ish content,
quiet sidebar, hairline borders, restrained shadows) and only swap the token
resolution. The dark scale is already defined in `src/app/styles.css`
under the `.dark` selector.

Principles:

- Never hardcode dark colors in components. Always read from the CSS
  variables above; the `.dark` class swap handles the rest.
- Dark surfaces shift from white to a deep neutral (`--background` ≈ `#0f1117`)
  with a slightly lighter card surface (`--card`, `--surface-strong`). Sidebar
  is darker than the main content, not lighter, to keep the same depth order
  as light mode.
- Brand purple becomes a lighter, less saturated tone (`--brand` ≈ light
  lavender on dark). Use `--brand-foreground` for text on a brand-filled
  surface — it is dark, not white, in dark mode.
- Active selection (`--accent`) becomes a deep desaturated purple background
  paired with a soft lavender `--accent-foreground`. Do not fill an entire
  sidebar item with `--brand` in dark mode; keep selection on `--accent`.
- Borders lift from a single hairline to a small ladder
  (`--hairline-soft` < `--border` < `--hairline-strong`) so that table headers,
  inputs and dialog edges stay readable against the darker fills.
- Shadows in dark mode include an inset highlight (`--shadow-inset-highlight`)
  plus deeper outer shadow. Use the `--shadow-*` tokens directly rather than
  composing custom rgba in components.
- Status tints (`--tint-*`, `--success-background`, `--warning-background`,
  `--destructive-background`) are intentionally muted in dark mode. Pair them
  with the matching `*-foreground` token for legible text; do not assume the
  light-mode text color still works.

Acceptance rules for dark mode:

- Page background, sidebar, topbar, toolbar and table headers all read from
  CSS variables; grepping for `#fff`, `#ffffff`, `bg-white`, `text-black`,
  or any hardcoded hex inside `src/features` and `src/components` should
  return zero hits for product surfaces.
- Disabled buttons, ghost buttons and quiet icons must remain visibly disabled
  on dark: do not rely on opacity alone — use `--muted` / `--muted-foreground`
  for the disabled fill/text.
- `dark:` Tailwind variants are allowed for one-off tweaks, but the default
  light path should be expressed in tokens so that adding a third theme later
  does not require re-auditing components.

### Shape

- Buttons: `8px` radius
- Inputs and search fields: `8px` radius
- Tabs: `8px` radius unless they are explicit pill tabs or badges
- Product cards: `12px` radius
- Dialog panels: `12px` radius
- Large preview wrappers may use `16px` only when they frame a whole surface
- Do not turn ordinary product buttons into pills

### Elevation

- Default product surfaces: no shadow, `1px` hairline border
- Hover / selected cards: subtle shadow only
  `0 1px 2px rgba(15,15,15,.05), 0 10px 28px rgba(15,15,15,.04)`
- Modals and floating panels:
  `0 16px 48px rgba(15,15,15,.14)`
- Avoid heavy shadows on settings rows, table rows, and ordinary cards

### Typography

- Font stack:
  `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif`
- Product page titles: `18-22px`, `600-650`
- Panel headings: `15-16px`, `600-650`
- Body text: `14px`, regular
- Toolbar labels and buttons: `13-14px`, `500-650`
- Metadata / captions: `12-13px`, regular or medium
- Letter spacing stays `0` in product UI

`docs/design.md` lists `Inter` for typography — that file describes a
marketing-page baseline. Product surfaces use the Inter stack above; do not
ship `Inter` references in product code.

## Product Surface Rules

### Workspace Shell

- Main content remains white.
- Sidebar uses `#fafaf9` or a very close light neutral.
- Sidebar active state uses soft purple (`#f1effb`) with dark purple text,
  not a saturated filled purple block.
- Keep the left tree compact, but make active document and file type cues clear.
- Bottom utility icons should stay quiet and aligned; active states should be
  visible but not loud.

### Topbar And Tabs

- Topbar height should stay compact and predictable.
- Active tabs use white or very light surfaces with a `1px` border.
- Inactive icons should use tertiary text color.
- Avoid stacking decorative containers inside the topbar.

### Toolbars

- Toolbar controls should feel like a grouped tool surface, not a row of equal
  shouting buttons.
- The primary high-frequency action can use the primary purple button.
- Secondary actions use outline or ghost treatments.
- Disabled icon buttons should be visibly disabled and lower contrast.
- Keep icon buttons at stable dimensions, usually `32px`.

### Tables

- Table borders can be visible but restrained.
- Header backgrounds use `#fafaf9` or `#f6f5f4`.
- The main add-record action should be more visually discoverable than filter,
  sort, group, row height, and freeze controls.
- Filter, sort, group, row height, and freeze popovers should share one
  overlay style: `12px` radius, hairline border, light shadow.
- Search fields use an `8px` radius and soft neutral background.

### Markdown Table Widget

- The table can remain visually clean by default.
- When a table is focused, selected, or hovered, expose a lightweight table
  action surface so row and column insertion are discoverable.
- Hover-only controls are acceptable as shortcuts, but should not be the only
  way to discover structural editing.

### Settings

- Settings uses one consistent layout:
  sidebar navigation, pane title, section blocks, row title/description,
  right-aligned control.
- Rows should share stable padding, divider, and feedback placement.
- Use one pattern for loading, saved, validation, and error feedback across all
  settings panes.
- Settings cards should use `12px` radius and restrained border/shadow.

### Agent And Scenario Drawers

- Drawers should use white surfaces, `1px` border, and a light modal shadow.
- Close controls must visibly change state and actually remove or hide the
  drawer from the layout.
- Build/progress cards should use quiet borders and small status markers.
- Purple should mark the main action or selected AI state, not fill the drawer.

### Workflow

- Workflow pages should keep the workspace shell visible when possible.
- Canvas nodes should use the same card radius and border rules as other
  product cards.
- Zoom controls and insert controls must have stable dimensions and clear
  affordance.
- AI generation entry points can use the primary purple CTA; generated or
  streaming rows should use soft neutral/purple feedback.

### Responsive And Small Windows

- Desktop workspace targets a minimum usable width of **1024px**. At ≥1024px
  every shell region (left sidebar, main content, optional right drawer)
  renders in its default desktop position.
- Between **768px and 1023px** the left sidebar collapses into a drawer
  toggled from the topbar, the optional right drawer overlays the main
  content instead of splitting it, and Settings switches to a single-column
  layout (navigation collapses to a top selector or drawer).
- Below **768px** the workspace is degraded but not broken: sidebar and
  Settings navigation are drawer-only, toolbars may scroll horizontally, and
  modals expand to near-full width. Primary actions (Add record, Send, Run,
  Generate, primary CTA in dialogs) must remain reachable without horizontal
  scrolling.
- Below **480px** the product is explicitly out of scope for editing
  workflows — render a "please use a larger window" hint for editor and
  workflow canvas surfaces rather than shipping a broken layout. Read-only
  surfaces (document viewer, settings about page) should still work.
- Hover-only affordances are not allowed below 1024px: any control that uses
  a hover-reveal pattern on desktop must also be reachable via tap, long-press
  or a permanent control on narrower viewports.

## Implementation Targets

1. Add or align shared CSS tokens in `src/app/styles.css`.
2. Normalize shared button, input, card, popover, and dialog primitives.
3. Apply Quiet Workspace to the workspace shell and topbar.
4. Apply it to Settings rows, panels, and feedback.
5. Apply it to the table toolbar, popovers, table headers, and add-record action.
6. Add a focused table action surface for Markdown table widgets.
7. Align Scenario and Agent drawers with the same white, bordered, light-shadow
   panel treatment.
8. Define small-window behavior for the workspace shell and settings.

## Acceptance Checklist

- Primary CTA and main action controls use `#5645d4`.
- Ordinary product buttons stay `8px` radius, not pill-shaped.
- Product cards and dialog panels use `12px` radius.
- Default product surfaces remain white or light neutral.
- Sidebar active state is clear but quiet.
- Toolbars have a clear primary action and lower-emphasis secondary tools.
- Popovers share the same radius, border, and shadow style.
- Markdown table structural editing is discoverable without relying only on
  hidden hover controls.
- Settings panes use one row and feedback pattern.
- Narrow viewport behavior is defined rather than accidental, and the
  workspace remains usable at 1024px.
- Product components consume CSS variables (or matching Tailwind utilities)
  rather than hardcoded hex; dark mode renders correctly without any
  per-component color overrides.

## Reference Artifacts

- UI style preview: `reports/ui-style-directions/index.html`
- UI/UX audit report: `reports/ui-ux-audit/index.html`
- Project design source: `docs/design.md`
