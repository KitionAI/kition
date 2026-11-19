import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HEADLESS_PLATFORMS,
  buildFragment,
  fragmentFromArchives,
  headlessArchive,
  headlessMatrix,
  indexFragment,
  packHeadless,
  publishPlan,
  releaseBuildRef,
  releaseMissing,
  releasePlan,
} from './kitReleaseAssets.mjs'

const ALL = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
const CLI = path.resolve(__dirname, '..', 'kit-release-assets.mjs')
const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')

const boardKitJson = {
  id: 'kit.board',
  name: 'Board',
  version: '0.1.0',
  formats: [
    { id: 'kboard', extensions: ['kboard'], role: 'edit' },
    { id: 'png', extensions: ['.PNG'], role: 'export' },
  ],
  headless: { executable: 'kition-board', protocol: 'kition-kit/2' },
}

let work: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-release-assets-'))
})
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

/** A platform's build folder as the workflow lays it out, with the handshake it recorded. */
function buildFolder(platform: string, overrides: { kitJson?: object; answered?: object; protocolVersion?: number; recordedSha?: string } = {}) {
  const dir = path.join(work, `bin-${platform}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = platform.startsWith('win32') ? 'kition-board.exe' : 'kition-board'
  const bytes = `#!/bin/sh\necho ${platform}\n`
  fs.writeFileSync(path.join(dir, file), bytes)
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(overrides.kitJson ?? boardKitJson))
  const handshakes = {
    [file]: {
      sha256: overrides.recordedSha ?? sha256(bytes),
      protocolVersion: overrides.protocolVersion ?? 2,
      initialized: 2,
      kit: overrides.answered ?? { id: 'kit.board', version: '0.1.0' },
    },
  }
  fs.writeFileSync(path.join(dir, 'handshakes.json'), JSON.stringify(handshakes))
  return dir
}

describe('releasePlan', () => {
  it('publishes everything when the version has no Release', () => {
    expect(releasePlan('board', '0.1.0', null)).toEqual({ tag: 'package-v0.1.0', package: 'publish', platforms: ALL, fragment: 'publish' })
  })

  it('backfills a Release that has only the package: its headless archives and fragment, never the package', () => {
    expect(releasePlan('board', '0.1.0', ['kition-board-0.1.0.tgz', 'kition-board-0.1.0.json'])).toEqual({
      tag: 'package-v0.1.0',
      package: 'published',
      platforms: ALL,
      fragment: 'publish',
    })
  })

  it('adds only the platforms the Release lacks, and counts no other kit or version', () => {
    const assets = [
      'kition-board-0.1.0.tgz',
      'kition-board-0.1.0.json',
      'kition-board-0.1.0-darwin-arm64.tar.gz',
      'kition-board-0.1.0-linux-x64.tar.gz',
      'kition-board-0.1.1-win32-x64.tar.gz',
      'kition-note-0.1.0-win32-x64.tar.gz',
      'kits-index-board-0.1.0.json',
    ]
    expect(releasePlan('board', '0.1.0', assets)).toEqual({ tag: 'package-v0.1.0', package: 'published', platforms: ['darwin-x64', 'linux-arm64', 'win32-x64'], fragment: 'published' })
  })

  it('has nothing left to publish for a complete Release', () => {
    const assets = ['kition-board-0.1.0.tgz', 'kition-board-0.1.0.json', ...ALL.map((p) => headlessArchive('board', '0.1.0', p)), indexFragment('board', '0.1.0')]
    expect(releasePlan('board', '0.1.0', assets)).toMatchObject({ package: 'published', platforms: [], fragment: 'published' })
  })

  it('refuses a Release without its package rather than adding one', () => {
    expect(() => releasePlan('board', '0.1.0', ['kition-board-0.1.0.json'])).toThrow(/no kition-board-0\.1\.0\.tgz; .*never replaced/)
    expect(() => releasePlan('board', '0.1.0', [])).toThrow(/no kition-board-0\.1\.0\.tgz and kition-board-0\.1\.0\.json/)
  })

  it('refuses a kit name or version that is not one', () => {
    expect(() => releasePlan('Board', '0.1.0', null)).toThrow(/not a kit name/)
    expect(() => releasePlan('board', 'v0.1', null)).toThrow(/not a kit version/)
  })
})

describe('headlessMatrix', () => {
  it("builds on the runners and targets of kition-sdk's release, Linux against the glibc 2.17 floor", () => {
    expect(HEADLESS_PLATFORMS).toEqual([
      { platform: 'darwin-arm64', target: 'aarch64-apple-darwin', runner: 'macos-15' },
      { platform: 'darwin-x64', target: 'x86_64-apple-darwin', runner: 'macos-15-intel' },
      { platform: 'linux-arm64', target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-24.04-arm', glibc: '2.17' },
      { platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', glibc: '2.17' },
      { platform: 'win32-x64', target: 'x86_64-pc-windows-msvc', runner: 'windows-2025' },
    ])
  })

  it('keeps the platform order and refuses an unknown platform', () => {
    expect(headlessMatrix(['win32-x64', 'darwin-x64']).map((leg: { platform: string }) => leg.platform)).toEqual(['darwin-x64', 'win32-x64'])
    expect(headlessMatrix([])).toEqual([])
    expect(() => headlessMatrix(['linux-riscv64'])).toThrow(/no platform linux-riscv64/)
  })
})

describe('packHeadless', () => {
  it('packs kit.json and the executable at the top of the archive, as kition kit install unpacks it', () => {
    const packed = packHeadless('board', 'linux-x64', buildFolder('linux-x64'), path.join(work, 'out'))
    const archive = path.join(work, 'out', 'kition-board-0.1.0-linux-x64.tar.gz')
    expect(packed).toEqual({ kit: 'board', version: '0.1.0', platform: 'linux-x64', protocol: 'kition-kit/2', file: 'kition-board-0.1.0-linux-x64.tar.gz', size: fs.statSync(archive).size, sha256: sha256(fs.readFileSync(archive)) })
    expect(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean)).toEqual(['kit.json', 'kition-board'])
    const unpacked = path.join(work, 'unpacked')
    fs.mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', archive, '-C', unpacked])
    expect(fs.statSync(path.join(unpacked, 'kition-board')).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(unpacked, 'kit.json')).mode & 0o777).toBe(0o644)
    expect(JSON.parse(fs.readFileSync(path.join(unpacked, 'kit.json'), 'utf8'))).toEqual(boardKitJson)
    expect(fs.readdirSync(path.join(work, 'out'))).toEqual(['kition-board-0.1.0-linux-x64.tar.gz'])
  })

  it('packs the .exe on Windows', () => {
    packHeadless('board', 'win32-x64', buildFolder('win32-x64'), path.join(work, 'out'))
    expect(execFileSync('tar', ['-tzf', path.join(work, 'out', 'kition-board-0.1.0-win32-x64.tar.gz')], { encoding: 'utf8' }).split('\n').filter(Boolean)).toEqual(['kit.json', 'kition-board.exe'])
  })

  it('refuses an executable that did not answer kit.initialize with its kit.json version', () => {
    expect(() => packHeadless('board', 'linux-x64', buildFolder('linux-x64', { answered: { id: 'kit.board', version: '0.0.9' } }), work)).toThrow(/answers kit\.initialize as kit\.board 0\.0\.9; its kit\.json is kit\.board 0\.1\.0/)
  })

  it('refuses an executable that is not the file whose handshake was recorded', () => {
    expect(() => packHeadless('board', 'linux-x64', buildFolder('linux-x64', { recordedSha: 'f'.repeat(64) }), work)).toThrow(/not the file its handshake was recorded for/)
  })

  it('refuses a protocol other than the one kit.json names, and a kit.json of another kit or executable', () => {
    expect(() => packHeadless('board', 'linux-x64', buildFolder('linux-x64', { protocolVersion: 3 }), work)).toThrow(/speaks kition-kit\/3; its kit\.json says kition-kit\/2/)
    fs.rmSync(path.join(work, 'bin-linux-x64'), { recursive: true })
    expect(() => packHeadless('board', 'linux-x64', buildFolder('linux-x64', { kitJson: { ...boardKitJson, headless: { executable: 'board', protocol: 'kition-kit/2' } } }), work)).toThrow(/headless\.executable is board, not kition-board/)
    fs.rmSync(path.join(work, 'bin-linux-x64'), { recursive: true })
    expect(() => packHeadless('board', 'linux-x64', buildFolder('linux-x64', { kitJson: { ...boardKitJson, id: 'kit.note' } }), work)).toThrow(/its id is kit\.note, not kit\.board/)
  })

  it('refuses a folder without the recorded handshake', () => {
    const dir = buildFolder('darwin-arm64')
    fs.rmSync(path.join(dir, 'handshakes.json'))
    expect(() => packHeadless('board', 'darwin-arm64', dir, work)).toThrow(/no handshakes\.json/)
  })
})

describe('index fragment', () => {
  const base = 'https://github.com/KitionAI/kition-board/releases/download/package-v0.1.0'

  it('is a kit index with this kit version only, each archive at its address in the Release', () => {
    const fragment = buildFragment(boardKitJson, [
      { platform: 'win32-x64', size: 7, sha256: 'b'.repeat(64) },
      { platform: 'darwin-arm64', size: 5, sha256: 'a'.repeat(64) },
    ], `${base}/`)
    expect(fragment).toEqual({
      schemaVersion: 1,
      kits: {
        board: {
          id: 'kit.board',
          name: 'Board',
          extensions: ['kboard'],
          versions: {
            '0.1.0': {
              protocol: 'kition-kit/2',
              platforms: {
                'darwin-arm64': { url: `${base}/kition-board-0.1.0-darwin-arm64.tar.gz`, size: 5, sha256: 'a'.repeat(64) },
                'win32-x64': { url: `${base}/kition-board-0.1.0-win32-x64.tar.gz`, size: 7, sha256: 'b'.repeat(64) },
              },
            },
          },
        },
      },
    })
    expect(Object.keys(fragment.kits.board.versions['0.1.0'].platforms)).toEqual(['darwin-arm64', 'win32-x64'])
  })

  it('refuses no archive, a repeated platform, and a kit that edits no file type', () => {
    expect(() => buildFragment(boardKitJson, [], base)).toThrow(/no headless archive/)
    expect(() => buildFragment(boardKitJson, [{ platform: 'linux-x64', size: 1, sha256: 'a'.repeat(64) }, { platform: 'linux-x64', size: 1, sha256: 'a'.repeat(64) }], base)).toThrow(/two archives for linux-x64/)
    expect(() => buildFragment({ ...boardKitJson, formats: [{ id: 'png', extensions: ['png'], role: 'export' }] }, [{ platform: 'linux-x64', size: 1, sha256: 'a'.repeat(64) }], base)).toThrow(/edits no file type/)
  })

  it("states the size and SHA-256 of the archives as they are, with the kit.json they carry", () => {
    const released = path.join(work, 'released')
    for (const platform of ['linux-x64', 'darwin-arm64']) packHeadless('board', platform, buildFolder(platform), released)
    fs.writeFileSync(path.join(released, 'kition-board-0.1.0.tgz'), 'the package')
    const fragment = fragmentFromArchives('board', '0.1.0', released, base)
    const platforms = fragment.kits.board.versions['0.1.0'].platforms
    expect(Object.keys(platforms)).toEqual(['darwin-arm64', 'linux-x64'])
    for (const platform of ['darwin-arm64', 'linux-x64']) {
      const bytes = fs.readFileSync(path.join(released, `kition-board-0.1.0-${platform}.tar.gz`))
      expect(platforms[platform]).toEqual({ url: `${base}/kition-board-0.1.0-${platform}.tar.gz`, size: bytes.length, sha256: sha256(bytes) })
    }
  })

  it('refuses archives whose kit.json differ', () => {
    const released = path.join(work, 'released')
    packHeadless('board', 'linux-x64', buildFolder('linux-x64'), released)
    packHeadless('board', 'darwin-arm64', buildFolder('darwin-arm64', { kitJson: { ...boardKitJson, name: 'Whiteboard' } }), released)
    expect(() => fragmentFromArchives('board', '0.1.0', released, base)).toThrow(/kit\.json in kition-board-0\.1\.0-linux-x64\.tar\.gz differs/)
  })
})

describe('publishPlan', () => {
  const built = ['kition-board-0.1.0-darwin-arm64.tar.gz', 'kition-board-0.1.0-linux-x64.tar.gz', 'kition-board-0.1.0-win32-x64.tar.gz']

  it('uploads only what the Release lacks, keeps what it has, and names the platforms that built nothing', () => {
    const assets = ['kition-board-0.1.0.tgz', 'kition-board-0.1.0.json', 'kition-board-0.1.0-linux-x64.tar.gz']
    expect(publishPlan('board', '0.1.0', assets, built, ALL)).toEqual({
      upload: ['kition-board-0.1.0-darwin-arm64.tar.gz', 'kition-board-0.1.0-win32-x64.tar.gz'],
      kept: ['kition-board-0.1.0-linux-x64.tar.gz'],
      failed: ['darwin-x64', 'linux-arm64'],
    })
  })

  it('counts as failed only the platforms the run set out to build', () => {
    expect(publishPlan('board', '0.1.0', [], built, ['linux-x64', 'win32-x64']).failed).toEqual([])
  })

  it('refuses a built file that is not a headless archive of this kit version', () => {
    expect(() => publishPlan('board', '0.1.0', [], [...built, 'kition-board-0.1.0.tgz'], ALL)).toThrow(/not headless archives of board 0\.1\.0: kition-board-0\.1\.0\.tgz/)
  })
})

const runCli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
const planLines = (stdout: string) => Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)))
const PACKAGE = ['kition-board-0.1.0.tgz', 'kition-board-0.1.0.json']
const ARCHIVES = ALL.map((p) => headlessArchive('board', '0.1.0', p))
const RUN = '1'.repeat(40)
const TARGET = '2'.repeat(40)
const TAG = '3'.repeat(40)

// Regression (regressions/issue-kit-release-immutable): on a repository with GitHub's immutable
// releases, a published Release can never gain an asset, so the package job used to publish the
// Release before the headless archives existed and every upload after it failed (HTTP 422). A new
// version's Release is now a draft until the last job finds every asset in it.
describe('draft and immutable Releases', () => {
  it('fills a draft the package job made: its archives and fragment, never its package', () => {
    expect(releasePlan('board', '0.1.0', PACKAGE, { draft: true })).toEqual({ tag: 'package-v0.1.0', package: 'published', platforms: ALL, fragment: 'publish' })
    expect(releasePlan('board', '0.1.0', [...PACKAGE, ARCHIVES[0], ARCHIVES[3]], { draft: true, immutable: true })).toMatchObject({ package: 'published', platforms: ['darwin-x64', 'linux-arm64', 'win32-x64'], fragment: 'publish' })
  })

  it('counts as built the platforms whose archive an earlier attempt put into the draft', () => {
    const draft = [...PACKAGE, ARCHIVES[0], ARCHIVES[1], ARCHIVES[2], ARCHIVES[3]]
    expect(publishPlan('board', '0.1.0', draft, [ARCHIVES[4]], ALL)).toEqual({ upload: [ARCHIVES[4]], kept: [], failed: [] })
    expect(publishPlan('board', '0.1.0', draft, [], ALL).failed).toEqual(['win32-x64'])
  })

  it('makes the package again for a draft that lacks one of its package files: nobody has seen a draft', () => {
    expect(releasePlan('board', '0.1.0', [], { draft: true })).toMatchObject({ package: 'publish', platforms: ALL })
    expect(releasePlan('board', '0.1.0', ['kition-board-0.1.0.tgz', ARCHIVES[4]], { draft: true })).toMatchObject({ package: 'publish', platforms: ALL.slice(0, 4) })
  })

  it('refuses a published immutable Release that lacks an archive or the fragment, before anything is built', () => {
    expect(() => releasePlan('board', '0.1.0', PACKAGE, { immutable: true })).toThrow(/the package-v0\.1\.0 Release is immutable and cannot gain assets \(it lacks kition-board-0\.1\.0-darwin-arm64\.tar\.gz, .*kits-index-board-0\.1\.0\.json\): bump version in the kit's kit\.json/)
    expect(() => releasePlan('board', '0.1.0', [...PACKAGE, ...ARCHIVES], { immutable: true })).toThrow(/immutable and cannot gain assets \(it lacks kits-index-board-0\.1\.0\.json\)/)
  })

  it('has nothing to do for a complete published immutable Release, and backfills a published mutable one', () => {
    expect(releasePlan('board', '0.1.0', [...PACKAGE, ...ARCHIVES, indexFragment('board', '0.1.0')], { immutable: true })).toMatchObject({ package: 'published', platforms: [], fragment: 'published' })
    expect(releasePlan('board', '0.1.0', PACKAGE, { immutable: false })).toMatchObject({ package: 'published', platforms: ALL, fragment: 'publish' })
  })

  it('names what a Release lacks before its draft may be published', () => {
    expect(releaseMissing('board', '0.1.0', [...PACKAGE, ...ARCHIVES, indexFragment('board', '0.1.0'), 'kition-note-0.1.0.tgz'])).toEqual([])
    expect(releaseMissing('board', '0.1.0', [PACKAGE[0], ARCHIVES[1], ARCHIVES[2], ARCHIVES[3]])).toEqual(['kition-board-0.1.0.json', ARCHIVES[0], ARCHIVES[4], 'kits-index-board-0.1.0.json'])
  })

  it("builds a new version from the run's commit and a draft from the commit it targets", () => {
    expect(releaseBuildRef({ release: 'none', run: RUN })).toBe(RUN)
    expect(releaseBuildRef({ release: 'draft', run: RUN, target: TARGET })).toBe(TARGET)
    expect(releaseBuildRef({ release: 'draft', run: RUN, target: TARGET, lock: TARGET })).toBe(TARGET)
    expect(() => releaseBuildRef({ release: 'draft', run: RUN, target: 'main' })).toThrow(/the draft Release targets main, not a commit/)
    expect(() => releaseBuildRef({ release: 'draft', run: RUN, target: TARGET, lock: TAG })).toThrow(/lock entry was built from 3{40}; the Release targets 2{40}/)
  })

  it('plans a draft and refuses a published immutable Release from the command line', () => {
    const assets = path.join(work, 'assets.txt')
    fs.writeFileSync(assets, `${PACKAGE.join('\n')}\n`)
    const draft = runCli('plan', '--kit', 'board', '--version', '0.1.0', '--assets', assets, '--draft', '--immutable')
    expect(draft.status).toBe(0)
    expect(planLines(draft.stdout)).toMatchObject({ release: 'draft', package: 'published', fragment: 'publish', platforms: JSON.stringify(ALL) })
    expect(planLines(runCli('plan', '--kit', 'board', '--version', '0.1.0').stdout)).toMatchObject({ release: 'none', package: 'publish' })
    expect(planLines(runCli('plan', '--kit', 'board', '--version', '0.1.0', '--assets', assets).stdout)).toMatchObject({ release: 'published', package: 'published' })
    const immutable = runCli('plan', '--kit', 'board', '--version', '0.1.0', '--assets', assets, '--immutable')
    expect(immutable.status).toBe(1)
    expect(immutable.stderr).toMatch(/immutable and cannot gain assets .*bump version/)
    expect(immutable.stdout).toBe('')
    const missing = runCli('missing', '--kit', 'board', '--version', '0.1.0', '--assets', assets)
    expect(missing.status).toBe(0)
    expect(missing.stdout.trim().split(' ')).toEqual([...ARCHIVES, 'kits-index-board-0.1.0.json'])
  })
})

// Regression (regressions/issue-kit-release-tgz-only): kition-html's package-v0.1.0 Release has its
// .tgz and no lock entry (.json), and the plan refused it although the .json was only read for the
// commit to build from. A released version is built from its tag's commit.
describe('a published Release with only the package .tgz', () => {
  it('gains its headless archives and fragment, and its package files stay as they are', () => {
    expect(releasePlan('board', '0.1.0', ['kition-board-0.1.0.tgz'])).toEqual({ tag: 'package-v0.1.0', package: 'published', platforms: ALL, fragment: 'publish' })
    expect(releaseMissing('board', '0.1.0', ['kition-board-0.1.0.tgz', ...ARCHIVES, indexFragment('board', '0.1.0')])).toEqual(['kition-board-0.1.0.json'])
  })

  it("is built from its tag's commit, which the lock entry must agree with when there is one", () => {
    expect(releaseBuildRef({ release: 'published', run: RUN, tagCommit: TAG })).toBe(TAG)
    expect(releaseBuildRef({ release: 'published', run: RUN, tagCommit: TAG, lock: TAG })).toBe(TAG)
    expect(() => releaseBuildRef({ release: 'published', run: RUN, tagCommit: TAG, lock: TARGET })).toThrow(/lock entry was built from 2{40}; the Release's tag is at 3{40}/)
    expect(() => releaseBuildRef({ release: 'published', run: RUN })).toThrow(/needs the commit of the published Release's tag/)
  })

  it('prints the build ref from the command line, reading the lock entry when given', () => {
    const lock = path.join(work, 'lock-entry.json')
    fs.writeFileSync(lock, JSON.stringify({ commit: TAG }))
    const ok = runCli('ref', '--release', 'published', '--run', RUN, '--tag-commit', TAG, '--lock-entry', lock)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe(`${TAG}\n`)
    expect(runCli('ref', '--release', 'published', '--run', RUN, '--tag-commit', TAG).stdout).toBe(`${TAG}\n`)
    const differs = runCli('ref', '--release', 'published', '--run', RUN, '--tag-commit', TARGET, '--lock-entry', lock)
    expect(differs.status).toBe(1)
    expect(differs.stderr).toMatch(/lock entry was built from 3{40}/)
  })
})

describe('kit-release-assets.mjs', () => {
  const run = runCli

  it('writes the plan as $GITHUB_OUTPUT lines', () => {
    const assets = path.join(work, 'assets.txt')
    fs.writeFileSync(assets, 'kition-board-0.1.0.tgz\nkition-board-0.1.0.json\nkition-board-0.1.0-darwin-arm64.tar.gz\n')
    const result = run('plan', '--kit', 'board', '--version', '0.1.0', '--assets', assets)
    expect(result.status).toBe(0)
    const lines = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)))
    expect(lines.tag).toBe('package-v0.1.0')
    expect(lines.package).toBe('published')
    expect(JSON.parse(lines.platforms)).toEqual(ALL.slice(1))
    expect(JSON.parse(lines.matrix)).toEqual(HEADLESS_PLATFORMS.slice(1))
    expect(lines.fragment).toBe('publish')
  })

  it("fails the fragment that kition-sdk's index checker refuses", () => {
    const released = path.join(work, 'released')
    packHeadless('board', 'linux-x64', buildFolder('linux-x64'), released)
    const sdk = path.join(work, 'sdk')
    fs.mkdirSync(path.join(sdk, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(sdk, 'schemas'))
    fs.writeFileSync(path.join(sdk, 'schemas', 'kits-index.schema.json'), '{}')
    fs.writeFileSync(path.join(sdk, 'tools', 'kits-index.mjs'), 'export const schemaProblems = (value) => (value.schemaVersion === 1 ? ["/kits/board: refused by the fake checker"] : [])\n')
    const out = path.join(work, 'fragment', 'kits-index-board-0.1.0.json')
    const result = run('fragment', '--kit', 'board', '--version', '0.1.0', '--archives', released, '--base-url', '.', '--out', out, '--sdk', sdk)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/not a kit index .*\n {2}\/kits\/board: refused by the fake checker/)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('names the platforms a published fragment lacks', () => {
    const released = path.join(work, 'released')
    for (const platform of ['linux-x64', 'win32-x64']) packHeadless('board', platform, buildFolder(platform), released)
    const published = path.join(work, 'published.json')
    fs.writeFileSync(published, JSON.stringify(buildFragment(boardKitJson, [{ platform: 'linux-x64', size: 1, sha256: 'a'.repeat(64) }], '.')))
    const result = run('compare', '--kit', 'board', '--version', '0.1.0', '--archives', released, '--published', published)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('win32-x64')
  })
})
