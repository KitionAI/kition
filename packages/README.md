# Packages

Source packages that Kition builds from `src/` and that run outside Kition too.

| Package | Directory | What it is |
| --- | --- | --- |
| `@kition/app-ui` | `packages/app-ui/` | Shared UI primitives: the `src/index.tsx` controls (Button, Card, Input, Select, Disclosure, …), the shadcn-style `button`, `command`, `dialog`, `input`, `popover`, `spinner`, `switch`, `tooltip`, `confirm`, `RightSheet`, their hooks, and `cn` (`utils`). |

Kit editors are not packages here: every kit's editor and engine live in the kit's own
repository and ship as its package in `public/kits/<kit>-ui/` ([docs/kit-sdk.md](../docs/kit-sdk.md)).

## How Kition uses them

- They are not installed. Kition resolves them by path alias, in `tsconfig.json` (`paths`),
  `tooling/vite.config.ts`, and `tooling/vitest.config.ts`, and their npm dependencies (React,
  react-i18next, Radix, lucide-react, …) come from Kition's root `package.json`. Each
  `package.json` here names the package and its entries only.
- `tooling/tailwind.config.ts` scans `packages/*/src`, `tsc`, ESLint, knip, dependency-cruiser,
  `scripts/check-i18n.py`, and Vitest (`packages/*/src/**/*.spec.ts(x)`) cover them like `src/`.
- Packages import nothing from `src/` (dependency-cruiser rule
  `packages-import-nothing-from-the-app`), and `@kition/app-ui` imports no other package.

### Strings

`@kition/app-ui` translates a few shared labels with react-i18next from the `common` namespace
(`actions.cancel`, `actions.close`, `actions.confirm`, `actions.showPassword`,
`actions.hidePassword`, `dialogs.rightSheet`), so a host loads those keys. Kition registers its
i18next instance globally (`src/i18n`, `initReactI18next`).

### Styles

The packages ship no stylesheet; they use the host's: Tailwind with Kition's theme tokens
(`tooling/tailwind.config.ts`, the CSS variables in `src/app/styles.css`) and `packages/*/src` in
its content paths. Visual rules follow `docs/design.md`.
