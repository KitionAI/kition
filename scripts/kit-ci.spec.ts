import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/kit-ci.sh against a fake `gh` and a fake git: which run of HEAD it reads, how it reports
// a text-only run, how `push --full` starts the full run, and how it uses runner pools.
// KIT_CI_SH runs the specs against another copy of the script (with its siblings next to it).

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const SLUG = 'KitionAI/kition-demo'
const BASE = '1111111111111111111111111111111111111111'
const SCRIPT = process.env.KIT_CI_SH ?? join(__dirname, 'kit-ci.sh')

type Job = { name: string; status: string; conclusion: string | null; steps?: unknown[] }
type Run = {
  databaseId: number
  event: string
  status: string
  conclusion: string | null
  createdAt: string
  headSha: string
  jobs: Job[]
  repo?: string
  workflow?: string
  displayTitle?: string
}
type State = {
  runs: Run[]
  onPush: Run[]
  pushDelay: number
  onDispatch: Run[]
  log: string[]
  loads?: Record<string, number>
  tested?: Record<string, { repository: string; sha: string }>
  diff?: string
}

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

// The fake gh answers the calls kit-ci.sh makes (run list, the run, its jobs, workflow run, run
// cancel, run download of the artifact tested) from the state file and applies `-q` with jq, as gh
// does. A run belongs to SLUG's ci.yml unless it names its repo and workflow. A run list without
// --commit or --workflow is a load count: state.loads[repo] runs in progress.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
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
const repoOf = (r) => r.repo ?? '${SLUG}'
const strip = ({ jobs, ...rest }) => ({ ...rest, id: rest.databaseId, display_title: rest.displayTitle ?? '' })
if (args[0] === 'run' && args[1] === 'list') {
  const repo = flag('-R')
  state.log.push(repo === '${SLUG}' ? 'run list' : \`run list \${repo}\`)
  if (state.pushDelay > 0 && state.log.includes('push')) state.pushDelay -= 1
  else if (state.log.includes('push')) { state.runs.push(...state.onPush); state.onPush = [] }
  save()
  const fields = flag('--json').split(',')
  if (!flag('--commit') && !flag('--workflow')) out(Array.from({ length: state.loads?.[repo] ?? 0 }, () => ({ status: 'in_progress' })))
  // The fixtures list runs oldest first (the API lists newest first): the script must sort.
  else out(state.runs
    .filter((r) => repoOf(r) === repo && (r.workflow ?? 'ci.yml') === (flag('--workflow') ?? 'ci.yml'))
    .filter((r) => !flag('--commit') || r.headSha === flag('--commit'))
    .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))))
} else if (args[0] === 'api') {
  const m = /^repos\\/([^/]+\\/[^/]+)\\/actions\\/runs\\/(\\d+)(\\/jobs.*)?$/.exec(args[1])
  const found = state.runs.find((r) => String(r.databaseId) === m[2] && repoOf(r) === m[1])
  if (!found) { console.error('HTTP 404'); process.exit(1) }
  out(m[3] ? { jobs: found.jobs } : strip(found))
} else if (args[0] === 'workflow' && args[1] === 'run') {
  if (flag('--ref')) state.log.push(\`dispatch \${args[2]} \${flag('-R')} \${flag('--ref')} (push run listed: \${state.onPush.length === 0})\`)
  else state.log.push(\`dispatch \${args[2]} \${flag('-R')} \${flag('-f')}\`)
  state.runs.push(...state.onDispatch)
  state.onDispatch = []
  save()
} else if (args[0] === 'run' && args[1] === 'cancel') {
  state.log.push(\`cancel \${args[2]} \${flag('-R')}\`)
  save()
} else if (args[0] === 'run' && args[1] === 'download' && flag('-n') === 'tested') {
  const proof = state.tested?.[\`\${flag('-R')}#\${args[2]}\`]
  if (!proof) { console.error('no artifact tested'); process.exit(1) }
  fs.writeFileSync(path.join(flag('-D'), 'tested.json'), JSON.stringify(proof))
} else {
  console.error('fake gh: unexpected ' + args.join(' '))
  process.exit(3)
}
`

// git diff answers state.diff (the raw, NUL-separated output of kit-ci-plan's changesBetween).
const FAKE_GIT = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2).filter((arg, i, all) => arg !== '-C' && all[i - 1] !== '-C')
if (args[0] === 'rev-parse') { console.log('${SHA}'); process.exit(0) }
const file = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
state.log.push(args[0] === 'push' ? (args.includes('--delete') ? 'push --delete' : args.at(-1).startsWith('HEAD:refs/heads/main') ? 'push main' : \`push \${args.at(-1).replace('HEAD:refs/heads/', '')}\`.replace(/ ci\\/agent$/, '')) : args[0])
fs.writeFileSync(file, JSON.stringify(state))
if (args[0] === 'merge-base') console.log('${BASE}')
if (args[0] === 'diff') process.stdout.write(state.diff ?? '')
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
    const result = spawnSync('bash', [SCRIPT, ...args], {
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
        KIT_CI_POOLS: '',
        KIT_CI_POOL: '',
        KIT_CI_BRANCH: '',
        ...env,
      },
    })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }
  return {
    root,
    sh: (...args: string[]) => kitCi({}, ...args),
    withEnv: kitCi,
    state: async (): Promise<State> => JSON.parse(await readFile(file, 'utf8')),
    runState: join(root, 'kition-demo', '.git', 'kit-ci-run.json'),
  }
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

const POOL_A = 'pool-a/kit-runner'
const POOL_B = 'pool-b/kit-runner'
const FULL_DIFF = ':100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 M\0web/src/main.ts\0'
const TEXT_DIFF = ':100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 M\0README.md\0'
const poolRun = (repo: string, databaseId: number, sha = SHA, conclusion = 'success'): Run => ({
  ...run(databaseId, 'workflow_dispatch', 3, FULL_JOBS, 'completed', conclusion),
  repo,
  workflow: 'demo.yml',
  displayTitle: `demo ${sha}`,
})

describe('kit-ci.sh with runner pools', () => {
  async function pools(state: Partial<State>, repos: string[]) {
    const kit = await setup(state)
    const file = join(kit.root, 'pools.json')
    await writeFile(file, JSON.stringify({ pools: repos.map((repo) => ({ repo })) }))
    const sh = (...args: string[]) => kit.withEnv({ KIT_CI_POOLS: file }, ...args)
    return { ...kit, sh }
  }

  it('the tracked pool list is empty, and an empty list makes exactly the calls of no list', async () => {
    expect(JSON.parse(await readFile(join(__dirname, 'kit-ci-pools.json'), 'utf8'))).toEqual({ pools: [] })
    const { sh, state } = await pools({ onPush: [run(500, 'push', 1, FULL_JOBS)], diff: FULL_DIFF }, [])
    const pushed = sh('push', 'demo')
    expect(pushed.out).toBe(`pushed ${SHA.slice(0, 12)} to ${SLUG} ci/agent\n`)
    expect((await state()).log).toEqual(['push'])
  })

  it('sends a full change to the least loaded pool, cancels the home run, and status, wait and land read the pool run', async () => {
    const { sh, state, runState } = await pools(
      {
        loads: { 'KitionAI/kition-board': 4, [SLUG]: 1, [POOL_A]: 3, [POOL_B]: 1 },
        diff: FULL_DIFF,
        onPush: [run(950, 'push', 1, FULL_JOBS, 'in_progress', null)],
        onDispatch: [poolRun(POOL_B, 77)],
        tested: { [`${POOL_B}#77`]: { repository: SLUG, sha: SHA } },
      },
      [POOL_A, POOL_B],
    )
    const pushed = sh('push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain('load: 5 queued or running runs in the KitionAI kit repositories (home, KitionAI/kition-demo)')
    expect(pushed.out).toContain(`runner pool ${POOL_B}: run 77 of abcdef012345: https://github.com/${POOL_B}/actions/runs/77`)
    expect(pushed.out).toContain(`cancelled run 950 in ${SLUG}: the pool run tests abcdef012345`)
    const log = (await state()).log
    expect(log.filter((entry) => entry.startsWith('dispatch') || entry.startsWith('cancel') || entry === 'push')).toEqual([
      'push',
      `dispatch demo.yml ${POOL_B} sha=${SHA}`,
      `cancel 950 ${SLUG}`,
    ])
    expect(JSON.parse(await readFile(runState, 'utf8'))).toMatchObject({ repo: POOL_B, kit: 'demo', sha: SHA, run: 77, workflow: 'demo.yml' })

    expect(sh('status', 'demo').out).toBe(
      `runner pool ${POOL_B} tests ${SLUG}@abcdef012345 (run 77)\nrun 77 of abcdef012345: completed success (full) https://github.com/${POOL_B}/actions/runs/77\n`,
    )
    expect(sh('wait', 'demo').out).toContain(`waiting for https://github.com/${POOL_B}/actions/runs/77\nPASSED: run 77 of abcdef012345 (full)`)
    const dry = sh('land', 'demo', '--dry-run')
    expect(dry.status).toBe(0)
    expect(dry.out).toContain(`run 77 in ${POOL_B} tested ${SLUG}@${SHA} (artifact tested)`)
    expect(dry.out).toContain(`would land abcdef012345 on ${SLUG} main (run 77 in ${POOL_B}, full); --dry-run: nothing pushed`)
    expect((await state()).log).not.toContain('push main')
    const landed = sh('land', 'demo')
    expect(landed.status).toBe(0)
    expect(landed.out).toContain(`landed abcdef012345 on ${SLUG} main (run 77 in ${POOL_B}, full)`)
    expect((await state()).log.slice(-3)).toEqual(['push main', 'push --delete', 'fetch'])
    await expect(readFile(runState, 'utf8')).rejects.toThrow()
  })

  it('stays home on a tie and then behaves as without pools', async () => {
    const { sh, state } = await pools({ diff: FULL_DIFF, onDispatch: [poolRun(POOL_A, 78)] }, [POOL_A])
    const pushed = sh('push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain(`runner: ${SLUG} (home)\npushed abcdef012345 to ${SLUG} ci/agent\n`)
    const log = (await state()).log
    expect(log).toContain(`run list ${POOL_A}`)
    expect(log.some((entry) => entry.startsWith('dispatch') || entry.startsWith('cancel'))).toBe(false)
  })

  it('keeps a text-only change at home without asking any pool', async () => {
    const { sh, state, runState } = await pools({ diff: TEXT_DIFF, loads: { [SLUG]: 9 } }, [POOL_A])
    const pushed = sh('push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain(`text-only change: the run in ${SLUG} is the text-only path (no runner pool)`)
    expect(pushed.out).toContain(`pushed abcdef012345 to ${SLUG} ci/agent`)
    expect((await state()).log).toEqual(['fetch', 'merge-base', 'diff', 'push'])
    await expect(readFile(runState, 'utf8')).rejects.toThrow()
  })

  it('push --full sends a text-only change to the least loaded pool', async () => {
    const { sh, state } = await pools(
      { diff: TEXT_DIFF, loads: { [SLUG]: 2 }, onPush: [run(951, 'push', 1, TEXT_ONLY_JOBS, 'in_progress', null)], onDispatch: [poolRun(POOL_A, 79)] },
      [POOL_A],
    )
    const pushed = sh('push', 'demo', '--full')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain(`runner pool ${POOL_A}: run 79 of abcdef012345`)
    const log = (await state()).log
    expect(log).not.toContain('diff')
    expect(log).toContain(`dispatch demo.yml ${POOL_A} sha=${SHA}`)
    expect(log).toContain(`cancel 951 ${SLUG}`)
  })

  it('KIT_CI_POOL sends the run to that pool whatever the load, and KIT_CI_BRANCH replaces ci/agent', async () => {
    const { withEnv, state } = await setup({ diff: FULL_DIFF, loads: { [POOL_B]: 9 }, onDispatch: [poolRun(POOL_B, 80)] })
    const pushed = withEnv({ KIT_CI_POOL: POOL_B, KIT_CI_BRANCH: 'ci/probe' }, 'push', 'demo')
    expect(pushed.status).toBe(0)
    expect(pushed.out).toContain(`pushed abcdef012345 to ${SLUG} ci/probe`)
    expect(pushed.out).toContain('the push started no run in')
    const log = (await state()).log
    expect(log).toContain('push ci/probe')
    expect(log).not.toContain(`run list ${POOL_A}`)
    expect(log).toContain(`dispatch demo.yml ${POOL_B} sha=${SHA}`)
  })

  it('falls back to the home runs when the recorded pool run is of another commit', async () => {
    const { sh, runState } = await pools({ runs: [run(100, 'push', 1, FULL_JOBS), poolRun(POOL_A, 81, 'f'.repeat(40))] }, [POOL_A])
    await writeFile(runState, JSON.stringify({ repo: POOL_A, kit: 'demo', sha: 'f'.repeat(40), run: 81 }))
    expect(sh('status', 'demo').out).toBe(`run 100 of abcdef012345: completed success (full) https://github.com/${SLUG}/actions/runs/100\n`)
  })

  it('land refuses a green pool run that tested another commit, another repository, or cannot prove it', async () => {
    const cases: [string, State['tested'], Run][] = [
      ['tested KitionAI/kition-demo@' + 'e'.repeat(40), { [`${POOL_A}#82`]: { repository: SLUG, sha: 'e'.repeat(40) } }, poolRun(POOL_A, 82)],
      [`tested KitionAI/kition-other@${SHA}`, { [`${POOL_A}#82`]: { repository: 'KitionAI/kition-other', sha: SHA } }, poolRun(POOL_A, 82)],
      ['tested nothing it can prove (no artifact tested)', {}, poolRun(POOL_A, 82)],
      [`is named 'demo ${'d'.repeat(40)}'`, { [`${POOL_A}#82`]: { repository: SLUG, sha: SHA } }, { ...poolRun(POOL_A, 82), displayTitle: `demo ${'d'.repeat(40)}` }],
    ]
    for (const [reason, tested, pooled] of cases) {
      const { sh, state, runState } = await pools({ runs: [pooled], tested }, [POOL_A])
      await writeFile(runState, JSON.stringify({ repo: POOL_A, kit: 'demo', sha: SHA, run: 82 }))
      const landed = sh('land', 'demo')
      expect(landed.status).toBe(1)
      expect(landed.out).toContain(`refusing to land abcdef012345: run 82 in ${POOL_A} ${reason}`)
      expect((await state()).log).not.toContain('push main')
    }
  })

  it('land refuses a pool run that has not passed', async () => {
    const { sh, runState } = await pools({ runs: [poolRun(POOL_A, 83, SHA, 'failure')] }, [POOL_A])
    await writeFile(runState, JSON.stringify({ repo: POOL_A, kit: 'demo', sha: SHA, run: 83 }))
    const landed = sh('land', 'demo')
    expect(landed.status).toBe(1)
    expect(landed.out).toContain(`refusing to land abcdef012345: its latest ci.yml run is 83 completed failure (in ${POOL_A})`)
  })
})
