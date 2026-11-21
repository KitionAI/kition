import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_PLATFORMS, buildPlan, checkHeadlessBuild, headlessMatrix, pendingMessage, planFromRegistry, planOutput, publishPlan, publishSummary, waitUntilVisible } from './kitPackageBuild.mjs'

const ALL = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
const CLI = path.resolve(__dirname, '..', 'kit-package-build.mjs')
const RUN = '1'.repeat(40)
const OTHER = '2'.repeat(40)
const REGISTRY = 'https://registry.example.test/'
const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')

const boardKitJson = {
  id: 'kit.board',
  name: 'Board',
  version: '0.1.0',
  formats: [{ id: 'kboard', extensions: ['kboard'], role: 'edit' }],
  headless: { executable: 'kition-board', protocol: 'kition-kit/1' },
}

let work: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-package-build-'))
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
      protocolVersion: overrides.protocolVersion ?? 1,
      initialized: 1,
      kit: overrides.answered ?? { id: 'kit.board', version: '0.1.0' },
    },
  }
  fs.writeFileSync(path.join(dir, 'handshakes.json'), JSON.stringify(handshakes))
  return dir
}

/** The registry's metadata of a published package of board 0.1.0, built from `commit`. */
const published = (part: string, commit = RUN) => ({
  name: `@kition/kit-board-${part}`,
  version: '0.1.0',
  dist: { integrity: `sha512-${'A'.repeat(86)}==` },
  kition: { kit: 'board', version: '0.1.0', role: part === 'ui' ? 'ui' : 'headless', build: { commit } },
})

/** A registry that has exactly `packages` (`<name>@<version>` to metadata) and answers 404 otherwise; it records every address asked. */
function fakeRegistry(packages: Record<string, unknown>) {
  const asked: string[] = []
  const fetchImpl = async (url: string) => {
    asked.push(url)
    const match = /\/(@kition%2f[^/]+)\/([^/]+)$/.exec(url)
    const found = match && packages[`${decodeURIComponent(match[1]).replace('%2f', '/')}@${decodeURIComponent(match[2])}`]
    return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{}', { status: 404 })
  }
  return { asked, fetchImpl }
}

describe('headlessMatrix', () => {
  it("builds on the runners and targets of kition-sdk's release, Linux against the glibc 2.17 floor", () => {
    expect(headlessMatrix(ALL)).toEqual(HEADLESS_PLATFORMS)
    expect(HEADLESS_PLATFORMS.map(({ platform }) => platform)).toEqual(ALL)
    expect(headlessMatrix(['linux-x64'])).toEqual([{ platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', glibc: '2.17' }])
    expect(headlessMatrix(['win32-x64'])).toEqual([{ platform: 'win32-x64', target: 'x86_64-pc-windows-msvc', runner: 'windows-2025' }])
    expect(headlessMatrix(['darwin-arm64'])[0].glibc).toBeUndefined()
  })

  it('keeps the platform order and refuses an unknown platform', () => {
    expect(headlessMatrix(['win32-x64', 'darwin-arm64']).map(({ platform }) => platform)).toEqual(['darwin-arm64', 'win32-x64'])
    expect(() => headlessMatrix(['freebsd-x64'])).toThrow(/no platform freebsd-x64/)
  })
})

describe('buildPlan', () => {
  it('builds every package of a version npm does not have', () => {
    const plan = buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ALL, ui: true } })
    expect(plan).toEqual({ version: '0.1.0', ui: 'publish', platforms: ALL, matrix: HEADLESS_PLATFORMS, build: true })
  })

  it('builds nothing when npm has every package, whatever commit they were built from', () => {
    const all = [...ALL.map((platform) => published(platform, OTHER)), published('ui', OTHER)]
    expect(buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: [], ui: false }, published: all })).toEqual({
      version: '0.1.0',
      ui: 'published',
      platforms: [],
      matrix: [],
      build: false,
    })
  })

  it('builds only the platforms npm lacks, never the editor package it has', () => {
    const plan = buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['win32-x64', 'linux-arm64'], ui: false }, published: [published('ui'), published('darwin-arm64')] })
    expect(plan.ui).toBe('published')
    expect(plan.platforms).toEqual(['linux-arm64', 'win32-x64'])
    expect(plan.matrix.map(({ runner }) => runner)).toEqual(['ubuntu-24.04-arm', 'windows-2025'])
    expect(plan.build).toBe(true)
  })

  it('refuses to complete a version npm has in part from another commit: a version is one build', () => {
    expect(() =>
      buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['win32-x64'], ui: false }, published: [published('ui', OTHER), published('linux-x64')] }),
    ).toThrow(new RegExp(`@kition/kit-board-ui@0\\.1\\.0 \\(${OTHER}\\).*re-run the run that published them, or bump version`))
    expect(() => buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: [], ui: true }, published: [{ ...published('linux-x64'), kition: {} }] })).toThrow(/no build commit/)
  })

  it('refuses a kit name, version, commit, or missing list that is not one', () => {
    const missing = { platforms: ALL, ui: true }
    expect(() => buildPlan({ kit: 'Board', version: '0.1.0', commit: RUN, missing })).toThrow(/not a kit name/)
    expect(() => buildPlan({ kit: 'board', version: 'v0.1', commit: RUN, missing })).toThrow(/not a kit version/)
    expect(() => buildPlan({ kit: 'board', version: '0.1.0', commit: 'main', missing })).toThrow(/not a commit/)
    expect(() => buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ALL } })).toThrow(/missing must be/)
    expect(() => buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['freebsd-x64'], ui: false } })).toThrow(/no platform freebsd-x64/)
  })

  it('writes the plan as $GITHUB_OUTPUT lines', () => {
    const plan = buildPlan({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['linux-x64'], ui: true } })
    expect(planOutput(plan).split('\n')).toEqual([
      'version=0.1.0',
      'ui=publish',
      'platforms=["linux-x64"]',
      `matrix=${JSON.stringify([{ platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', glibc: '2.17' }])}`,
      'build=true',
    ])
  })
})

describe('planFromRegistry', () => {
  it('reads the metadata of the packages npm has, and checks their build commit', async () => {
    const registry = fakeRegistry({ '@kition/kit-board-ui@0.1.0': published('ui'), ...Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((platform) => [`@kition/kit-board-${platform}@0.1.0`, published(platform)])) })
    const plan = await planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['win32-x64'], ui: false }, registry: REGISTRY }, registry.fetchImpl)
    expect(plan.platforms).toEqual(['win32-x64'])
    expect(registry.asked).toEqual([
      `${REGISTRY}@kition%2fkit-board-darwin-arm64/0.1.0`,
      `${REGISTRY}@kition%2fkit-board-darwin-x64/0.1.0`,
      `${REGISTRY}@kition%2fkit-board-linux-arm64/0.1.0`,
      `${REGISTRY}@kition%2fkit-board-linux-x64/0.1.0`,
      `${REGISTRY}@kition%2fkit-board-ui/0.1.0`,
    ])
  })

  it('stops when a package npm has was built from another commit', async () => {
    const registry = fakeRegistry({ '@kition/kit-board-ui@0.1.0': published('ui', OTHER) })
    await expect(planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ALL, ui: false }, registry: REGISTRY }, registry.fetchImpl)).rejects.toThrow(/published in part, from another commit/)
  })

  it('reads nothing when nothing is missing, and refuses a package the registry no longer has', async () => {
    const empty = fakeRegistry({})
    expect((await planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: [], ui: false }, registry: REGISTRY }, empty.fetchImpl)).build).toBe(false)
    expect(empty.asked).toEqual([])
    await expect(planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['linux-x64'], ui: true }, registry: REGISTRY }, empty.fetchImpl)).rejects.toThrow(/has no @kition\/kit-board-darwin-arm64@0\.1\.0/)
  })

  it('limits the plan to the platforms a rehearsal names: the others are neither built nor expected on npm', async () => {
    const empty = fakeRegistry({})
    const plan = await planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ALL, ui: true }, registry: REGISTRY, only: ['darwin-arm64'] }, empty.fetchImpl)
    expect(plan.platforms).toEqual(['darwin-arm64'])
    expect(plan.ui).toBe('publish')
    expect(empty.asked).toEqual([])
    await expect(planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ALL, ui: true }, registry: REGISTRY, only: ['freebsd-x64'] }, empty.fetchImpl)).rejects.toThrow(/no platform freebsd-x64/)
  })

  it('fails on a registry error rather than taking it for a missing package', async () => {
    const failing = async () => new Response('busy', { status: 503 })
    await expect(planFromRegistry({ kit: 'board', version: '0.1.0', commit: RUN, missing: { platforms: ['linux-x64'], ui: false }, registry: REGISTRY }, failing)).rejects.toThrow(/HTTP 503/)
  })
})

describe('checkHeadlessBuild', () => {
  it('accepts the executable whose recorded kit.initialize answer is its kit.json id, version and protocol', () => {
    expect(checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64'))).toEqual({ kit: 'board', version: '0.1.0', platform: 'linux-x64', protocol: 'kition-kit/1', file: 'kition-board' })
    expect(checkHeadlessBuild('board', 'win32-x64', buildFolder('win32-x64')).file).toBe('kition-board.exe')
  })

  it('refuses an executable that did not answer kit.initialize with its kit.json version', () => {
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64', { answered: { id: 'kit.board', version: '0.0.9' } }))).toThrow(/answers kit\.initialize as kit\.board 0\.0\.9; its kit\.json is kit\.board 0\.1\.0/)
  })

  it('refuses an executable that is not the file whose handshake was recorded', () => {
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64', { recordedSha: 'f'.repeat(64) }))).toThrow(/not the file its handshake was recorded for/)
  })

  it('refuses a protocol other than the one kit.json names, and a kit.json of another kit or executable', () => {
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64', { protocolVersion: 3 }))).toThrow(/speaks kition-kit\/3; its kit\.json says kition-kit\/1/)
    fs.rmSync(path.join(work, 'bin-linux-x64'), { recursive: true })
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64', { kitJson: { ...boardKitJson, headless: { executable: 'board', protocol: 'kition-kit/1' } } }))).toThrow(/headless\.executable is board, not kition-board/)
    fs.rmSync(path.join(work, 'bin-linux-x64'), { recursive: true })
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('linux-x64', { kitJson: { ...boardKitJson, id: 'kit.note' } }))).toThrow(/its id is kit\.note, not kit\.board/)
  })

  it('refuses a folder without the recorded handshake, the executable, or a known platform', () => {
    const dir = buildFolder('darwin-arm64')
    fs.rmSync(path.join(dir, 'handshakes.json'))
    expect(() => checkHeadlessBuild('board', 'darwin-arm64', dir)).toThrow(/no handshakes\.json/)
    fs.rmSync(path.join(dir, 'kition-board'))
    expect(() => checkHeadlessBuild('board', 'darwin-arm64', dir)).toThrow(/has no kition-board/)
    expect(() => checkHeadlessBuild('board', 'linux-x64', buildFolder('win32-x64'))).toThrow(/has no kition-board$/)
    expect(() => checkHeadlessBuild('board', 'linux-riscv64', buildFolder('linux-x64'))).toThrow(/no platform linux-riscv64/)
  })
})

describe('publishPlan', () => {
  const tarball = (part: string, version = '0.1.0') => ({ file: `/t/kition-kit-board-${part}-${version}.tgz`, name: `@kition/kit-board-${part}`, version })

  it('publishes every built tarball, headless packages in platform order and the editor package last', () => {
    const packed = [tarball('ui'), tarball('win32-x64'), tarball('darwin-arm64')]
    expect(publishPlan({ kit: 'board', version: '0.1.0', wanted: { platforms: ['darwin-arm64', 'win32-x64'], ui: true }, packed })).toEqual({
      publish: ['/t/kition-kit-board-darwin-arm64-0.1.0.tgz', '/t/kition-kit-board-win32-x64-0.1.0.tgz', '/t/kition-kit-board-ui-0.1.0.tgz'],
      failed: [],
    })
  })

  it('names every wanted package that built nothing', () => {
    expect(publishPlan({ kit: 'board', version: '0.1.0', wanted: { platforms: ALL, ui: true }, packed: [tarball('linux-x64')] })).toEqual({
      publish: ['/t/kition-kit-board-linux-x64-0.1.0.tgz'],
      failed: ['@kition/kit-board-darwin-arm64', '@kition/kit-board-darwin-x64', '@kition/kit-board-linux-arm64', '@kition/kit-board-win32-x64', '@kition/kit-board-ui'],
    })
  })

  it('refuses a tarball of a package, kit or version the run does not publish, and two of one package', () => {
    const wanted = { platforms: ['linux-x64'], ui: false }
    expect(() => publishPlan({ kit: 'board', version: '0.1.0', wanted, packed: [tarball('ui')] })).toThrow(/@kition\/kit-board-ui@0\.1\.0, which this run does not publish/)
    expect(() => publishPlan({ kit: 'board', version: '0.1.0', wanted, packed: [tarball('linux-x64', '0.1.1')] })).toThrow(/@kition\/kit-board-linux-x64@0\.1\.1/)
    expect(() => publishPlan({ kit: 'board', version: '0.1.0', wanted, packed: [{ ...tarball('linux-x64'), name: '@kition/kit-note-linux-x64' }] })).toThrow(/kit-note-linux-x64/)
    expect(() => publishPlan({ kit: 'board', version: '0.1.0', wanted, packed: [tarball('linux-x64'), { ...tarball('linux-x64'), file: '/u/again.tgz' }] })).toThrow(/two tarballs of @kition\/kit-board-linux-x64@0\.1\.0/)
  })
})

describe('publishPlan in another npm scope (KITION_NPM_SCOPE)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("publishes the scope's packages by layout 1 and refuses @kition's", () => {
    vi.stubEnv('KITION_NPM_SCOPE', '@kitionstage')
    const stage = (part: string) => ({ file: `/t/${part}.tgz`, name: part === 'ui' ? '@kitionstage/board' : `@kitionstage/board-${part}`, version: '0.1.0' })
    expect(publishPlan({ kit: 'board', version: '0.1.0', wanted: { platforms: ['linux-x64', 'win32-x64'], ui: true }, packed: [stage('ui'), stage('linux-x64')] })).toEqual({
      publish: ['/t/linux-x64.tgz', '/t/ui.tgz'],
      failed: ['@kitionstage/board-win32-x64'],
    })
    const legacy = { file: '/t/legacy.tgz', name: '@kition/kit-board-linux-x64', version: '0.1.0' }
    expect(() => publishPlan({ kit: 'board', version: '0.1.0', wanted: { platforms: ['linux-x64'], ui: false }, packed: [legacy] })).toThrow(/which this run does not publish \(@kitionstage\/board-linux-x64@0\.1\.0\)/)
  })
})

describe('waitUntilVisible (after every publish returned)', () => {
  const VERSION = '0.1.5'
  const MIN = 60_000
  const bytesOf = (name: string) => Buffer.from(`the tarball of ${name}`)
  const integrityOf = (bytes: Buffer) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`
  const NAMES = ['@kitionstage/note-linux-x64', '@kitionstage/note-win32-x64', '@kitionstage/note']
  const entries = (outcome = 'published') => NAMES.map((name) => ({ name, version: VERSION, outcome, integrity: integrityOf(bytesOf(name)) }))

  type Shown = { metadataAt?: number; tarballAt?: number; placeholder?: boolean; integrity?: string }
  /** A fake clock (sleeping moves it) and a fake registry that shows each package from the times `shown` gives (default: at once). */
  function fakeRegistry(shown: Record<string, Shown> = {}) {
    const clock = { t: 0 }
    const sleeps: number[] = []
    const fetchImpl = async (url: string) => {
      for (const name of NAMES) {
        const at = shown[name] ?? {}
        if (url === `${REGISTRY}${name.replace('/', '%2f')}/${VERSION}`) {
          if (clock.t < (at.metadataAt ?? 0)) {
            // npm's view of a first publish it does not show yet: the placeholder, or no such version.
            return at.placeholder ? new Response(JSON.stringify({ name, version: '0.0.0-stage' })) : new Response('{"error":"version not found"}', { status: 404 })
          }
          return new Response(JSON.stringify({ name, version: VERSION, dist: { integrity: at.integrity ?? integrityOf(bytesOf(name)) }, kition: { build: { commit: RUN } } }))
        }
        if (url === `${REGISTRY}${name}/-/${name.split('/').pop()}-${VERSION}.tgz`) {
          if (clock.t < (at.tarballAt ?? at.metadataAt ?? 0)) return new Response('not found', { status: 404 })
          return new Response(bytesOf(name))
        }
      }
      return new Response('not found', { status: 404 })
    }
    const io = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock.t,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        clock.t += ms
      },
    }
    return { clock, sleeps, io }
  }

  it('ends at the first check when npm shows every package at once', async () => {
    const { sleeps, io } = fakeRegistry()
    const log: string[] = []
    const result = await waitUntilVisible({ packages: entries(), registry: REGISTRY, limitMs: 40 * MIN, log: (line: string) => log.push(line) }, io)
    expect(result.pending).toEqual([])
    expect(result.packages.map(({ afterMs }: { afterMs: number }) => afterMs)).toEqual([0, 0, 0])
    expect(sleeps).toEqual([])
    expect(log).toEqual(['[0 min] 3 of 3 shown with their bytes'])
  })

  it('asks every 30 seconds while npm shows the placeholder 0.0.0-stage, and only the packages still pending', async () => {
    const { sleeps, io } = fakeRegistry({ '@kitionstage/note': { metadataAt: 4 * 30_000, placeholder: true } })
    const log: string[] = []
    const asked: string[] = []
    const counting = { ...io, fetchImpl: (async (url: string) => (asked.push(url), io.fetchImpl(url))) as unknown as typeof fetch }
    const result = await waitUntilVisible({ packages: entries(), registry: REGISTRY, limitMs: 40 * MIN, log: (line: string) => log.push(line) }, counting)
    expect(result.pending).toEqual([])
    expect(result.packages.map(({ name, afterMs }: { name: string; afterMs: number }) => [name, afterMs])).toEqual([
      ['@kitionstage/note-linux-x64', 0],
      ['@kitionstage/note-win32-x64', 0],
      ['@kitionstage/note', 120_000],
    ])
    expect(sleeps).toEqual([30_000, 30_000, 30_000, 30_000])
    expect(log).toHaveLength(5)
    expect(log[0]).toMatch(/^\[0 min\] 2 of 3 shown with their bytes; pending: @kitionstage\/note \(.*answered 0\.0\.0-stage\)$/)
    expect(log[4]).toBe('[2 min] 3 of 3 shown with their bytes')
    // The headless packages were asked once (metadata and tarball); the editor package at every check.
    expect(asked.filter((url) => url.includes('note-linux-x64'))).toHaveLength(2)
    expect(asked.filter((url) => url.endsWith(`%2fnote/${VERSION}`))).toHaveLength(5)
  })

  it('waits for the tarball when the metadata is shown first', async () => {
    const { io } = fakeRegistry({ '@kitionstage/note-win32-x64': { metadataAt: 0, tarballAt: 60_000 } })
    const log: string[] = []
    const result = await waitUntilVisible({ packages: entries(), registry: REGISTRY, limitMs: 40 * MIN, log: (line: string) => log.push(line) }, io)
    expect(result.pending).toEqual([])
    expect(result.packages[1].afterMs).toBe(60_000)
    expect(log[0]).toMatch(/pending: @kitionstage\/note-win32-x64 \(metadata shown, tarball not yet \(.*HTTP 404/)
  })

  it('stops at the limit naming the packages npm does not show, which were published', async () => {
    const { sleeps, io } = fakeRegistry({ '@kitionstage/note': { metadataAt: Infinity } })
    const log: string[] = []
    const result = await waitUntilVisible({ packages: entries(), registry: REGISTRY, limitMs: 40 * MIN, log: (line: string) => log.push(line) }, io)
    expect(result.pending).toEqual(['@kitionstage/note'])
    expect(result.packages[2]).toMatchObject({ afterMs: null, reason: 'no such version yet (HTTP 404)' })
    // A check at 0, every 30 seconds, and the last one at the limit.
    expect(sleeps).toHaveLength(80)
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(40 * MIN)
    expect(log.at(-1)).toMatch(/^\[40 min\] 2 of 3 shown with their bytes; pending: @kitionstage\/note /)
    const message = pendingMessage({ pending: result.pending, registry: REGISTRY, limitMs: 40 * MIN })
    expect(message).toMatch(/^@kitionstage\/note WERE published .* within 40 min\./)
    expect(message).toMatch(/Re-running this job publishes nothing again/)
    expect(publishSummary(result, 40 * MIN)).toEqual([
      '- `@kitionstage/note-linux-x64@0.1.5`: published, visible after 0 min',
      '- `@kitionstage/note-win32-x64@0.1.5`: published, visible after 0 min',
      '- `@kitionstage/note@0.1.5`: published, not shown yet after 40 min',
    ])
  })

  it('stops when npm shows a version with other bytes, also one it refused to publish again', async () => {
    const other = `sha512-${'A'.repeat(86)}==`
    const { io } = fakeRegistry({ '@kitionstage/note': { integrity: other } })
    await expect(waitUntilVisible({ packages: entries(), registry: REGISTRY, limitMs: 40 * MIN }, io)).rejects.toThrow(/@kitionstage\/note@0\.1\.5 is on .* with the integrity sha512-A+==.* published once and never replaced/)
    const refused = await waitUntilVisible({ packages: entries('refused'), registry: REGISTRY, limitMs: 40 * MIN }, io).catch((error: Error) => error)
    expect(String(refused)).toMatch(/npm refused this run's publish of it/)
  })

  it('sums each package up: already there, or published and when npm showed it', async () => {
    const { io } = fakeRegistry({ '@kitionstage/note': { metadataAt: 13 * MIN } })
    const packages = [{ ...entries('present')[0] }, { ...entries('refused')[1] }, { ...entries('published')[2] }]
    const result = await waitUntilVisible({ packages, registry: REGISTRY, limitMs: 40 * MIN }, io)
    expect(publishSummary(result, 40 * MIN)).toEqual([
      '- `@kitionstage/note-linux-x64@0.1.5`: already there',
      '- `@kitionstage/note-win32-x64@0.1.5`: already published by an earlier run (npm refused a second publish), visible after 0 min',
      '- `@kitionstage/note@0.1.5`: published, visible after 13 min',
    ])
  })

  it('refuses an outcome it does not know', async () => {
    const { io } = fakeRegistry()
    await expect(waitUntilVisible({ packages: [{ ...entries()[0], outcome: 'skipped' }], registry: REGISTRY, limitMs: MIN }, io)).rejects.toThrow(/outcome "skipped"/)
  })
})

describe('kit-package-build.mjs', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

  it('waits for the packages of outcomes.jsonl and fails at the limit naming the ones pending', () => {
    const tarball = path.join(work, 'note-0.1.5.tgz')
    fs.writeFileSync(tarball, 'tarball bytes')
    const outcomes = path.join(work, 'outcomes.jsonl')
    fs.writeFileSync(outcomes, `${JSON.stringify({ file: tarball, name: '@kitionstage/note', version: '0.1.5', outcome: 'published' })}\n`)
    const summary = path.join(work, 'summary.md')
    // Nothing answers on port 9: the package stays pending, and a limit of 0 ends after one check.
    const result = spawnSync(process.execPath, [CLI, 'wait', '--outcomes', outcomes, '--registry', 'http://127.0.0.1:9/', '--minutes', '0'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^\[0 min\] 0 of 1 shown with their bytes; pending: @kitionstage\/note \(/)
    expect(result.stderr).toMatch(/@kitionstage\/note WERE published/)
    expect(fs.readFileSync(summary, 'utf8')).toBe('- `@kitionstage/note@0.1.5`: published, not shown yet after 0 min\n')
    expect(cli('wait', '--outcomes', outcomes, '--registry', 'http://127.0.0.1:9/', '--minutes', 'soon').status).toBe(1)
  })

  it('plans a version npm lacks entirely without reading the registry', () => {
    const missing = path.join(work, 'missing.json')
    fs.writeFileSync(missing, JSON.stringify({ platforms: ALL, ui: true }))
    const result = cli('plan', '--kit', 'board', '--version', '0.1.0', '--commit', RUN, '--missing', missing, '--registry', 'http://127.0.0.1:9/')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ui=publish\n')
    expect(result.stdout).toContain(`platforms=${JSON.stringify(ALL)}\n`)
    expect(result.stdout).toContain('build=true\n')
  })

  it('checks a build folder, and fails one whose handshake differs', () => {
    expect(cli('check', '--kit', 'board', '--platform', 'linux-x64', '--dir', buildFolder('linux-x64')).status).toBe(0)
    const bad = cli('check', '--kit', 'board', '--platform', 'darwin-x64', '--dir', buildFolder('darwin-x64', { protocolVersion: 3 }))
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/speaks kition-kit\/3/)
  })

  it('prints the publish plan from the lines kition-sdk pack printed', () => {
    const packed = path.join(work, 'packed.jsonl')
    fs.writeFileSync(packed, `${JSON.stringify({ file: '/t/a.tgz', name: '@kition/kit-board-linux-x64', version: '0.1.0', size: 1, integrity: 'x' })}\n`)
    const result = cli('publish-plan', '--kit', 'board', '--version', '0.1.0', '--platforms', '["linux-x64","win32-x64"]', '--ui', 'false', '--packed', packed)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ publish: ['/t/a.tgz'], failed: ['@kition/kit-board-win32-x64'] })
    expect(cli('publish-plan', '--kit', 'board', '--version', '0.1.0', '--platforms', '[]', '--ui', 'yes', '--packed', packed).status).toBe(1)
  })
})
