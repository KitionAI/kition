import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { checkFiles, formatProblem, generatedCallers, readGithubFiles } from './check-workflows.mjs'

type Problem = { file: string; line: number; message: string }

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repositoryDir, 'scripts', 'check-workflows.mjs')
// The kit-checkout action as it was pushed on 2026-11-21: the `ref` input's description is a
// plain scalar holding ": ", which is not valid YAML, so GitHub could not load the action and every
// kit's build, Rust and test jobs failed.
const incidentAction = readFileSync(join(repositoryDir, 'scripts/lib/fixtures/check-workflows/kit-checkout-unquoted-colon.action.yml'), 'utf8')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const ACTION = `name: Check out
description: Checks out a kit.
inputs:
  kit:
    description: The kit's name
    required: true
  cache:
    description: Cache the store
    default: 'true'
runs:
  using: composite
  steps:
    - name: Check out the kit
      uses: actions/checkout@v7
      with:
        path: kition-\${{ inputs.kit }}
    - name: Say which
      if: inputs.cache == 'true'
      shell: bash
      run: echo "\${{ inputs.kit }}"
`

const REUSABLE = `name: Reusable
on:
  workflow_call:
    inputs:
      kit:
        description: The kit
        required: true
        type: string
      ref:
        description: The commit
        required: false
        type: string
        default: ''
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Check out
        uses: KitionAI/kition/.github/actions/checkout@main
        with:
          kit: \${{ inputs.kit }}
      - run: echo "\${{ inputs.ref }}"
`

const CALLER = `name: CI
on:
  push:
jobs:
  ci:
    uses: KitionAI/kition/.github/workflows/reusable.yml@main
    with:
      kit: html
`

function repo(overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    '.github/actions/checkout/action.yml': ACTION,
    '.github/workflows/reusable.yml': REUSABLE,
  }
  for (const [file, text] of Object.entries(overrides)) {
    if (text === undefined) delete files[file]
    else files[file] = text
  }
  return files
}

function check(files: Record<string, string>, callers: Record<string, string> = {}): string[] {
  return (checkFiles({ files, callers }) as Problem[]).map(formatProblem)
}

describe('check-workflows', () => {
  it('passes this repository: its workflows, its actions and the callers it writes for kits and runner pools', () => {
    const problems = checkFiles({ files: readGithubFiles(repositoryDir), callers: generatedCallers() }) as Problem[]
    expect(problems.map(formatProblem)).toEqual([])
    expect(Object.keys(generatedCallers())).toHaveLength(32)
  })

  it('catches the 2026-11-21 failure: an unquoted ": " in an input description, and every job that uses the action', () => {
    const files = { ...readGithubFiles(repositoryDir), '.github/actions/kit-checkout/action.yml': incidentAction }
    const problems = check(files)
    expect(problems[0]).toBe(
      '.github/actions/kit-checkout/action.yml:18: invalid YAML (BLOCK_AS_IMPLICIT_KEY): Nested mappings are not allowed in compact mappings. A plain (unquoted) value holds ": "; quote it or make it a folded scalar (>-)',
    )
    const users = problems.slice(1)
    expect(users.length).toBeGreaterThanOrEqual(3)
    for (const problem of users) {
      expect(problem).toMatch(/^\.github\/workflows\/kit-ci\.yml:\d+: job `(build|rust|test)` step 1 \(Check out\) uses \.github\/actions\/kit-checkout, which is not valid YAML, so GitHub cannot load it$/)
    }
  })

  it('the command exits 1 on the 2026-11-21 action and names the file and line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-workflows-'))
    roots.push(root)
    await mkdir(join(root, '.github/actions/kit-checkout'), { recursive: true })
    await writeFile(join(root, '.github/actions/kit-checkout/action.yml'), incidentAction)
    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('.github/actions/kit-checkout/action.yml:18: invalid YAML (BLOCK_AS_IMPLICIT_KEY)')
  })

  it('accepts the small valid repository the other cases change', () => {
    expect(check(repo(), { caller: CALLER })).toEqual([])
  })

  it('rejects a duplicate key', () => {
    const problems = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace('name: Check out\n', 'name: Check out\nname: Again\n') }))
    expect(problems[0]).toMatch(/^\.github\/actions\/checkout\/action\.yml:2: invalid YAML \(DUPLICATE_KEY\)/)
  })

  it('rejects a tab, in the indentation or anywhere else', () => {
    const indented = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('jobs:\n  build:', 'jobs:\n\tbuild:') }))
    expect(indented).toContain('.github/workflows/reusable.yml:15: tab character: indent and separate with spaces only')
    expect(indented.some((problem) => problem.includes('invalid YAML (TAB_AS_INDENT)'))).toBe(true)
    const inValue = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace("description: The kit's name", "description: \"The kit's\tname\"") }))
    expect(inValue).toContain('.github/actions/checkout/action.yml:5: tab character: indent and separate with spaces only')
  })

  it('an action needs a name, a description and runs.using: composite', () => {
    const problems = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace('name: Check out\ndescription: Checks out a kit.\n', '').replace('using: composite', 'using: node24') }))
    expect(problems).toContain('.github/actions/checkout/action.yml:1: an action needs `name`, a string')
    expect(problems).toContain('.github/actions/checkout/action.yml:1: an action needs `description`, a string')
    expect(problems).toContain('.github/actions/checkout/action.yml:9: an action here is a composite action: `runs.using: composite`')
  })

  it('a composite step with run needs shell', () => {
    const problems = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace('      shell: bash\n', '') }))
    expect(problems).toEqual(['.github/actions/checkout/action.yml:17: step 2 (Say which) has `run` but no `shell` (a composite action\'s run steps need one)'])
  })

  it('every action input has a description, and it is a string', () => {
    const missing = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace("    description: The kit's name\n", '') }))
    expect(missing).toEqual(['.github/actions/checkout/action.yml:5: input `kit` needs `description`, a string'])
    const notString = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace("description: The kit's name", 'description: [kit]') }))
    expect(notString).toEqual(['.github/actions/checkout/action.yml:5: input `kit` needs `description`, a string'])
  })

  it('an action reads only the inputs it declares', () => {
    const problems = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace('echo "${{ inputs.kit }}"', 'echo "${{ inputs.kits }}"') }))
    expect(problems).toEqual(['.github/actions/checkout/action.yml:20: reads `inputs.kits`, which the action does not declare'])
    const inCondition = check(repo({ '.github/actions/checkout/action.yml': ACTION.replace("if: inputs.cache == 'true'", "if: inputs.caching == 'true'") }))
    expect(inCondition).toEqual(['.github/actions/checkout/action.yml:18: reads `inputs.caching`, which the action does not declare'])
  })

  it('a workflow uses an action that exists', () => {
    const problems = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('actions/checkout@main', 'actions/check-out@main') }))
    expect(problems).toEqual(['.github/workflows/reusable.yml:19: job `build` step 1 (Check out) uses .github/actions/check-out, which does not exist'])
    const local = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('KitionAI/kition/.github/actions/checkout@main', './.github/actions/gone') }))
    expect(local).toEqual(['.github/workflows/reusable.yml:19: job `build` step 1 (Check out) uses .github/actions/gone, which does not exist'])
  })

  it('a workflow passes every required input of an action and no undeclared one', () => {
    const missing = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('          kit: ${{ inputs.kit }}\n', '          cache: \'false\'\n') }))
    expect(missing).toEqual(['.github/workflows/reusable.yml:21: does not pass `kit`, which .github/actions/checkout requires'])
    const extra = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('          kit: ${{ inputs.kit }}\n', '          kit: ${{ inputs.kit }}\n          pnpm-cache: \'false\'\n') }))
    expect(extra).toEqual(['.github/workflows/reusable.yml:22: passes `pnpm-cache`, which .github/actions/checkout does not declare (its inputs: kit, cache)'])
  })

  it('a workflow reads only the inputs it declares', () => {
    const problems = check(repo({ '.github/workflows/reusable.yml': REUSABLE.replace('echo "${{ inputs.ref }}"', 'echo "${{ inputs.sha }}"') }))
    expect(problems).toEqual(['.github/workflows/reusable.yml:22: reads `inputs.sha`, which the workflow does not declare'])
  })

  it('a caller of the reusable workflow passes only declared inputs and every required one', () => {
    const extra = check(repo(), { caller: CALLER.replace('kit: html', 'kit: html\n      sha: abc') })
    expect(extra).toEqual(['caller:9: passes `sha`, which .github/workflows/reusable.yml does not declare (its inputs: kit, ref)'])
    const missing = check(repo(), { caller: CALLER.replace('kit: html', 'ref: abc') })
    expect(missing).toEqual(['caller:8: does not pass `kit`, which .github/workflows/reusable.yml requires'])
    const gone = check(repo(), { caller: CALLER.replace('reusable.yml', 'kit-ci.yml') })
    expect(gone).toEqual(['caller:6: job `ci` calls .github/workflows/kit-ci.yml, which does not exist'])
    const nothing = check(repo(), { caller: CALLER.replace('KitionAI/kition/.github/workflows/reusable.yml@main', 'octo/other/.github/workflows/x.yml@main') })
    expect(nothing).toEqual(['caller:1: calls no reusable workflow of KitionAI/kition, so there is nothing to check'])
  })

  it('the callers this repository writes are checked against kit-ci.yml: a renamed input fails every one', () => {
    const files = readGithubFiles(repositoryDir)
    const renamed = files['.github/workflows/kit-ci.yml'].replace('      kit:\n        description:', '      kit_name:\n        description:')
    const problems = check({ ...files, '.github/workflows/kit-ci.yml': renamed }, generatedCallers())
    const callers = problems.filter((problem) => problem.includes('passes `kit`, which .github/workflows/kit-ci.yml does not declare'))
    expect(callers).toHaveLength(32)
  })
})
