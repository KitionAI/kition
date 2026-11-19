#!/usr/bin/env node
// The decisions and files of a kit's `package-v<version>` Release (scripts/lib/kitReleaseAssets.mjs;
// docs/kits.md, section 4b) for .github/workflows/kit-package.yml and scripts/package-kit.sh. It
// never calls GitHub: the workflow lists the Release's assets (`gh release view --json assets`)
// into a file and passes it with --assets.
//
//   node scripts/kit-release-assets.mjs plan --kit <kit> --version <v> [--assets <file>]
//       What the run publishes, as `key=value` lines for $GITHUB_OUTPUT: tag, package
//       (publish|published), platforms and matrix (JSON) of the headless archives the Release
//       lacks, fragment (publish|published). Without --assets there is no Release yet.
//   node scripts/kit-release-assets.mjs pack --kit <kit> --platform <p> --dir <folder> --out <folder>
//       Checks a platform's build folder (kit.json, kition-<kit>, handshakes.json) and writes
//       kition-<kit>-<version>-<platform>.tar.gz in --out.
//   node scripts/kit-release-assets.mjs publish-plan --kit <kit> --version <v> --assets <file> --built <folder> --wanted <json>
//       JSON: the built archives to upload (not in the Release), those kept as published, and the
//       wanted platforms that produced no archive.
//   node scripts/kit-release-assets.mjs fragment --kit <kit> --version <v> --archives <folder> --base-url <url> --out <file> [--sdk <kition-sdk>]
//       Writes the index fragment of the headless archives in --archives; with --sdk, checks it
//       against that checkout's schemas/kits-index.schema.json.
//   node scripts/kit-release-assets.mjs compare --kit <kit> --version <v> --archives <folder> --published <fragment>
//       Prints the platforms whose archive is in --archives but not in the published fragment.
//
// --assets is a file of asset names, one per line.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fragmentFromArchives, fragmentPlatforms, headlessMatrix, packHeadless, publishPlan, releasePlan, archivePlatform } from './lib/kitReleaseAssets.mjs'

const [command, ...args] = process.argv.slice(2)
const flag = (name, required = true) => {
  const at = args.indexOf(name)
  const value = at >= 0 ? args[at + 1] : undefined
  if (required && (value === undefined || value.startsWith('--'))) throw new Error(`${command} needs ${name}`)
  return value
}
const readAssets = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

async function schemaCheck(fragment, sdk) {
  // kition-sdk's own checker of its index schema, so the fragment is checked exactly as an index is.
  const { schemaProblems } = await import(pathToFileURL(path.resolve(sdk, 'tools', 'kits-index.mjs')).href)
  const schema = JSON.parse(fs.readFileSync(path.resolve(sdk, 'schemas', 'kits-index.schema.json'), 'utf8'))
  const problems = schemaProblems(fragment, schema)
  if (problems.length) throw new Error(`the index fragment is not a kit index (kition-sdk schemas/kits-index.schema.json):\n  ${problems.join('\n  ')}`)
}

async function main() {
  switch (command) {
    case 'plan': {
      const assetsFile = flag('--assets', false)
      const plan = releasePlan(flag('--kit'), flag('--version'), assetsFile ? readAssets(assetsFile) : null)
      const lines = [`tag=${plan.tag}`, `package=${plan.package}`, `platforms=${JSON.stringify(plan.platforms)}`, `matrix=${JSON.stringify(headlessMatrix(plan.platforms))}`, `fragment=${plan.fragment}`]
      process.stdout.write(`${lines.join('\n')}\n`)
      return
    }
    case 'pack': {
      const packed = packHeadless(flag('--kit'), flag('--platform'), path.resolve(flag('--dir')), path.resolve(flag('--out')))
      process.stdout.write(`${JSON.stringify(packed, null, 2)}\n`)
      return
    }
    case 'publish-plan': {
      const built = fs.readdirSync(flag('--built')).filter((name) => fs.statSync(path.join(flag('--built'), name)).isFile())
      const plan = publishPlan(flag('--kit'), flag('--version'), readAssets(flag('--assets')), built, JSON.parse(flag('--wanted')))
      process.stdout.write(`${JSON.stringify(plan)}\n`)
      return
    }
    case 'fragment': {
      const kit = flag('--kit')
      const version = flag('--version')
      const fragment = fragmentFromArchives(kit, version, flag('--archives'), flag('--base-url'))
      const sdk = flag('--sdk', false)
      if (sdk) await schemaCheck(fragment, sdk)
      fs.mkdirSync(path.dirname(path.resolve(flag('--out'))), { recursive: true })
      fs.writeFileSync(flag('--out'), `${JSON.stringify(fragment, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify(fragment, null, 2)}\n`)
      return
    }
    case 'compare': {
      const kit = flag('--kit')
      const version = flag('--version')
      const listed = fragmentPlatforms(JSON.parse(fs.readFileSync(flag('--published'), 'utf8')), kit, version)
      const present = fs.readdirSync(flag('--archives')).map((name) => archivePlatform(kit, version, name)).filter(Boolean).sort()
      process.stdout.write(`${present.filter((platform) => !listed.includes(platform)).join(' ')}\n`)
      return
    }
    default:
      process.stderr.write('usage: kit-release-assets.mjs plan|pack|publish-plan|fragment|compare ... (see the header of scripts/kit-release-assets.mjs)\n')
      process.exit(2)
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`kit-release-assets: ${error.message}\n`)
  process.exit(1)
}
