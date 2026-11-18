import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { KITS } from '../src/lib/script/kits/index'

type Manifest = { model?: { schema?: string; schemaVersion?: number } }

const lock = JSON.parse(readFileSync('kits/kits.lock.json', 'utf8')) as Record<string, unknown>

// Kition sends a kit's registered schema with every agent describe and batch request, and the
// kit refuses a document whose schema version is newer than the schema it was given. A schema
// older than the pinned package's makes the agent's object model fail on every new document.
for (const kit of Object.keys(lock).filter((key) => !key.startsWith('$'))) {
  test(`${kit}: the registered object-model schema has the pinned package's schema version`, () => {
    const file = `public/kits/${kit}-ui/kit.json`
    expect(existsSync(file), `${kit} must be fetched before this check (node scripts/fetch-kits.mjs)`).toBe(true)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest
    const registered = KITS[`kit.${kit}`]?.schema as { schemaVersion?: number } | undefined
    const declared = manifest.model?.schemaVersion
    // A kit without a registered schema describes its own; a package without a declared model
    // (kit-matrix row K3) has no version to compare with.
    if (!registered || declared === undefined) return
    expect(registered.schemaVersion).toBe(declared)
  })
}
