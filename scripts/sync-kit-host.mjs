#!/usr/bin/env node
// Kition's copy of the Kit UI protocol's host side (kition-sdk packages/kit-protocol and
// packages/kit-host), in src/features/kits/host/. kition-sdk is private and Kition is public, so
// Kition carries the two files instead of depending on the packages.
//
//   node scripts/sync-kit-host.mjs          copy them from ../kition-sdk (or KITION_SDK)
//   node scripts/sync-kit-host.mjs --check  fail when the copy differs (skipped without kition-sdk)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim()
const sdk = process.env.KITION_SDK || path.join(repo, '..', 'kition-sdk')
const target = path.join(repo, 'src/features/kits/host')
const header = (source) => `// Copied from kition-sdk ${source} by scripts/sync-kit-host.mjs; change it there, not here.\n`
const files = [
  { source: 'packages/kit-protocol/src/index.ts', name: 'protocol.ts', rewrite: (text) => text },
  { source: 'packages/kit-host/src/index.ts', name: 'mountKit.ts', rewrite: (text) => text.replace("from '@kition/kit-protocol'", "from './protocol'") },
]

if (!fs.existsSync(path.join(sdk, 'packages/kit-host'))) {
  if (process.argv.includes('--check')) {
    console.log(`SKIP kit host copy: no kition-sdk at ${sdk}`)
    process.exit(0)
  }
  console.error(`no kition-sdk at ${sdk}; set KITION_SDK`)
  process.exit(1)
}

let stale = 0
for (const file of files) {
  const wanted = header(file.source) + file.rewrite(fs.readFileSync(path.join(sdk, file.source), 'utf8'))
  const out = path.join(target, file.name)
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  if (current === wanted) continue
  if (process.argv.includes('--check')) {
    console.log(`FAIL src/features/kits/host/${file.name} differs from kition-sdk ${file.source}; run node scripts/sync-kit-host.mjs`)
    stale += 1
  } else {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(out, wanted)
    console.log(`wrote src/features/kits/host/${file.name}`)
  }
}
if (stale) process.exit(1)
if (process.argv.includes('--check')) console.log('PASS kit host copy matches kition-sdk')
