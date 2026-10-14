#!/usr/bin/env node
// Kition's copy of the Kit UI protocol's host side (kition-sdk packages/kit-protocol and
// packages/kit-host), in src/features/kits/host/, of the standard's kit.json schema
// (schemas/kit.schema.json), in contracts/kit/kit-standard.schema.json for the conformance suite,
// and of the Kit Data Model (packages/kdm/src/*.ts), in src/lib/kdm/, and its Rust crate
// (crates/kition-kdm), in crates/kition-kdm/. kition-sdk is private and
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
// The Rust KDM (crates/kition-kdm): its sources and tests, unchanged, so they run against this
// workspace's dependency features (serde_json `preserve_order`), with a manifest written here.
const rustKdm = 'crates/kition-kdm'
for (const dir of ['src', 'tests']) {
  for (const name of fs.readdirSync(path.join(sdk, rustKdm, dir)).filter((name) => name.endsWith('.rs')).sort()) {
    const source = `${rustKdm}/${dir}/${name}`
    // Kition denies unwrap and expect in its own code; the SDK's test helpers use them.
    const allow = dir === 'tests' ? '#![allow(clippy::unwrap_used, clippy::expect_used)]\n' : ''
    files.push({ source, out: source, rewrite: (text) => header(source) + allow + text })
  }
}
for (const name of fs.readdirSync(path.join(sdk, rustKdm, 'tests/fixtures')).sort()) {
  const source = `${rustKdm}/tests/fixtures/${name}`
  files.push({ source, out: source, binary: true })
}
// kition-sdk's lint (unwrap and expect allowed in tests) and format configurations, for this crate only.
files.push({ source: 'clippy.toml', out: `${rustKdm}/clippy.toml`, binary: true })
files.push({ source: 'rustfmt.toml', out: `${rustKdm}/rustfmt.toml`, binary: true })
files.push({
  source: `${rustKdm}/Cargo.toml`,
  out: `${rustKdm}/Cargo.toml`,
  rewrite: (text) => {
    const dependencies = text.slice(text.indexOf('[dependencies]'))
    return `# Copied from kition-sdk ${rustKdm} by scripts/sync-kit-host.mjs; change it there, not here.
[package]
name = "kition-kdm"
description = "Kit Data Model: the typed, replicated document model every Kition kit declares its document in."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lints]
workspace = true

${dependencies}`
  },
})
// A KDM copy whose source file is gone is stale too. Only files this script wrote (they start
// with its header, or sit in the copied fixtures folder) count, so a hand-written file is never
// removed.
const copyDirs = [
  { dir: 'src/lib/kdm', ext: '.ts' },
  { dir: `${rustKdm}/src`, ext: '.rs' },
  { dir: `${rustKdm}/tests`, ext: '.rs' },
  { dir: `${rustKdm}/tests/fixtures`, ext: '', all: true },
]
const copies = new Set(files.map((file) => file.out))
const copiedHere = (file) => fs.readFileSync(file, 'utf8').startsWith('// Copied from kition-sdk ')
const kdmOrphans = copyDirs.flatMap(({ dir, ext, all }) => {
  const full = path.join(repo, dir)
  if (!fs.existsSync(full)) return []
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext) && !copies.has(`${dir}/${entry.name}`))
    .filter((entry) => all || copiedHere(path.join(full, entry.name)))
    .map((entry) => `${dir}/${entry.name}`)
})

let stale = 0
for (const name of kdmOrphans) {
  if (process.argv.includes('--check')) {
    console.log(`FAIL ${name} has no source in kition-sdk; run node scripts/sync-kit-host.mjs`)
    stale += 1
  } else {
    fs.rmSync(path.join(repo, name))
    console.log(`removed ${name}`)
  }
}
for (const file of files) {
  const out = path.join(repo, file.out)
  const wanted = file.binary
    ? fs.readFileSync(path.join(sdk, file.source))
    : Buffer.from(file.rewrite(fs.readFileSync(path.join(sdk, file.source), 'utf8')))
  const current = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0)
  if (current.equals(wanted)) continue
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
if (process.argv.includes('--check')) console.log('PASS kit host, kit.json schema, and KDM (TypeScript and Rust) copies match kition-sdk')
