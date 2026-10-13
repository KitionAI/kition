#!/usr/bin/env node
// Kition's copy of the Kit UI protocol's host side (kition-sdk packages/kit-protocol and
// packages/kit-host), in src/features/kits/host/, of the standard's kit.json schema
// (schemas/kit.schema.json), in contracts/kit/kit-standard.schema.json for the conformance suite,
// and of the Kit Data Model (packages/kdm/src/*.ts), in src/lib/kdm/. kition-sdk is private and
// Kition is public, so Kition carries the files instead of depending on the packages.
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
    console.log(`SKIP kit host, kit.json schema, and KDM copies: no kition-sdk at ${sdk}`)
    process.exit(0)
  }
  console.error(`no kition-sdk at ${sdk}; set KITION_SDK`)
  process.exit(1)
}

// Every KDM source file, unchanged: its imports are relative or `loro-crdt`, a dependency of Kition.
const kdmSource = 'packages/kdm/src'
for (const name of fs.readdirSync(path.join(sdk, kdmSource)).filter((name) => name.endsWith('.ts')).sort()) {
  const source = `${kdmSource}/${name}`
  files.push({ source, out: `src/lib/kdm/${name}`, rewrite: (text) => header(source) + text })
}
// A KDM copy whose source file is gone is stale too.
const kdmOut = path.join(repo, 'src/lib/kdm')
const kdmCopies = new Set(files.filter((file) => file.out.startsWith('src/lib/kdm/')).map((file) => path.basename(file.out)))
const kdmOrphans = fs.existsSync(kdmOut)
  ? fs.readdirSync(kdmOut).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !kdmCopies.has(name))
  : []

let stale = 0
for (const name of kdmOrphans) {
  if (process.argv.includes('--check')) {
    console.log(`FAIL src/lib/kdm/${name} has no source in kition-sdk ${kdmSource}; run node scripts/sync-kit-host.mjs`)
    stale += 1
  } else {
    fs.rmSync(path.join(kdmOut, name))
    console.log(`removed src/lib/kdm/${name}`)
  }
}
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
if (process.argv.includes('--check')) console.log('PASS kit host, kit.json schema, and KDM copies match kition-sdk')
