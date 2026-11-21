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
//   node scripts/kit-package-build.mjs wait --outcomes <file> --registry <url> --minutes <n>
//       After every publish returned: asks the registry every 30 seconds, for at most <n> minutes,
//       until it shows every package of --outcomes (one JSON line per tarball: file, name, version,
//       outcome published|present|refused) with its bytes. Prints a status line per check and, when
//       GITHUB_STEP_SUMMARY is set, a line per package to it. Exits 1 naming the packages still
//       pending at the limit, or a package the registry holds with other bytes.
import fs from 'node:fs'
import path from 'node:path'
import { checkHeadlessBuild, pendingMessage, planFromRegistry, planOutput, publishPlan, publishSummary, waitUntilVisible } from './lib/kitPackageBuild.mjs'
import { integrityOf } from './lib/kitNpm.mjs'

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
    case 'wait': {
      const limit = Number(flag('--minutes'))
      if (!Number.isFinite(limit) || limit < 0) throw new Error(`--minutes is a number of minutes, not ${flag('--minutes')}`)
      const limitMs = limit * 60_000
      const registry = flag('--registry')
      const packages = fs
        .readFileSync(flag('--outcomes'), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const { file, name, version, outcome } = JSON.parse(line)
          return { name, version, outcome, integrity: integrityOf(fs.readFileSync(file)) }
        })
      const result = await waitUntilVisible({ packages, registry, limitMs, log: (line) => process.stdout.write(`${line}\n`) })
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${publishSummary(result, limitMs).join('\n')}\n`)
      if (result.pending.length) throw new Error(pendingMessage({ pending: result.pending, registry, limitMs }))
      return
    }
    default:
      process.stderr.write('usage: kit-package-build.mjs plan|check|publish-plan|wait ... (see the header of scripts/kit-package-build.mjs)\n')
      process.exit(2)
  }
}

try {
  await main()
} catch (error) {
  // On GitHub as an error annotation, which the run's summary shows.
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''
  process.stderr.write(`${prefix}kit-package-build: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
