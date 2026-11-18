#!/usr/bin/env node
// Pins Kition to one release of Kition Tessera (the `@kition/tessera-*` packages on npm, built from
// the public KitionAI/kition-tessera repository): the `@kition/tessera-ui` and `@kition/tessera-icons`
// dependencies and the `pnpm.overrides` that hold those packages' own `@kition/tessera-icons` and
// `@kition/tessera-tokens` at the same version. See docs/kition-ui-development.md, Kition Tessera.
//
//   node scripts/pin-tessera.mjs <version>  pin all four to <version> (exact, for example 0.1.0); then pnpm install
//   node scripts/pin-tessera.mjs --check    fail when they name different versions
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim()
const file = path.join(repo, 'package.json')
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const slots = [
  [manifest.dependencies, '@kition/tessera-ui'],
  [manifest.dependencies, '@kition/tessera-icons'],
  [manifest.pnpm.overrides, '@kition/tessera-icons'],
  [manifest.pnpm.overrides, '@kition/tessera-tokens'],
]
const arg = process.argv[2]
if (arg === '--check') {
  const versions = new Set(slots.map(([section, name]) => (VERSION.test(section?.[name] ?? '') ? section[name] : `missing or not an exact version: ${name}`)))
  if (versions.size !== 1 || [...versions][0].startsWith('missing')) {
    console.error(`FAIL Tessera dependencies name different versions: ${[...versions].join(', ')}; run node scripts/pin-tessera.mjs <version>`)
    process.exit(1)
  }
  console.log(`PASS Kition Tessera pinned to ${[...versions][0]}`)
} else if (VERSION.test(arg ?? '')) {
  for (const [section, name] of slots) section[name] = arg
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`pinned Kition Tessera to ${arg}; run pnpm install`)
} else {
  console.error('usage: node scripts/pin-tessera.mjs <version> | --check')
  process.exit(2)
}
