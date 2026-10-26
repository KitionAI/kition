# Packages

Source packages that Kition builds from `src/` and that run outside Kition too. There are none at
the moment: Kition's shared controls (buttons, form fields, modals, popovers, sheets, confirm, the
command list) come from Kition Tessera (`@kition/tessera-ui`, below), and kit editors live in the
kits' own repositories, shipped as packages in `public/kits/<kit>-ui/`
([docs/kit-sdk.md](../docs/kit-sdk.md)).

## How Kition uses packages here

- They are not installed. Kition resolves them by path alias, in `tsconfig.json` (`paths`),
  `tooling/vite.config.ts`, and `tooling/vitest.config.ts`, and their npm dependencies come from
  Kition's root `package.json`. Each `package.json` here names the package and its entries only.
- `tooling/tailwind.config.ts` scans `packages/*/src`, `tsc`, ESLint, knip, dependency-cruiser,
  `scripts/check-i18n.py`, and Vitest (`packages/*/src/**/*.spec.ts(x)`) cover them like `src/`.
- Packages import nothing from `src/` (dependency-cruiser rule
  `packages-import-nothing-from-the-app`).

## Kition Tessera

`@kition/tessera-ui` (components) and `@kition/tessera-icons` (icons) are git dependencies pinned to
one commit of the public `KitionAI/kition-tessera` repository in `package.json`; `pnpm.overrides`
points the packages' own Tessera dependencies (`@kition/tessera-icons`,
`@kition/tessera-tokens`) at the same commit. Move all four together with
`node scripts/pin-tessera.mjs <commit>`.

- **Styles.** `src/app/styles.css` imports `@kition/tessera-ui/styles.css` into the `tessera` cascade
  layer, above Tailwind's reset (`reset` layer) and below everything unlayered, so a Tailwind class
  at a call site adjusts a Tessera control. The same file maps Tessera's theme tokens (`--kit-*`)
  to Kition's variables, light and dark.
- **Strings.** `src/app/TesseraStrings.tsx` gives Tessera's components their labels (Close,
  Confirm, Cancel, Show password, the sheet's name) from Kition's `common` namespace, in every
  locale.
- **Sizes.** Tessera's controls share one scale: `sm` 32px, `md` 36px, `lg` 40px; Kition's form
  fields use `lg`.
