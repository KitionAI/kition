#!/usr/bin/env node
// Pins Kition to one release of Kition Tessera: the one npm package `@kition/tessera` (subpaths
// /tokens, /icons, /ui), built from the public KitionAI/kition-tessera repository, at one exact
// version. Until its first release under @kition, Kition installs a rehearsal copy by alias
// (`npm:@kitionstage/tessera@<version>`), so the code imports the final name. See
// docs/kition-ui-development.md, Kition Tessera.
//
//   node scripts/pin-tessera.mjs <version>                     pin @kition/tessera to <version> (exact, for example 0.1.0); then pnpm install
//   node scripts/pin-tessera.mjs npm:<scope>/tessera@<version>  pin it to a rehearsal copy; then pnpm install
//   node scripts/pin-tessera.mjs --check                       fail unless it names one exact version, and no old Tessera package is left
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim()
const file = path.join(repo, 'package.json')
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const VERSION = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?'
const SPEC = new RegExp(`^(?:${VERSION}|npm:@[a-z0-9][a-z0-9-]*/tessera@${VERSION})$`)
// Tessera's three packages before they became @kition/tessera.
const OLD = ['@kition/tessera-tokens', '@kition/tessera-icons', '@kition/tessera-ui']
const sections = () => [manifest.dependencies, manifest.devDependencies, manifest.pnpm?.overrides].filter(Boolean)
const arg = process.argv[2]
if (arg === '--check') {
  const spec = manifest.dependencies?.['@kition/tessera']
  const old = OLD.filter((name) => sections().some((section) => name in section))
  if (!SPEC.test(spec ?? '') || old.length) {
    const problems = [...(SPEC.test(spec ?? '') ? [] : [`@kition/tessera is ${spec === undefined ? 'missing' : `not one exact version: ${spec}`}`]), ...old.map((name) => `${name} is still named`)]
    console.error(`FAIL Kition Tessera: ${problems.join('; ')}; run node scripts/pin-tessera.mjs <version>`)
    process.exit(1)
  }
  console.log(`PASS Kition Tessera pinned to ${spec}`)
} else if (SPEC.test(arg ?? '')) {
  manifest.dependencies['@kition/tessera'] = arg
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`pinned Kition Tessera to ${arg}; run pnpm install`)
} else {
  console.error('usage: node scripts/pin-tessera.mjs <version> | npm:<scope>/tessera@<version> | --check')
  process.exit(2)
}
