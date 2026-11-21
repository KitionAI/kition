#!/usr/bin/env node
// Pins kit packages published on npm in kits/kits.lock.json (docs/kits.md, section 4b).
//
//   node scripts/pin-kits.mjs board cad@0.1.1   pin these kits: the version given, else the latest
//   node scripts/pin-kits.mjs --all             pin the latest of every kit in kits/modules.json
//   ... --dry-run                               print the entries instead of writing them
//   ... --lock <file>                           write (and check) another lock file
//
// For each kit it reads the registry's metadata of its editor package at that version (or its
// `latest`), which the kit repository's Package workflow published, and of its headless package for
// every platform npm has at that version, downloads each tarball once to check it has npm's
// integrity and to record its size, and writes the kit's npm pin: the scope, version, the kit,
// kition-sdk, kition-tessera and kition-fonts commits from the editor's `kition.build`, and the
// integrity and size of the editor package and of each platform's package. A platform npm lacks is
// named and left out. KITION_NPM_SCOPE names the npm scope (default @kition, whose packages are
// @kition/kit-<kit>-ui and @kition/kit-<kit>-<platform>; any other scope's are <scope>/<kit> and
// <scope>/<kit>-<platform>, scripts/lib/kitNpm.mjs). The registries are read in order
// (scripts/lib/kitNpm.mjs `registries`: KITION_NPM_REGISTRY, ~/.npmrc, npmjs.org, npmmirror.com);
// the first that has the version answers. scripts/fetch-kits.mjs downloads what the lock pins.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredRegistries, npmScope } from './lib/kitNpm.mjs'
import { pinKit, readKitLockFile, writeKitLockFile } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'modules.json'), 'utf8'))
let list
let scope
try {
  list = configuredRegistries()
  scope = npmScope()
} catch (error) {
  // A malformed KITION_NPM_SCOPE, said without a stack.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const lockAt = args.indexOf('--lock')
const lockFile = lockAt >= 0 ? path.resolve(args[lockAt + 1] ?? '') : path.join(repoRoot, 'kits', 'kits.lock.json')
const kitArgs = args.filter((arg, index) => !arg.startsWith('--') && !(lockAt >= 0 && index === lockAt + 1))
const asked = args.includes('--all') ? Object.keys(registry).map((kit) => ({ kit })) : kitArgs.map((arg) => ({ kit: arg.split('@')[0], version: arg.includes('@') ? arg.split('@')[1] : undefined }))
const unknown = asked.filter(({ kit }) => !registry[kit]).map(({ kit }) => kit)
if (!asked.length || unknown.length || (lockAt >= 0 && !args[lockAt + 1])) {
  console.error(unknown.length ? `kits/modules.json has no kit ${unknown.join(', ')}` : 'usage: node scripts/pin-kits.mjs <kit>[@<version>]... | --all [--dry-run] [--lock <file>]')
  process.exit(2)
}
const entries = {}
let failed = 0
for (const { kit, version } of asked) {
  try {
    const { registry: from, entry, missing } = await pinKit(kit, version, list, { scope })
    entries[kit] = entry
    const platforms = Object.keys(entry.platforms)
    console.error(`${kit}: ${scope} ${entry.version} from ${from}, commit ${entry.commit}; editor ${entry.editor.size} bytes, platforms ${platforms.join(', ') || 'none'}`)
    if (missing.length) console.error(`${kit}: npm has no headless package of ${entry.version} for ${missing.join(', ')}; left out`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    failed += 1
  }
}
if (dryRun) {
  console.log(JSON.stringify(entries, null, 2))
  console.error(`dry run: ${Object.keys(entries).length} kit(s) pinned, nothing written${failed ? `; ${failed} failed` : ''}`)
  process.exit(failed ? 1 : 0)
}
writeKitLockFile(lockFile, entries)
console.log(`pinned ${Object.keys(entries).length} kit(s) in ${lockFile.startsWith(`${repoRoot}${path.sep}`) ? path.relative(repoRoot, lockFile) : lockFile}${failed ? `; ${failed} failed` : ''}`)
try {
  readKitLockFile(lockFile)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  failed += 1
}
process.exit(failed ? 1 : 0)
