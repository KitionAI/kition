#!/usr/bin/env node
// The decisions and checks of a kit repository's Package workflow (.github/workflows/kit-package.yml;
// scripts/lib/kitPackageBuild.mjs; docs/kits.md, section 4b), which publishes a kit version's npm
// packages. kition-sdk's tools/kit-npm-package.mjs writes, packs and compares the packages.
//
//   node scripts/kit-package-build.mjs plan --kit <kit> --version <v> --commit <sha> --missing <file> --registry <url>
//       What the run builds, as `key=value` lines for $GITHUB_OUTPUT: version, ui (publish|published),
//       platforms and matrix (JSON) of the headless packages to build, build (true|false). --missing
//       is what `kit-npm-package.mjs missing` printed; the packages of that version the registry
//       has are read from it, and must have been built from --commit.
//   node scripts/kit-package-build.mjs check --kit <kit> --platform <p> --dir <folder>
//       Checks a platform's build folder (kit.json, kition-<kit>, handshakes.json) before it is packaged.
//   node scripts/kit-package-build.mjs publish-plan --kit <kit> --version <v> --platforms <json> --ui <true|false> --packed <file>
//       JSON { publish, failed }: the tarballs to publish, in order, and the wanted packages that
//       built none. --packed holds one line per tarball, as `kit-npm-package.mjs pack` printed it.
import fs from 'node:fs'
import path from 'node:path'
import { checkHeadlessBuild, planFromRegistry, planOutput, publishPlan } from './lib/kitPackageBuild.mjs'

const [command, ...args] = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  const value = at >= 0 ? args[at + 1] : undefined
  if (value === undefined || value.startsWith('--')) throw new Error(`${command} needs ${name}`)
  return value
}

async function main() {
  switch (command) {
    case 'plan': {
      const missing = JSON.parse(fs.readFileSync(flag('--missing'), 'utf8'))
      const plan = await planFromRegistry({ kit: flag('--kit'), version: flag('--version'), commit: flag('--commit'), missing, registry: flag('--registry') })
      process.stdout.write(`${planOutput(plan)}\n`)
      return
    }
    case 'check': {
      process.stdout.write(`${JSON.stringify(checkHeadlessBuild(flag('--kit'), flag('--platform'), path.resolve(flag('--dir'))))}\n`)
      return
    }
    case 'publish-plan': {
      const ui = flag('--ui')
      if (ui !== 'true' && ui !== 'false') throw new Error(`--ui is true or false, not ${ui}`)
      const packed = fs
        .readFileSync(flag('--packed'), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
      process.stdout.write(`${JSON.stringify(publishPlan({ kit: flag('--kit'), version: flag('--version'), wanted: { platforms: JSON.parse(flag('--platforms')), ui: ui === 'true' }, packed }))}\n`)
      return
    }
    default:
      process.stderr.write('usage: kit-package-build.mjs plan|check|publish-plan ... (see the header of scripts/kit-package-build.mjs)\n')
      process.exit(2)
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`kit-package-build: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
