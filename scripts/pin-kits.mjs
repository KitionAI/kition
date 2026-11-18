#!/usr/bin/env node
// Pins published kit packages in kits/kits.lock.json (docs/kits.md, section 4b).
//
//   node scripts/pin-kits.mjs board cad   pin these kits
//   node scripts/pin-kits.mjs --all       pin every kit in kits/modules.json
//
// For each kit it reads `version` from kit.json on the main branch of the kit's repository, and
// downloads that version's `package-v<version>` Release, which the kit's Package workflow made:
// the package, kition-<kit>-<version>.tgz, and its lock entry, kition-<kit>-<version>.json. The
// entry is written to the lock once the package's size and SHA-256 match it. It needs only gh.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { kitLockEntry, writeKitLock } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'modules.json'), 'utf8'))

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} exited with ${result.status}`)
  return result.stdout
}

function pin(kit) {
  const { repository } = registry[kit]
  const manifest = JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repository}/contents/kit.json?ref=main`]))
  const { version } = manifest
  const tag = `package-v${version}`
  const asset = `kition-${kit}-${version}.tgz`
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kition-pin-${kit}-`))
  try {
    gh(['release', 'download', tag, '--repo', repository, '--pattern', asset, '--pattern', `kition-${kit}-${version}.json`, '--dir', scratch])
    const bytes = fs.readFileSync(path.join(scratch, asset))
    const metadata = JSON.parse(fs.readFileSync(path.join(scratch, `kition-${kit}-${version}.json`), 'utf8'))
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const entry = kitLockEntry(kit, { repository, version }, metadata, { size: bytes.length, sha256 })
    console.log(`${kit}: ${tag}, ${entry.size} bytes, commit ${entry.commit}`)
    return entry
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const kits = args.includes('--all') ? Object.keys(registry) : args
const unknown = kits.filter((kit) => !registry[kit])
if (!kits.length || unknown.length) {
  console.error(unknown.length ? `kits/modules.json has no kit ${unknown.join(', ')}` : 'usage: node scripts/pin-kits.mjs <kit>... | --all')
  process.exit(2)
}
const entries = {}
let failed = 0
for (const kit of kits) {
  try {
    entries[kit] = pin(kit)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    failed += 1
  }
}
writeKitLock(repoRoot, entries)
console.log(`pinned ${Object.keys(entries).length} kit(s) in kits/kits.lock.json${failed ? `; ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
