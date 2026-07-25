# Kition Brand Contract

## Canonical identity

- Product name: `Kition`
- Website: `kition.ai`
- Repository and package slug: `kition`
- Application, storage, environment, and event prefixes: `kition`
- Product-owned dot directory: `.kition`

## Repository rules

- Product-facing names, examples, fixtures, comments, tests, and documentation must use the canonical identity.
- Historical product identities must not appear in tracked filenames or tracked text.
- Third-party package names may appear only when they identify a real installed dependency or are required by its license notice.
- Compatibility identifiers must use a neutral protocol or format name rather than another product's identity.
- New branding aliases require an explicit update to this contract and the branding guard.

## Verification

Run the repository branding guard before release:

```bash
pnpm run check:branding
```
