#!/usr/bin/env node
/**
 * Ratchet for knip findings (unused files, exports, types, dependencies).
 *
 * knip has no built-in baseline, so this script runs it with the JSON
 * reporter and compares the result with tooling/knip.baseline.json:
 *
 *   node scripts/check-knip-baseline.mjs           # fail on findings not in the baseline
 *   node scripts/check-knip-baseline.mjs --update  # rewrite the baseline from the current state
 *
 * Findings that disappear are reported so the baseline can shrink; findings
 * that appear fail the check. The baseline may only ever get smaller.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = resolve(repositoryDir, 'tooling/knip.baseline.json')
const update = process.argv.includes('--update')

const ISSUE_TYPES = ['dependencies', 'devDependencies', 'optionalPeerDependencies', 'unlisted', 'binaries', 'unresolved', 'exports', 'types', 'duplicates']

function runKnip() {
  const result = spawnSync('npx', ['knip', '--config', 'tooling/knip.json', '--reporter', 'json', '--no-exit-code'], {
    cwd: repositoryDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  const jsonStart = result.stdout.indexOf('{')
  if (jsonStart < 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error('knip produced no JSON output')
  }
  return JSON.parse(result.stdout.slice(jsonStart))
}

/** Flatten the knip report into stable "kind file symbol" keys. */
function toKeys(report) {
  const keys = new Set()
  for (const file of report.files ?? []) keys.add(`file ${file}`)
  for (const issue of report.issues ?? []) {
    for (const type of ISSUE_TYPES) {
      for (const entry of issue[type] ?? []) {
        const name = Array.isArray(entry) ? entry.map((item) => item.name).join('+') : entry.name
        keys.add(`${type} ${issue.file} ${name}`)
      }
    }
  }
  return [...keys].sort()
}

const current = toKeys(runKnip())

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`[knip-baseline] wrote ${current.length} entries to tooling/knip.baseline.json`)
  process.exit(0)
}

const baseline = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')))
const currentSet = new Set(current)
const added = current.filter((key) => !baseline.has(key))
const fixed = [...baseline].filter((key) => !currentSet.has(key))

if (fixed.length > 0) {
  console.log(`[knip-baseline] ${fixed.length} baseline entries are fixed; run with --update to shrink the baseline:`)
  for (const key of fixed.slice(0, 20)) console.log(`  - ${key}`)
}

if (added.length > 0) {
  console.error(`[knip-baseline] ${added.length} new unused-code findings (not in baseline):`)
  for (const key of added) console.error(`  + ${key}`)
  console.error('Remove the unused code or dependency. Do not add entries to the baseline.')
  process.exit(1)
}

console.log(`[knip-baseline] OK: ${current.length} known findings, nothing new.`)
