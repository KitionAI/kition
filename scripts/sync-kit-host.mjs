#!/usr/bin/env node
// Kition's copy of the Kit UI protocol's host side (kition-sdk packages/kit-protocol and
// packages/kit-host), in src/features/kits/host/, and of the standard's kit.json schema
// (schemas/kit.schema.json), in contracts/kit/kit-standard.schema.json for the conformance suite.
// kition-sdk is private and Kition is public, so Kition carries the files instead of depending
// on the packages.
//
//   node scripts/sync-kit-host.mjs          copy them from ../kition-sdk (or KITION_SDK)
//   node scripts/sync-kit-host.mjs --check  fail when the copy differs (skipped without kition-sdk)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim()
const sdk = process.env.KITION_SDK || path.join(repo, '..', 'kition-sdk')
const header = (source) => `// Copied from kition-sdk ${source} by scripts/sync-kit-host.mjs; change it there, not here.\n`
const files = [
  { source: 'packages/kit-protocol/src/index.ts', out: 'src/features/kits/host/protocol.ts', rewrite: (text) => header('packages/kit-protocol/src/index.ts') + text },
  {
    source: 'packages/kit-host/src/index.ts',
    out: 'src/features/kits/host/mountKit.ts',
    rewrite: (text) => header('packages/kit-host/src/index.ts') + text.replace("from '@kition/kit-protocol'", "from './protocol'"),
  },
  // JSON has no comments; the schema's $id names its source.
  { source: 'schemas/kit.schema.json', out: 'contracts/kit/kit-standard.schema.json', rewrite: (text) => text },
]

if (!fs.existsSync(path.join(sdk, 'packages/kit-host'))) {
  if (process.argv.includes('--check')) {
    console.log(`SKIP kit host and kit.json schema copies: no kition-sdk at ${sdk}`)
    process.exit(0)
  }
  console.error(`no kition-sdk at ${sdk}; set KITION_SDK`)
  process.exit(1)
}

let stale = 0
for (const file of files) {
  const wanted = file.rewrite(fs.readFileSync(path.join(sdk, file.source), 'utf8'))
  const out = path.join(repo, file.out)
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  if (current === wanted) continue
  if (process.argv.includes('--check')) {
    console.log(`FAIL ${file.out} differs from kition-sdk ${file.source}; run node scripts/sync-kit-host.mjs`)
    stale += 1
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, wanted)
    console.log(`wrote ${file.out}`)
  }
}
if (stale) process.exit(1)
if (process.argv.includes('--check')) console.log('PASS kit host and kit.json schema copies match kition-sdk')
