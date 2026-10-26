#!/usr/bin/env node
// Pins Kition to one commit of Kition Tessera (the public KitionAI/kition-tessera repository):
// the `@kition/tessera-ui` and `@kition/tessera-icons` dependencies and the `pnpm.overrides` that
// point those packages' own `@kition/tessera-icons` and `@kition/tessera-tokens` at the same
// commit. See packages/README.md.
//
//   node scripts/pin-tessera.mjs <commit>   pin all four to <commit> (40 hex digits); then pnpm install
//   node scripts/pin-tessera.mjs --check    fail when they name different commits
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim()
const file = path.join(repo, 'package.json')
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const spec = (commit, dir) => `github:KitionAI/kition-tessera#${commit}&path:/packages/${dir}`
const slots = [
  [manifest.dependencies, '@kition/tessera-ui', 'ui'],
  [manifest.dependencies, '@kition/tessera-icons', 'icons'],
  [manifest.pnpm.overrides, '@kition/tessera-icons', 'icons'],
  [manifest.pnpm.overrides, '@kition/tessera-tokens', 'tokens'],
]
const arg = process.argv[2]
if (arg === '--check') {
  const commits = new Set(slots.map(([section, name]) => /#([0-9a-f]{40})&/.exec(section?.[name] ?? '')?.[1] ?? `missing ${name}`))
  if (commits.size !== 1 || [...commits][0].startsWith('missing')) {
    console.error(`FAIL Tessera dependencies name different commits: ${[...commits].join(', ')}; run node scripts/pin-tessera.mjs <commit>`)
    process.exit(1)
  }
  console.log(`PASS Kition Tessera pinned to ${[...commits][0]}`)
} else if (/^[0-9a-f]{40}$/.test(arg ?? '')) {
  for (const [section, name, dir] of slots) section[name] = spec(arg, dir)
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`pinned Kition Tessera to ${arg}; run pnpm install`)
} else {
  console.error('usage: node scripts/pin-tessera.mjs <commit> | --check')
  process.exit(2)
}
