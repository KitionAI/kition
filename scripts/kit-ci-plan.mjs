#!/usr/bin/env node
// Lists a kit's CI test jobs for .github/workflows/kit-ci.yml: one job per test script (`test` and
// `test:*`) of each package folder that has a pnpm lockfile, `web/` and the repository root.
//
//   node scripts/kit-ci-plan.mjs <kit checkout> [--github-output]
//
// Skipped: `test:ci` and `test:ci:full` (a kit's own all-in-one runners) and any script that only
// chains other scripts (`pnpm a && pnpm b`), whose parts are jobs of their own. A web script's job
// is named after the script; a root script's job is `root/<script>`.
//
// The kit may add `.github/kit-ci.json`: `exclude` (job names that cannot run on a hosted runner)
// and `maxParallel` (test jobs at once; default 6, which keeps one kit's run at 8 jobs with
// build and rust). With --github-output the result is printed as `matrix=`, `max_parallel=` and
// `xtask=` lines for $GITHUB_OUTPUT; without it, as JSON.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP = new Set(['test:ci', 'test:ci:full'])
const CHAIN = /^\s*pnpm(?:\s+-s)?(?:\s+run)?\s+[\w:.-]+(?:\s*&&\s*pnpm(?:\s+-s)?(?:\s+run)?\s+[\w:.-]+)*\s*$/
const DEFAULT_MAX_PARALLEL = 6

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

export function planKit(repo) {
  const configFile = path.join(repo, '.github', 'kit-ci.json')
  const config = fs.existsSync(configFile) ? readJson(configFile) : {}
  const exclude = new Set(config.exclude ?? [])
  const include = []
  const seen = new Set()
  for (const dir of ['.', 'web']) {
    const folder = path.join(repo, dir)
    if (!fs.existsSync(path.join(folder, 'package.json')) || !fs.existsSync(path.join(folder, 'pnpm-lock.yaml'))) continue
    const scripts = readJson(path.join(folder, 'package.json')).scripts ?? {}
    for (const [script, command] of Object.entries(scripts)) {
      if (script !== 'test' && !script.startsWith('test:')) continue
      if (SKIP.has(script) || CHAIN.test(command)) continue
      const name = dir === '.' ? `root/${script}` : script
      seen.add(name)
      if (exclude.has(name)) continue
      include.push({ dir, script, name, slug: name.replace(/[^\w.-]+/g, '-') })
    }
  }
  const unknown = [...exclude].filter((name) => !seen.has(name))
  if (unknown.length) throw new Error(`.github/kit-ci.json excludes jobs that do not exist: ${unknown.join(', ')}`)
  return {
    include,
    maxParallel: config.maxParallel ?? DEFAULT_MAX_PARALLEL,
    xtask: fs.existsSync(path.join(repo, 'tools', 'xtask')),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, flag] = process.argv.slice(2)
  if (!repo) {
    console.error('usage: node scripts/kit-ci-plan.mjs <kit checkout> [--github-output]')
    process.exit(2)
  }
  try {
    const plan = planKit(path.resolve(repo))
    if (flag === '--github-output') {
      console.log(`matrix=${JSON.stringify({ include: plan.include })}`)
      console.log(`max_parallel=${plan.maxParallel}`)
      console.log(`xtask=${plan.xtask}`)
    } else {
      console.log(JSON.stringify(plan, null, 2))
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
