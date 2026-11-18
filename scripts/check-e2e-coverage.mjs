#!/usr/bin/env node
/**
 * Every Playwright spec file must run somewhere: the CI sweep
 * (KITION_E2E_SCOPE=ci), a package.json script, a scripts/inspect-*.sh gate,
 * or the quarantine list in tooling/e2e-quarantine.json. A spec that is in
 * none of those is dead weight nobody runs; this check fails on it.
 */
import { execSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const e2eDir = resolve(repositoryDir, 'e2e')

const specFiles = readdirSync(e2eDir).filter((name) => name.endsWith('.spec.ts')).sort()

const sweep = spawnSync('npx', ['playwright', 'test', '--config', 'tooling/playwright.config.ts', '--list', '--reporter=list'], {
  cwd: repositoryDir,
  encoding: 'utf8',
  env: { ...process.env, KITION_E2E_SCOPE: 'ci' },
  maxBuffer: 64 * 1024 * 1024,
})
if (sweep.status !== 0) {
  console.error(sweep.stdout)
  console.error(sweep.stderr)
  throw new Error('playwright --list failed')
}
// The list reporter prints paths relative to testDir: "[chromium] › name.spec.ts:12:3 › title".
const sweepFiles = new Set()
for (const match of sweep.stdout.matchAll(/›\s+(?:e2e\/)?([A-Za-z0-9_.-]+\.spec\.ts):\d+/g)) sweepFiles.add(match[1])

const packageJson = JSON.parse(readFileSync(resolve(repositoryDir, 'package.json'), 'utf8'))
const scriptText = Object.values(packageJson.scripts).join('\n')
const shellText = execSync('git ls-files -- scripts', { cwd: repositoryDir, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.sh'))
  .map((file) => readFileSync(resolve(repositoryDir, file), 'utf8'))
  .join('\n')
const referenced = new Set()
for (const match of `${scriptText}\n${shellText}`.matchAll(/e2e\/([A-Za-z0-9_.-]+\.spec\.ts)/g)) referenced.add(match[1])

const quarantine = JSON.parse(readFileSync(resolve(repositoryDir, 'tooling/e2e-quarantine.json'), 'utf8'))
const quarantined = new Set(quarantine.quarantined.map((entry) => entry.spec))

const orphans = specFiles.filter((name) => !sweepFiles.has(name) && !referenced.has(name) && !quarantined.has(name))
const staleQuarantine = [...quarantined].filter((name) => !specFiles.includes(name))

console.log(`[e2e-coverage] ${specFiles.length} spec files: ${sweepFiles.size} in the CI sweep, ${referenced.size} referenced by scripts, ${quarantined.size} quarantined.`)
if (staleQuarantine.length > 0) {
  console.error(`[e2e-coverage] quarantine lists specs that no longer exist: ${staleQuarantine.join(', ')}`)
}
if (orphans.length > 0) {
  console.error('[e2e-coverage] spec files that nothing runs:')
  for (const name of orphans) console.error(`  - e2e/${name}`)
  console.error('Add the spec to the CI sweep (default), a script, or the quarantine list with a reason.')
}
process.exit(orphans.length > 0 || staleQuarantine.length > 0 ? 1 : 0)
