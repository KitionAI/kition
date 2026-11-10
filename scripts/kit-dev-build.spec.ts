import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain Node script without type declarations.
import { buildKits, checkoutFingerprint } from './kit-dev-build.mjs'

type Part = { kit: string; part: string; built: boolean; reason?: string }

const roots: string[] = []

function git(repo: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

async function repoWith(path: string, file: string, text: string) {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q')
  await commit(path, file, text)
}

async function commit(repo: string, file: string, text: string) {
  await writeFile(join(repo, file), text)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', text)
}

/** A Kition checkout beside a kit, kition-sdk, and kition-tessera; builders that only make outputs. */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'kition-kit-dev-'))
  roots.push(base)
  const root = join(base, 'kition')
  const kit = join(base, 'kition-sheet')
  await mkdir(root)
  await repoWith(kit, 'lib.rs', 'one')
  await repoWith(join(base, 'kition-sdk'), 'sdk.ts', 'one')
  await repoWith(join(base, 'kition-tessera'), 'ui.ts', 'one')
  await writeFile(join(kit, '.gitignore'), 'target/\n')
  git(kit, 'add', '.gitignore')
  git(kit, 'commit', '-q', '-m', 'ignore')
  let builds = 0
  const builders = {
    package: () => {
      builds += 1
      const out = join(root, 'public', 'kits', 'sheet-ui')
      spawnSync('mkdir', ['-p', out])
      spawnSync('sh', ['-c', `printf '{}' > "${out}/kit-ui.json"; printf '{"local":true,"builtAt":"build-${builds}"}' > "${out}/.kition-package.json"`])
    },
    binary: () => {
      const binary = join(kit, 'target', 'debug', 'kition-sheet')
      spawnSync('mkdir', ['-p', dirname(binary)])
      spawnSync('sh', ['-c', `printf 'binary' > "${binary}"`])
    },
  }
  const run = (cache: boolean): Part[] => buildKits({ root, kits: [{ name: 'sheet', repo: '../kition-sheet' }], cache, builders, log: () => {} })
  const built = (parts: Part[]) => parts.filter((part) => part.built).map((part) => part.part)
  return { base, root, kit, run, built }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('kit-dev-build', () => {
  it('builds every part the first time and skips them while nothing changed', async () => {
    const { run, built } = await setup()
    expect(built(run(true))).toEqual(['package', 'executable'])
    expect(built(run(true))).toEqual([])
  })

  it('records the commit and where the package and executable are', async () => {
    const { root, kit, run } = await setup()
    run(true)
    const record = JSON.parse(await readFile(join(root, 'target', 'kit-dev-cache.json'), 'utf8'))
    const entry = record.kits.sheet
    expect(entry.repo).toBe('../kition-sheet')
    expect(entry.package.path).toBe('public/kits/sheet-ui')
    expect(entry.executable.path).toBe('../kition-sheet/target/debug/kition-sheet')
    expect(entry.package.commit).toBe(checkoutFingerprint(kit).commit)
    expect(entry.package.dirty).toBe(false)
  })

  it('rebuilds both parts when the kit has a new commit', async () => {
    const { kit, run, built } = await setup()
    run(true)
    await commit(kit, 'lib.rs', 'two')
    const parts = run(true)
    expect(built(parts)).toEqual(['package', 'executable'])
    expect(parts[0].reason).toMatch(/^commit /)
  })

  it('rebuilds when uncommitted changes change, and not for tool caches', async () => {
    const { kit, run, built } = await setup()
    run(true)
    await writeFile(join(kit, 'lib.rs'), 'edited')
    expect(built(run(true))).toEqual(['package', 'executable'])
    expect(built(run(true))).toEqual([])
    await writeFile(join(kit, 'new.rs'), 'untracked')
    expect(built(run(true))).toEqual(['package', 'executable'])
    await mkdir(join(kit, '.vite', 'deps'), { recursive: true })
    await writeFile(join(kit, '.vite', 'deps', '_metadata.json'), '{}')
    expect(built(run(true))).toEqual([])
  })

  it('rebuilds nothing when the changes it was built with are committed', async () => {
    const { kit, run, built } = await setup()
    await writeFile(join(kit, 'lib.rs'), 'edited')
    await writeFile(join(kit, 'new.rs'), 'untracked')
    expect(built(run(true))).toEqual(['package', 'executable'])
    git(kit, 'add', 'lib.rs', 'new.rs')
    git(kit, 'commit', '-q', '-m', 'edited')
    expect(checkoutFingerprint(kit).dirty).toBe(false)
    expect(built(run(true))).toEqual([])
  })

  it('leaves the checkout index alone', async () => {
    const { kit, run } = await setup()
    await writeFile(join(kit, 'new.rs'), 'untracked')
    run(true)
    const status = spawnSync('git', ['-C', kit, 'status', '--porcelain'], { encoding: 'utf8' }).stdout
    expect(status).toBe('?? new.rs\n')
  })

  it('rebuilds only the package when kition-sdk or kition-tessera changes', async () => {
    const { base, run, built } = await setup()
    run(true)
    await commit(join(base, 'kition-sdk'), 'sdk.ts', 'two')
    expect(built(run(true))).toEqual(['package'])
    await writeFile(join(base, 'kition-tessera', 'ui.ts'), 'edited')
    expect(built(run(true))).toEqual(['package'])
  })

  it('rebuilds a part whose output is gone or was replaced', async () => {
    const { root, kit, run, built } = await setup()
    run(true)
    await writeFile(join(root, 'public', 'kits', 'sheet-ui', '.kition-package.json'), '{"version":"0.4.47"}')
    expect(built(run(true))).toEqual(['package'])
    const binary = join(kit, 'target', 'debug', 'kition-sheet')
    const later = new Date((await stat(binary)).mtimeMs + 5_000)
    await utimes(binary, later, later)
    expect(built(run(true))).toEqual(['executable'])
    await rm(binary)
    expect(built(run(true))).toEqual(['executable'])
  })

  it('rebuilds the executable after its build failed, though the package was built', async () => {
    const { root, kit, run, built } = await setup()
    run(true)
    await commit(kit, 'lib.rs', 'two')
    expect(() =>
      buildKits({
        root,
        kits: [{ name: 'sheet', repo: '../kition-sheet' }],
        cache: true,
        builders: {
          package: () => spawnSync('sh', ['-c', `mkdir -p "${root}/public/kits/sheet-ui"; printf '{}' > "${root}/public/kits/sheet-ui/kit-ui.json"; printf '{"local":true,"builtAt":"x"}' > "${root}/public/kits/sheet-ui/.kition-package.json"`]),
          binary: () => {
            throw new Error('cargo build failed')
          },
        },
        log: () => {},
      }),
    ).toThrow('cargo build failed')
    expect(built(run(true))).toEqual(['executable'])
  })

  it('builds every part on a full build, changed or not', async () => {
    const { run, built } = await setup()
    run(true)
    expect(built(run(false))).toEqual(['package', 'executable'])
  })

  it('refuses a kit whose checkout is missing', async () => {
    const { root } = await setup()
    expect(() => buildKits({ root, kits: [{ name: 'note', repo: '../kition-note' }], cache: true, builders: {}, log: () => {} })).toThrow(/KIT_NOTE_REPO/)
  })
})
