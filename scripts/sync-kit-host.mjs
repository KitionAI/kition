#!/usr/bin/env node
// Kition's copy of the Kit UI protocol's host side (kition-sdk packages/kit-protocol and
// packages/kit-host), in src/features/kits/host/, of the standard's kit.json schema
// (schemas/kit.schema.json), in contracts/kit/kit-standard.schema.json for the conformance suite,
// of the Kit Data Model (packages/kdm/src/*.ts), in src/lib/kdm/, of the TypeScript engine
// contract (packages/kit-engine/src/*.ts), in src/lib/kit-engine/, of the TypeScript convergence
// suite (packages/convergence/src/*.ts but its Node-only node.ts), in src/lib/convergence/, which
// the Board kit's convergence test runs, and of the KDM's Rust crate
// (crates/kition-kdm), in crates/kition-kdm/, of the licence verifier (crates/kition-license), in
// crates/kition-license/, and of the sync client for kition-sync/1 and its
// replica relay (packages/sync/src/*.ts), in src/lib/sync/, of the object model's page side
// (@kition/sdk, packages/sdk/src and its generated kits), in src/lib/sdk/, and of the extension
// host (@kition/extensions, packages/extensions/src with its built worker runtime), in
// src/lib/extensions/, with its sandbox and panel pages in public/extensions/. kition-sdk is
// private and Kition is public, so Kition carries the files instead of depending on the packages.
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

if (!fs.existsSync(path.join(sdk, 'packages/kit-host')) || !fs.existsSync(path.join(sdk, 'packages/extensions'))) {
  if (process.argv.includes('--check')) {
    console.log(`SKIP kit host, kit.json schema, KDM, sync client, object model, and extension host copies: no kition-sdk at ${sdk}`)
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
// The TypeScript engine contract (@kition/kit-engine): what the Board kit's engine is made with.
const kitEngineSource = 'packages/kit-engine/src'
for (const name of fs.readdirSync(path.join(sdk, kitEngineSource)).filter((name) => name.endsWith('.ts')).sort()) {
  const source = `${kitEngineSource}/${name}`
  files.push({ source, out: `src/lib/kit-engine/${name}`, rewrite: (text) => header(source) + text.replaceAll("from '@kition/kdm'", "from '../kdm'") })
}
// The convergence suite for TypeScript engines (@kition/convergence): what the Board kit's L6 test
// runs. Its Node-only helper (node.ts) stays behind; the test writes its report itself.
const convergenceSource = 'packages/convergence/src'
for (const name of fs.readdirSync(path.join(sdk, convergenceSource)).filter((name) => name.endsWith('.ts') && name !== 'node.ts').sort()) {
  const source = `${convergenceSource}/${name}`
  files.push({
    source,
    out: `src/lib/convergence/${name}`,
    rewrite: (text) => header(source) + text.replaceAll("from '@kition/kdm'", "from '../kdm'").replaceAll("from '@kition/kit-engine'", "from '../kit-engine'"),
  })
}
// Every sync client (@kition/sync) source file, with the relay between a replica and its room:
// its imports are relative but for the KDM's (`@kition/kdm`), which is the copy in src/lib/kdm/,
// and it needs nothing beyond Web Crypto, a WebSocket, and `loro-crdt`.
const syncSource = 'packages/sync/src'
for (const name of fs.readdirSync(path.join(sdk, syncSource)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort()) {
  const source = `${syncSource}/${name}`
  files.push({ source, out: `src/lib/sync/${name}`, rewrite: (text) => header(source) + text.replaceAll("from '@kition/kdm'", "from '../kdm'") })
}
// The object model (@kition/sdk) as a page uses it: every source file but the Node-only ones,
// with the KDM's and the sync client's imports pointing at the copies in src/lib/kdm/ and
// src/lib/sync/, and its generated kit typings.
const sdkSource = 'packages/sdk/src'
const nodeOnly = new Set(['node.ts', 'headless.ts'])
for (const name of fs.readdirSync(path.join(sdk, sdkSource)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !nodeOnly.has(name)).sort()) {
  const source = `${sdkSource}/${name}`
  files.push({
    source,
    out: `src/lib/sdk/${name}`,
    rewrite: (text) => header(source) + text.replaceAll("from '@kition/kdm'", "from '../kdm'").replaceAll("from '@kition/sync'", "from '../sync'"),
  })
}
for (const name of fs.readdirSync(path.join(sdk, 'packages/sdk/kits')).filter((name) => name.endsWith('.ts')).sort()) {
  const source = `packages/sdk/kits/${name}`
  files.push({ source, out: `src/lib/sdk/kits/${name}`, rewrite: (text) => header(source) + text.replaceAll("from '../src/", "from '../") })
}
// The extension host (@kition/extensions): its host-side sources and the built worker runtime
// (the runtime's own sources are bundled into it), and the sandbox page it loads in a frame.
const extensionsSource = 'packages/extensions/src'
const extensionFiles = [
  ...fs.readdirSync(path.join(sdk, extensionsSource)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort(),
  'generated/runtime.ts',
]
for (const name of extensionFiles) {
  const source = `${extensionsSource}/${name}`
  files.push({
    source,
    out: `src/lib/extensions/${name}`,
    rewrite: (text) =>
      header(source) +
      text
        .replaceAll("from '@kition/kdm'", `from '${name.includes('/') ? '../../kdm' : '../kdm'}'`)
        .replaceAll("from '@kition/sdk'", "from '../sdk'")
        .replaceAll("import '@kition/sdk/kits'", "import '../sdk/kits/index'"),
  })
}
files.push({ source: 'packages/extensions/sandbox/sandbox.html', out: 'public/extensions/sandbox.html', binary: true })
files.push({ source: 'packages/extensions/sandbox/panel.html', out: 'public/extensions/panel.html', binary: true })
// The example extension, which the end-to-end tests install.
for (const name of ['extension.json', 'extension.mjs', 'panel.html']) {
  files.push({ source: `examples/extensions/title-case/${name}`, out: `e2e/fixtures/extensions/title-case/${name}`, binary: true })
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
// ts-page.json and ts-shallow.json are the TypeScript fixtures' states as non-ASCII JSON, which
// this English-only repository does not carry; the Rust tests compare their SHA-256 (ts-page.sha256,
// ts-shallow.sha256) instead.
const skippedFixtures = new Set(['ts-page.json', 'ts-shallow.json'])
for (const name of fs.readdirSync(path.join(sdk, rustKdm, 'tests/fixtures')).filter((name) => !skippedFixtures.has(name)).sort()) {
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
// The licence verifier (crates/kition-license), which kition-kits-mcp checks SDK licence keys
// with: its sources, tests, and test vectors, unchanged, with a manifest written here.
const rustLicense = 'crates/kition-license'
for (const dir of ['src', 'tests']) {
  for (const name of fs.readdirSync(path.join(sdk, rustLicense, dir)).filter((name) => name.endsWith('.rs')).sort()) {
    const source = `${rustLicense}/${dir}/${name}`
    files.push({ source, out: source, rewrite: (text) => header(source) + text })
  }
}
files.push({ source: `${rustLicense}/tests/vectors.json`, out: `${rustLicense}/tests/vectors.json`, binary: true })
files.push({ source: 'clippy.toml', out: `${rustLicense}/clippy.toml`, binary: true })
files.push({ source: 'rustfmt.toml', out: `${rustLicense}/rustfmt.toml`, binary: true })
files.push({
  source: `${rustLicense}/Cargo.toml`,
  out: `${rustLicense}/Cargo.toml`,
  rewrite: (text) => {
    const dependencies = text.slice(text.indexOf('[dependencies]'))
    return `# Copied from kition-sdk ${rustLicense} by scripts/sync-kit-host.mjs; change it there, not here.
[package]
name = "kition-license"
description = "Offline Kition SDK licence keys: an Ed25519-signed JSON payload, verified against pinned public keys with no network."
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
  { dir: 'src/lib/sync', ext: '.ts' },
  { dir: 'src/lib/kit-engine', ext: '.ts' },
  { dir: 'src/lib/convergence', ext: '.ts' },
  { dir: 'src/lib/sdk', ext: '.ts' },
  { dir: 'src/lib/sdk/kits', ext: '.ts' },
  { dir: 'src/lib/extensions', ext: '.ts' },
  { dir: 'src/lib/extensions/generated', ext: '.ts' },
  { dir: `${rustKdm}/src`, ext: '.rs' },
  { dir: `${rustKdm}/tests`, ext: '.rs' },
  { dir: `${rustKdm}/tests/fixtures`, ext: '', all: true },
  { dir: `${rustLicense}/src`, ext: '.rs' },
  { dir: `${rustLicense}/tests`, ext: '.rs' },
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
if (process.argv.includes('--check')) console.log('PASS kit host, kit.json schema, KDM (TypeScript and Rust), engine contract, convergence suite, sync client, object model, and extension host copies match kition-sdk')
