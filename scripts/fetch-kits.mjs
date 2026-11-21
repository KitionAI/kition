#!/usr/bin/env node
// Downloads the kit packages pinned in kits/kits.lock.json (by scripts/pin-kits.mjs) into
// public/kits/<kit>-ui, where the build includes them (docs/kits.md, section 4b).
//
//   node scripts/fetch-kits.mjs                   fetch the packages that are missing or not the pinned ones
//   node scripts/fetch-kits.mjs --check           only compare public/kits with the lock
//   ... --lock <file>                             read another lock file
//   ... --kits-dir <dir>                          put the editor packages into <dir> instead of public/kits
//   ... --headless <dir>                          also fetch every npm pin's platform packages into <dir>/<kit>-<platform>
//
// An npm pin's editor package (in @kition `@kition/kit-<kit>-ui`, in another scope `<scope>/<kit>`:
// the pin's `scope`, scripts/lib/kitNpm.mjs) is downloaded from the first registry that serves it
// with the pinned integrity and size (scripts/lib/kitNpm.mjs `registries`: KITION_NPM_REGISTRY,
// comma-separated; ~/.npmrc's <scope>:registry; npm_config_registry or ~/.npmrc's registry;
// npmjs.org; npmmirror.com); its <kit>-ui folder replaces public/kits/<kit>-ui. A Release pin's
// asset is downloaded from the kit repository's GitHub Release and checked against its size and
// SHA-256. `--headless` downloads the headless package of each platform an npm pin names, checked
// the same way, and unpacks it (kit.json and the executable); the app ships none of them today.
//
// A fetched package gets a stamp (.kition-package.json) with what it was fetched by. A package
// without it, or with another one (a local build by scripts/build-kit-ui.sh, or another package), is
// not the pinned one even when its version matches, so it is fetched again and `--check` fails. Set
// KITION_KEEP_LOCAL_KITS=1 to keep local builds of the pinned version and commit instead.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configuredRegistries } from './lib/kitNpm.mjs'
import { fetchHeadlessPackages, fetchKitPackage, kitPackageProblem, lockForm, pinnedPackage, readKitLockFile } from './lib/kitPackages.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** The value after `flag`, resolved from the working directory, or `fallback`. */
function option(flag, fallback) {
  const at = args.indexOf(flag)
  if (at < 0) return fallback
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${flag} needs a path`)
  return path.resolve(args[at + 1])
}

async function main() {
  const lock = readKitLockFile(option('--lock', path.join(repoRoot, 'kits', 'kits.lock.json')))
  const kitsDir = option('--kits-dir', path.join(repoRoot, 'public', 'kits'))
  const headlessDir = option('--headless', null)
  const list = configuredRegistries()
  const checkOnly = args.includes('--check')
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
      const from = await fetchKitPackage(kit, pinned, kitsDir, list)
      console.log(`fetched ${kit} ${pinned.version} (${pinnedPackage(kit, pinned)}) from ${from}`)
    }
    if (headlessDir && !checkOnly) {
      if (lockForm(pinned) === 'release') {
        console.warn(`${kit}: a Release pin has no headless packages`)
        continue
      }
      for (const [platform, from] of Object.entries(await fetchHeadlessPackages(kit, pinned, headlessDir, list))) {
        console.log(`fetched ${kit} ${pinned.version} for ${platform} into ${path.join(headlessDir, `${kit}-${platform}`)} from ${from}`)
      }
    }
  }
  if (!Object.keys(lock).length) console.log('the lock pins no kits')
  return problems
}

try {
  process.exit((await main()) ? 1 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
