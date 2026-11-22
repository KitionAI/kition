import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { changesBetween, checkText, classifyChanges, isTextOnlyPath, planKit, TEXT_ONLY_SENTENCE } from './kit-ci-plan.mjs'

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
      'text_only=false',
    ])
  })
})

type Change = { status: string; path: string; oldPath?: string; oldMode?: string; newMode?: string }
const modified = (path: string): Change => ({ status: 'M', path, oldMode: '100644', newMode: '100644' })

describe('the text-only list', () => {
  it('allows Markdown at the root, directly in .github/, and under docs/', () => {
    for (const file of [
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      '.github/pull_request_template.md',
      '.github/SECURITY.md',
      'docs/development.md',
      'docs/platform/kits/ui.md',
    ]) {
      expect(isTextOnlyPath(file), file).toBe(true)
    }
  })

  it('allows .claude/, .github/ISSUE_TEMPLATE/, .github/CODEOWNERS and the root LICENSE and NOTICE', () => {
    for (const file of [
      '.claude/settings.json',
      '.claude/hooks/stop.sh',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/CODEOWNERS',
      'LICENSE',
      'LICENSE-APACHE',
      'LICENSE.md',
      'NOTICE',
      'NOTICE.txt',
    ]) {
      expect(isTextOnlyPath(file), file).toBe(true)
    }
  })

  it('refuses source, config, data, workflows, cases, the manifest and binaries', () => {
    for (const file of [
      'crates/engine/src/lib.rs',
      'web/src/main.ts',
      'web/src/App.tsx',
      'tools/check.mjs',
      'web/scripts/x.js',
      'web/src/styles.css',
      'web/index.html',
      'kit.json',
      'web/package.json',
      'features.yaml',
      '.github/kit-ci.json',
      '.github/workflows/ci.yml',
      '.github/workflows/notes.md',
      'Cargo.toml',
      'Cargo.lock',
      'web/pnpm-lock.yaml',
      'web/src/i18n/fr.tsv',
      'cases/regressions/issue-1/case.yaml',
      'docs/images/editor.png',
      'docs/attribution.toml',
      'assets/fonts/a.ttf',
      'LICENSE/extra.rs',
      'crates/x/LICENSE',
      'readme.MD',
    ]) {
      expect(isTextOnlyPath(file), file).toBe(false)
    }
  })

  it('refuses Markdown that builds and tests read', () => {
    for (const file of [
      // Cases, conformance, expected results, fixtures and test data, wherever they are.
      'cases/regressions/issue-1/notes.md',
      'cases/README.md',
      'conformance/export.md',
      'conformance/basic.md',
      'crates/view/view/fixtures/code-corpus.md',
      'crates/engine/sign/tests/data/README.md',
      'crates/x/testdata/a.md',
      'crates/x/expected/out.md',
      'docs/cases/a.md',
      'docs/expected/a.md',
      'docs/fixtures/a.md',
      'docs/tests/a.md',
      'docs/testdata/a.md',
      'docs/conformance/a.md',
      'docs/samples/a.md',
      'docs/corpus/a.md',
      // The editor's source and public files, and its test samples.
      'web/src/help/intro.md',
      'web/public/sample/README.md',
      'web/tests/samples/headings.md',
      'web/README.md',
      // Generated or checked docs: the attribution index, parity checklists, feature pages.
      'docs/attribution.md',
      'docs/parity/parity-checklist.md',
      'docs/parity/fidelity/README.md',
      'docs/features/preferences.md',
      'docs/features/effects.md',
      'docs/reference/generated/commands.md',
      // Crate and vendored-crate READMEs (doctests through include_str!), the agent's guide.
      'vendor/lopdf/README.md',
      'vendor/boa_parser/ABOUT.md',
      'crates/formats/psd/README.md',
      'bindings/wasm/README.md',
      'agent/guide.md',
      'tools/xtask/src/corpus/README.md',
      'assets/README.md',
      'examples/plugins/invert-rs/README.md',
      'corpus/affinity/SOURCES.md',
      // Anything odd.
      'plan/architecture.md',
      'docs/../web/src/a.md',
      './README.md',
    ]) {
      expect(isTextOnlyPath(file), file).toBe(false)
    }
  })

  it('takes a change of allowed files only as text-only', () => {
    expect(classifyChanges([modified('README.md'), modified('docs/development.md'), { status: 'A', path: '.github/SECURITY.md', oldMode: '000000', newMode: '100644' }, { status: 'D', path: 'docs/old.md', oldMode: '100644', newMode: '000000' }])).toEqual({
      textOnly: true,
      reason: '4 changed file(s), all on the text-only list',
    })
  })

  it('takes a mixed change as a full run, naming the file', () => {
    expect(classifyChanges([modified('README.md'), modified('crates/engine/src/lib.rs')])).toEqual({
      textOnly: false,
      reason: 'crates/engine/src/lib.rs is not on the text-only list',
    })
    expect(classifyChanges([modified('cases/regressions/issue-1/case.yaml')]).textOnly).toBe(false)
  })

  it('takes an empty change as a full run', () => {
    expect(classifyChanges([])).toEqual({ textOnly: false, reason: 'nothing changed against main' })
  })

  it('checks both sides of a rename and refuses deleting a file outside the list', () => {
    expect(classifyChanges([{ status: 'R', oldPath: 'docs/a.md', path: 'docs/b.md' }]).textOnly).toBe(true)
    expect(classifyChanges([{ status: 'R', oldPath: 'docs/a.md', path: 'conformance/a.md' }]).textOnly).toBe(false)
    expect(classifyChanges([{ status: 'R', oldPath: 'conformance/a.md', path: 'docs/a.md' }]).textOnly).toBe(false)
    expect(classifyChanges([{ status: 'D', path: 'crates/x/src/lib.rs', oldMode: '100644', newMode: '000000' }]).textOnly).toBe(false)
  })

  it('refuses symlinks, submodules and type changes', () => {
    expect(classifyChanges([{ status: 'A', path: 'README.md', oldMode: '000000', newMode: '120000' }]).textOnly).toBe(false)
    expect(classifyChanges([{ status: 'A', path: 'docs/x.md', oldMode: '000000', newMode: '160000' }]).textOnly).toBe(false)
    expect(classifyChanges([{ status: 'T', path: 'README.md', oldMode: '100644', newMode: '120000' }]).textOnly).toBe(false)
  })
})

const GIT = process.env.GIT || 'git'
const IDENTITY = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' }

function git(root: string, ...args: string[]) {
  const result = spawnSync(GIT, ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function repoWith(files: Record<string, string | Buffer>) {
  const root = await kit({ 'web/pnpm-lock.yaml': '', 'web/package.json': { scripts: { test: 'a' } }, ...files })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

async function commit(root: string, files: Record<string, string | Buffer | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(root, 'rm', '-q', path)
    else {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
      git(root, 'add', path)
    }
  }
  git(root, 'commit', '-q', '-m', 'change')
  return git(root, 'rev-parse', 'HEAD')
}

describe('the text-only path on a kit checkout', () => {
  it('reads each side of a rename and the deletions from git', async () => {
    const { root, base } = await repoWith({ 'docs/a.md': '# A\n', 'README.md': '# Kit\n', 'conformance/x.md': 'x\n' })
    git(root, 'mv', 'docs/a.md', 'conformance/a.md')
    const head = await commit(root, { 'README.md': '# Kit, reworded\n', 'conformance/x.md': null })
    const changes = changesBetween(root, base, head)
    expect(changes.map((change: Change) => `${change.status} ${change.path}`).sort()).toEqual(['A conformance/a.md', 'D conformance/x.md', 'D docs/a.md', 'M README.md'])
    expect(classifyChanges(changes).textOnly).toBe(false)
  })

  it('prints text_only=true for a README change and false for a source change or no change', async () => {
    const { root, base } = await repoWith({ 'README.md': '# Kit\n', 'src/lib.rs': '// one\n' })
    const script = join(__dirname, 'kit-ci-plan.mjs')
    const run = (...args: string[]) => spawnSync(process.execPath, [script, root, '--github-output', ...args], { encoding: 'utf8' })
    expect(run('--base', base).stdout).toContain('text_only=false')
    const text = await commit(root, { 'README.md': '# Kit, reworded\n' })
    expect(run('--base', base, '--head', text).stdout).toContain('text_only=true')
    const source = await commit(root, { 'src/lib.rs': '// two\n' })
    const result = run('--base', base, '--head', source)
    expect(result.stdout).toContain('text_only=false')
    expect(result.stderr).toContain('full run: src/lib.rs is not on the text-only list')
    const unknown = run('--base', '0'.repeat(40))
    expect(unknown.status).toBe(0)
    expect(unknown.stdout).toContain('text_only=false')
    expect(unknown.stderr).toContain('full run: cannot list the changes')
  })

  it('passes clean text and writes the summary', async () => {
    const { root, base } = await repoWith({ 'README.md': '# Kit\n' })
    const head = await commit(root, { 'README.md': '# Kit\n\nMore words.\n', 'docs/new.md': '# New\n' })
    expect(checkText(root, base, head).problems).toEqual([])
    const summary = join(root, 'summary.md')
    const result = spawnSync(process.execPath, [join(__dirname, 'kit-ci-plan.mjs'), root, '--check-text', '--base', base, '--head', head, '--summary', summary], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('  M README.md')
    expect(result.stdout).toContain('  A docs/new.md')
    expect(result.stdout).toContain(TEXT_ONLY_SENTENCE)
    expect(await readFile(summary, 'utf8')).toContain(TEXT_ONLY_SENTENCE)
  })

  it('fails on text that is not UTF-8, on conflict markers and trailing whitespace', async () => {
    const { root, base } = await repoWith({ 'README.md': '# Kit\n' })
    const head = await commit(root, {
      'docs/latin1.md': Buffer.from([0x23, 0x20, 0xe9, 0x0a]),
      'docs/nul.md': Buffer.from('a\0b\n'),
      'README.md': '# Kit\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n',
      '.github/SUPPORT.md': 'trailing   \n',
    })
    const problems = checkText(root, base, head).problems.join('\n')
    expect(problems).toContain('docs/latin1.md: not UTF-8 text')
    expect(problems).toContain('docs/nul.md: contains NUL bytes')
    expect(problems).toContain('leftover conflict marker')
    expect(problems).toContain('trailing whitespace')
    const result = spawnSync(process.execPath, [join(__dirname, 'kit-ci-plan.mjs'), root, '--check-text', '--base', base, '--head', head], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain(TEXT_ONLY_SENTENCE)
  })

  it('fails when the change is not text-only after all', async () => {
    const { root, base } = await repoWith({ 'README.md': '# Kit\n' })
    const head = await commit(root, { 'kit.json': '{}\n' })
    expect(checkText(root, base, head).problems).toEqual(['not a text-only change: kit.json is not on the text-only list'])
  })
})
