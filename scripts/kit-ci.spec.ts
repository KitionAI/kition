import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/kit-ci.sh against a fake `gh` and a fake git: which run of HEAD it reads, how it reports
// a text-only run, and how `push --full` starts the full run.

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const SLUG = 'KitionAI/kition-demo'

type Job = { name: string; status: string; conclusion: string | null; steps?: unknown[] }
type Run = { databaseId: number; event: string; status: string; conclusion: string | null; createdAt: string; headSha: string; jobs: Job[] }
type State = { runs: Run[]; onPush: Run[]; pushDelay: number; onDispatch: Run[]; log: string[] }

const TEXT_ONLY_JOBS: Job[] = [
  { name: 'ci / Plan', status: 'completed', conclusion: 'success' },
  { name: 'ci / Text only', status: 'completed', conclusion: 'success' },
  { name: 'ci / Build', status: 'completed', conclusion: 'skipped' },
  { name: 'ci / Rust', status: 'completed', conclusion: 'skipped' },
  { name: 'ci / ${{ matrix.name }}', status: 'completed', conclusion: 'skipped' },
]
const FULL_JOBS: Job[] = [
  { name: 'ci / Plan', status: 'completed', conclusion: 'success' },
  { name: 'ci / Text only', status: 'completed', conclusion: 'skipped' },
  { name: 'ci / Build', status: 'in_progress', conclusion: null },
  { name: 'ci / Rust', status: 'in_progress', conclusion: null },
]

const run = (databaseId: number, event: string, minute: number, jobs: Job[], status = 'completed', conclusion: string | null = 'success'): Run => ({
  databaseId,
  event,
  status,
  conclusion,
  createdAt: `2026-11-22T10:${String(minute).padStart(2, '0')}:00Z`,
  headSha: SHA,
  jobs,
})

// The fake gh answers the four calls kit-ci.sh makes (run list, the run, its jobs, workflow run)
// from the state file and applies `-q` with jq, as gh does.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const out = (value) => {
  const query = flag('-q') ?? flag('--jq')
  if (!query) return process.stdout.write(JSON.stringify(value))
  const jq = spawnSync('jq', ['-r', query], { input: JSON.stringify(value), encoding: 'utf8' })
  process.stdout.write(jq.stdout)
  process.exit(jq.status)
}
const strip = ({ jobs, ...rest }) => rest
if (args[0] === 'run' && args[1] === 'list') {
  state.log.push('run list')
  if (state.pushDelay > 0 && state.log.includes('push')) state.pushDelay -= 1
  else if (state.log.includes('push')) { state.runs.push(...state.onPush); state.onPush = [] }
  save()
  const fields = flag('--json').split(',')
  // The fixtures list runs oldest first (the API lists newest first): the script must sort.
  out(state.runs.filter((r) => r.headSha === flag('--commit')).map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))))
} else if (args[0] === 'api') {
  const m = /^repos\\/[^/]+\\/[^/]+\\/actions\\/runs\\/(\\d+)(\\/jobs.*)?$/.exec(args[1])
  const found = state.runs.find((r) => String(r.databaseId) === m[1])
  if (!found) { console.error('HTTP 404'); process.exit(1) }
  out(m[2] ? { jobs: found.jobs } : strip(found))
} else if (args[0] === 'workflow' && args[1] === 'run') {
  state.log.push(\`dispatch \${args[2]} \${flag('-R')} \${flag('--ref')} (push run listed: \${state.onPush.length === 0})\`)
  state.runs.push(...state.onDispatch)
  state.onDispatch = []
  save()
} else {
  console.error('fake gh: unexpected ' + args.join(' '))
  process.exit(3)
}
`

const FAKE_GIT = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2).filter((arg, i, all) => arg !== '-C' && all[i - 1] !== '-C')
if (args[0] === 'rev-parse') { console.log('${SHA}'); process.exit(0) }
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
state.log.push(args[0] === 'push' ? (args.includes('--delete') ? 'push --delete' : args.at(-1).startsWith('HEAD:refs/heads/main') ? 'push main' : 'push') : args[0])
fs.writeFileSync(file, JSON.stringify(state))
`

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(state: Partial<State>) {
  const root = await mkdtemp(join(tmpdir(), 'kit-ci-sh-'))
  roots.push(root)
  await mkdir(join(root, 'kition-demo', '.git'), { recursive: true })
  await mkdir(join(root, 'kition-demo', '.github', 'workflows'), { recursive: true })
  await writeFile(join(root, 'kition-demo', '.github', 'workflows', 'ci.yml'), 'name: CI\n')
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'gh'), FAKE_GH)
  await writeFile(join(root, 'bin', 'git'), FAKE_GIT)
  await chmod(join(root, 'bin', 'gh'), 0o755)
  await chmod(join(root, 'bin', 'git'), 0o755)
  const file = join(root, 'state.json')
  await writeFile(file, JSON.stringify({ runs: [], onPush: [], pushDelay: 0, onDispatch: [], log: [], ...state }))
  const kitCi = (env: Record<string, string>, ...args: string[]) => {
    const result = spawnSync('bash', [join(__dirname, 'kit-ci.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        KITION_WORKSPACE: root,
        GIT: join(root, 'bin', 'git'),
        FAKE_STATE: file,
        KIT_CI_POLL: '0',
        KIT_CI_STEP: '0',
        KIT_CI_FULL: '',
        ...env,
      },
    })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }
  return { sh: (...args: string[]) => kitCi({}, ...args), withEnv: kitCi, state: async (): Promise<State> => JSON.parse(await readFile(file, 'utf8')) }
}

describe('kit-ci.sh', () => {
  it('reads the newest run of HEAD whatever order the API lists them in, and says text-only', async () => {
    const { sh } = await setup({ runs: [run(100, 'push', 1, FULL_JOBS, 'completed', 'failure'), run(200, 'push', 5, TEXT_ONLY_JOBS)] })
    expect(sh('status', 'demo').out).toBe(`run 200 of ${SHA.slice(0, 12)}: completed success (text-only: full checks skipped) https://github.com/${SLUG}/actions/runs/200\n`)
    const waited = sh('wait', 'demo')
    expect(waited.status).toBe(0)
    expect(waited.out).toContain(`PASSED: run 200 of ${SHA.slice(0, 12)} (text-only: full checks skipped)`)
  })

  it('says full for a run whose build ran, and nothing for a run it cannot classify', async () => {
    const { sh } = await setup({ runs: [run(300, 'push', 1, FULL_JOBS, 'in_progress', null)] })
    expect(sh('status', 'demo').out).toContain('run 300 of abcdef012345: in_progress null (full) https://')
    const old = await setup({ runs: [run(301, 'push', 1, [{ name: 'ci / Plan', status: 'in_progress', conclusion: null }], 'in_progress', null)] })
    expect(old.sh('status', 'demo').out).toContain('run 301 of abcdef012345: in_progress null https://')
  })

  it('lands a green text-only run and says so', async () => {
    const { sh, state } = await setup({ runs: [run(400, 'push', 1, TEXT_ONLY_JOBS)] })
    const landed = sh('land', 'demo')
    expect(landed.status).toBe(0)
    expect(landed.out).toBe(`landed ${SHA.slice(0, 12)} on ${SLUG} main (run 400, text-only: full checks skipped)\n`)
    expect((await state()).log).toEqual(['run list', 'push main', 'push --delete', 'fetch'])
  })

  it('pushes without asking GitHub anything unless --full', async () => {
    const { sh, state } = await setup({ onPush: [run(500, 'push', 1, TEXT_ONLY_JOBS)] })
    const pushed = sh('push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toBe(`pushed ${SHA.slice(0, 12)} to ${SLUG} ci/agent\n`)
    expect((await state()).log).toEqual(['push'])
  })

  it('push --full waits for the push run, and when it is text-only starts the full run, which wait then reads', async () => {
    const { sh, state } = await setup({
      runs: [run(90, 'push', 0, FULL_JOBS)],
      onPush: [run(600, 'push', 1, TEXT_ONLY_JOBS)],
      pushDelay: 2,
      onDispatch: [run(601, 'workflow_dispatch', 2, FULL_JOBS)],
    })
    const pushed = sh('push', 'demo', '--full')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain('run 600 of abcdef012345 is text-only; starting the full run by hand')
    expect(pushed.out).toContain(`full run 601 of abcdef012345: https://github.com/${SLUG}/actions/runs/601`)
    const log = (await state()).log
    expect(log.filter((entry) => !entry.startsWith('run list'))).toEqual(['push', `dispatch ci.yml ${SLUG} ci/agent (push run listed: true)`])
    expect(log.indexOf('push')).toBeLessThan(log.findIndex((entry) => entry.startsWith('dispatch')))
    expect(sh('status', 'demo').out).toContain('run 601 of abcdef012345: completed success (full)')
  })

  it('push --full starts nothing more when the push run is already full', async () => {
    const { sh, state } = await setup({ onPush: [run(700, 'push', 1, FULL_JOBS, 'in_progress', null)], onDispatch: [run(701, 'workflow_dispatch', 2, FULL_JOBS)] })
    const pushed = sh('push', 'demo', '--full')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain('run 700 of abcdef012345 is already the full run')
    expect((await state()).log.some((entry) => entry.startsWith('dispatch'))).toBe(false)
  })

  it('push --full starts the full run when the push run was cancelled before it was planned', async () => {
    const cancelled: Job[] = ['Plan', 'Build', 'Rust', 'Text only'].map((name) => ({ name: `ci / ${name}`, status: 'completed', conclusion: 'cancelled', steps: name === 'Plan' ? [{}] : [] }))
    const { sh, state } = await setup({ onPush: [run(900, 'push', 1, cancelled, 'completed', 'cancelled')], onDispatch: [run(901, 'workflow_dispatch', 2, FULL_JOBS)] })
    const pushed = sh('push', 'demo', '--full')
    expect(pushed.out).toContain('run 900 of abcdef012345 is pending; starting the full run by hand')
    expect(pushed.out).toContain('full run 901 of abcdef012345')
    expect((await state()).log.filter((entry) => entry.startsWith('dispatch'))).toHaveLength(1)
  })

  it('KIT_CI_FULL=1 does what --full does, also when the push starts no run', async () => {
    const { withEnv, state } = await setup({ onDispatch: [run(801, 'workflow_dispatch', 2, FULL_JOBS)] })
    const pushed = withEnv({ KIT_CI_FULL: '1' }, 'push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain('the push started no run of abcdef012345; starting the full run by hand')
    expect(pushed.out).toContain('full run 801 of abcdef012345')
    expect((await state()).log.filter((entry) => entry.startsWith('dispatch'))).toHaveLength(1)
  })

  it('refuses --full on other commands', async () => {
    const { sh } = await setup({})
    expect(sh('wait', 'demo', '--full').status).toBe(2)
  })
})
