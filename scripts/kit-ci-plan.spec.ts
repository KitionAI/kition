import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { planKit } from './kit-ci-plan.mjs'

const roots: string[] = []

async function kit(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'kit-ci-plan-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('kit-ci-plan', () => {
  it('makes one job per test script in web/ and skips aggregates', async () => {
    const root = await kit({
      'web/pnpm-lock.yaml': '',
      'web/package.json': {
        scripts: {
          engine: 'sh scripts/build-engine.sh',
          test: 'node --test tests/*.test.mjs',
          'test:flow': 'node tests/flow.mjs chromium && node tests/flow.mjs webkit',
          'test:scenarios': 'pnpm test:scenarios:engine && pnpm test:scenarios:ui',
          'test:scenarios:engine': 'node --test tests/scenarios/engine.test.mjs',
          'test:scenarios:ui': 'playwright test',
          'test:ci': 'node scripts/test-ci.mjs',
          'test:ci:full': 'node scripts/test-ci.mjs --full',
        },
      },
    })
    const plan = planKit(root)
    expect(plan.include.map((job: { name: string }) => job.name)).toEqual([
      'test',
      'test:flow',
      'test:scenarios:engine',
      'test:scenarios:ui',
    ])
    expect(plan.include[1]).toEqual({ dir: 'web', script: 'test:flow', name: 'test:flow', slug: 'test-flow' })
    expect(plan.maxParallel).toBe(6)
    expect(plan.xtask).toBe(false)
  })

  it('adds root scripts as root/<script> and ignores folders without a pnpm lockfile', async () => {
    const root = await kit({
      'package.json': { scripts: { test: 'node --test tools/*.test.mjs' } },
      'pnpm-lock.yaml': '',
      'web/package.json': { scripts: { 'test:flow': 'node tests/flow.mjs' } },
    })
    expect(planKit(root).include).toEqual([{ dir: '.', script: 'test', name: 'root/test', slug: 'root-test' }])
  })

  it('applies .github/kit-ci.json and detects tools/xtask', async () => {
    const root = await kit({
      'web/pnpm-lock.yaml': '',
      'web/package.json': { scripts: { 'test:flow': 'a', 'test:collab': 'b' } },
      '.github/kit-ci.json': { exclude: ['test:collab'], maxParallel: 3 },
      'tools/xtask/Cargo.toml': '',
    })
    const plan = planKit(root)
    expect(plan.include.map((job: { name: string }) => job.name)).toEqual(['test:flow'])
    expect(plan.maxParallel).toBe(3)
    expect(plan.xtask).toBe(true)
  })

  it('refuses an exclude that names no job', async () => {
    const root = await kit({
      'web/pnpm-lock.yaml': '',
      'web/package.json': { scripts: { 'test:flow': 'a' } },
      '.github/kit-ci.json': { exclude: ['test:gone'] },
    })
    expect(() => planKit(root)).toThrow(/test:gone/)
  })

  it('prints GitHub outputs', async () => {
    const root = await kit({
      'web/pnpm-lock.yaml': '',
      'web/package.json': { scripts: { 'test:flow': 'a' } },
    })
    const result = spawnSync(process.execPath, [join(__dirname, 'kit-ci-plan.mjs'), root, '--github-output'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'matrix={"include":[{"dir":"web","script":"test:flow","name":"test:flow","slug":"test-flow"}]}',
      'max_parallel=6',
      'xtask=false',
    ])
  })
})
