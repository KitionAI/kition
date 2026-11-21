#!/usr/bin/env node
// Downloads the kit packages pinned in kits/kits.lock.json (by scripts/pin-kits.mjs) into
// public/kits/<kit>-ui, where the build includes them (docs/kits.md, section 4b).
//
//   node scripts/fetch-kits.mjs          fetch the packages that are missing or not the pinned ones
//   node scripts/fetch-kits.mjs --check  only compare public/kits with the lock
//
// Each package is the npm package @kition/kit-<kit>-ui at the pinned version, downloaded from the
// first registry that serves it with the pinned integrity (scripts/lib/kitNpm.mjs `registries`:
// KITION_NPM_REGISTRY, comma-separated; ~/.npmrc's @kition:registry; npm_config_registry or
// ~/.npmrc's registry; npmjs.org; npmmirror.com). Its <kit>-ui folder replaces public/kits/<kit>-ui.
// KITION_NPM_SCOPE names another npm scope (default @kition): the lock must then pin that scope's
// packages, <scope>/<kit> (layout 1, scripts/lib/kitNpm.mjs), and ~/.npmrc's <scope>:registry is read.
//
// A fetched package gets a stamp (.kition-package.json) with its lock entry. A package without
// it, or with another one (a local build by scripts/build-kit-ui.sh, or another package), is not
// the pinned one even when its version matches, so it is fetched again and `--check` fails. Set
// KITION_KEEP_LOCAL_KITS=1 to keep local builds of the pinned version and commit instead.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredRegistries } from './lib/kitNpm.mjs'
import { fetchKitPackage, kitPackageProblem, readKitLock } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kitsDir = path.join(repoRoot, 'public', 'kits')
async function main() {
  const lock = readKitLock(repoRoot)
  const list = configuredRegistries()
  const checkOnly = process.argv.includes('--check')
  const keepLocal = process.env.KITION_KEEP_LOCAL_KITS === '1'
  let problems = 0
  for (const [kit, pinned] of Object.entries(lock)) {
    const problem = kitPackageProblem(kitsDir, kit, pinned)
    if (!problem) {
      console.log(`${kit} ${pinned.version}: up to date`)
    } else if (!checkOnly && keepLocal && !kitPackageProblem(kitsDir, kit, pinned, { stamp: false })) {
      console.warn(`${problem}; kept (KITION_KEEP_LOCAL_KITS=1)`)
    } else if (checkOnly) {
      console.error(problem)
      problems += 1
    } else {
      const registry = await fetchKitPackage(kit, pinned, kitsDir, list)
      console.log(`fetched ${kit} ${pinned.version} (${pinned.package}) from ${registry}`)
    }
  }
  if (!Object.keys(lock).length) console.log('kits/kits.lock.json pins no kits')
  return problems
}

try {
  process.exit((await main()) ? 1 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
