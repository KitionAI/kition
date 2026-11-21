#!/usr/bin/env node
// Pins kit packages published on npm in kits/kits.lock.json (docs/kits.md, section 4b).
//
//   node scripts/pin-kits.mjs board cad@0.1.1   pin these kits: the version given, else the latest
//   node scripts/pin-kits.mjs --all             pin the latest of every kit in kits/modules.json
//
// For each kit it reads the registry's metadata of its editor package @kition/kit-<kit>-ui at that
// version (or its `latest`), which the kit repository's Package workflow published, and writes its
// lock entry: the package, version, npm's integrity, and the kit, kition-sdk, kition-tessera and
// kition-fonts commits from the package's `kition.build`. It reads metadata only; scripts/fetch-kits.mjs
// downloads the package and checks it against the entry. The registries are read in order
// (scripts/lib/kitNpm.mjs `registries`: KITION_NPM_REGISTRY, ~/.npmrc, npmjs.org, npmmirror.com);
// the first that has the version answers. KITION_NPM_SCOPE names another npm scope (default @kition),
// whose editor packages are <scope>/<kit> (layout 1, scripts/lib/kitNpm.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredRegistries } from './lib/kitNpm.mjs'
import { pinKit, readKitLock, writeKitLock } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'modules.json'), 'utf8'))
let list
try {
  list = configuredRegistries()
} catch (error) {
  // A malformed KITION_NPM_SCOPE, said without a stack.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const args = process.argv.slice(2)
const asked = args.includes('--all') ? Object.keys(registry).map((kit) => ({ kit })) : args.map((arg) => ({ kit: arg.split('@')[0], version: arg.includes('@') ? arg.split('@')[1] : undefined }))
const unknown = asked.filter(({ kit }) => !registry[kit]).map(({ kit }) => kit)
if (!asked.length || unknown.length) {
  console.error(unknown.length ? `kits/modules.json has no kit ${unknown.join(', ')}` : 'usage: node scripts/pin-kits.mjs <kit>[@<version>]... | --all')
  process.exit(2)
}
const entries = {}
let failed = 0
for (const { kit, version } of asked) {
  try {
    const { registry: from, entry } = await pinKit(kit, version, list)
    entries[kit] = entry
    console.log(`${kit}: ${entry.package}@${entry.version} from ${from}, commit ${entry.commit}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    failed += 1
  }
}
writeKitLock(repoRoot, entries)
console.log(`pinned ${Object.keys(entries).length} kit(s) in kits/kits.lock.json${failed ? `; ${failed} failed` : ''}`)
try {
  readKitLock(repoRoot)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  failed += 1
}
process.exit(failed ? 1 : 0)
