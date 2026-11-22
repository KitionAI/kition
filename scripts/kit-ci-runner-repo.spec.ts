import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { runnerRepoFiles, runnerWorkflow } from './kit-ci-runner-repo.mjs'
// @ts-expect-error: a plain Node script without type declarations.
import { KITS } from './kit-ci-install.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('kit-ci-runner-repo', () => {
  it('writes the html workflow: dispatched with a sha, named after it, one call of kit-ci.yml for that commit', () => {
    expect(runnerWorkflow('html')).toBe(`name: html

# Runs Kition's kit CI (KitionAI/kition .github/workflows/kit-ci.yml at main) for one commit of
# the public repository KitionAI/kition-html. Written by Kition's scripts/kit-ci-runner-repo.mjs;
# started by Kition's scripts/kit-ci.sh (gh workflow run html.yml -f sha=<commit>), which finds
# the run by its name. A newer dispatch for html cancels the older one.

on:
  workflow_dispatch:
    inputs:
      sha:
        description: The commit of KitionAI/kition-html to test (the full 40-character SHA)
        required: true
        type: string
      ref_note:
        description: A note for humans (where the commit comes from); the run does not read it
        required: false
        type: string
        default: ''

run-name: html \${{ inputs.sha }}

permissions:
  contents: read

concurrency:
  group: html
  cancel-in-progress: true

jobs:
  ci:
    uses: KitionAI/kition/.github/workflows/kit-ci.yml@main
    with:
      kit: html
      repository: KitionAI/kition-html
      ref: \${{ inputs.sha }}
`)
  })

  it('refuses a kit that does not exist', () => {
    expect(() => runnerWorkflow('nonesuch')).toThrow(/unknown kit nonesuch/)
  })

  it('writes a workflow per kit, the README and the LICENSE, the same every time', async () => {
    const out = await mkdtemp(join(tmpdir(), 'kit-ci-runner-'))
    roots.push(out)
    const script = join(__dirname, 'kit-ci-runner-repo.mjs')
    expect(spawnSync(process.execPath, [script, out], { encoding: 'utf8' }).status).toBe(0)
    const workflows = (await readdir(join(out, '.github', 'workflows'))).sort()
    expect(workflows).toEqual(KITS.map((kit: string) => `${kit}.yml`).sort())
    expect((await readdir(out)).sort()).toEqual(['.github', 'LICENSE', 'README.md'])
    const readme = await readFile(join(out, 'README.md'), 'utf8')
    expect(readme).toContain('CI runners for the public Kition kits. No source lives here')
    expect(readme).toContain('[KitionAI/kition-photo](https://github.com/KitionAI/kition-photo)')
    expect(await readFile(join(out, 'LICENSE'), 'utf8')).toBe(await readFile(join(__dirname, '..', 'LICENSE'), 'utf8'))
    const files = runnerRepoFiles()
    for (const [file, content] of Object.entries(files)) expect(await readFile(join(out, file), 'utf8')).toBe(content)
    expect(runnerRepoFiles()).toEqual(files)
  })
})
