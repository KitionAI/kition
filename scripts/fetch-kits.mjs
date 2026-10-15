#!/usr/bin/env node
// Downloads the kit packages pinned in kits/kits.lock.json into public/kits/<kit>-ui, where the
// build includes them (docs/kit-sdk.md, section 4b).
//
//   node scripts/fetch-kits.mjs          fetch the packages that are missing or not the pinned ones
//   node scripts/fetch-kits.mjs --check  only compare public/kits with the lock
//
// The packages are Release assets of the private kit repositories, downloaded with
// `gh release download`: locally with your gh login, in CI with GH_TOKEN set to a token that can
// read those repositories. Each download is checked against the pinned size and SHA-256.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { kitPackageProblem, readKitLock } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kitsDir = path.join(repoRoot, 'public', 'kits')
const lock = readKitLock(repoRoot)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function fetchKit(kit, pinned) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kition-kit-${kit}-`))
  try {
    run('gh', ['release', 'download', pinned.tag, '--repo', pinned.repository, '--pattern', pinned.asset, '--dir', scratch])
    const bytes = fs.readFileSync(path.join(scratch, pinned.asset))
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== pinned.size || sha256 !== pinned.sha256) {
      throw new Error(`${pinned.asset}: ${bytes.length} bytes, sha256 ${sha256}; the lock pins ${pinned.size} bytes, sha256 ${pinned.sha256}`)
    }
    const target = path.join(kitsDir, `${kit}-ui`)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(kitsDir, { recursive: true })
    // The archive by its bare name: GNU tar reads a drive letter in it as a remote host.
    run('tar', ['-xzf', pinned.asset, '-C', kitsDir], { cwd: scratch })
    const problem = kitPackageProblem(kitsDir, kit, pinned)
    if (problem) throw new Error(problem)
    console.log(`fetched ${kit} ${pinned.version}`)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const checkOnly = process.argv.includes('--check')
let problems = 0
for (const [kit, pinned] of Object.entries(lock)) {
  const problem = kitPackageProblem(kitsDir, kit, pinned)
  if (!problem) {
    console.log(`${kit} ${pinned.version}: up to date`)
  } else if (checkOnly) {
    console.error(problem)
    problems += 1
  } else {
    fetchKit(kit, pinned)
  }
}
if (!Object.keys(lock).length) console.log('kits/kits.lock.json pins no kits')
process.exit(problems ? 1 : 0)
