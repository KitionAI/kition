import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { integrityOf, tarballUrl } from './kitNpm.mjs'
import { fetchKitPackage, KIT_PACKAGE_STAMP, kitLockEntry, kitPackageProblem, pinKit, publishedKitPackageStamp, readKitLock, unpackKitPackage, writeKitLock, writeKitPackageStamp } from './kitPackages.mjs'

const A = 'https://a.example.test/'
const B = 'https://b.example.test/'
const INTEGRITY = `sha512-${'a'.repeat(86)}==`

const pinned = {
  package: '@kition/kit-slide-ui',
  version: '0.4.7',
  integrity: INTEGRITY,
  commit: '1'.repeat(40),
  sdkCommit: '2'.repeat(40),
  tesseraCommit: '3'.repeat(40),
  fontsCommit: '4'.repeat(40),
}
const build = { commit: pinned.commit, sdkCommit: pinned.sdkCommit, tesseraCommit: pinned.tesseraCommit, fontsCommit: pinned.fontsCommit }

/** The registry's metadata of @kition/kit-slide-ui at `version`, as the Package workflow publishes it. */
const metadata = (version = '0.4.7', overrides: Record<string, unknown> = {}) => ({
  name: '@kition/kit-slide-ui',
  version,
  dist: { integrity: INTEGRITY, tarball: `${A}@kition/kit-slide-ui/-/kit-slide-ui-${version}.tgz` },
  kition: { kit: 'slide', id: 'kit.slide', name: 'Slide', version, role: 'ui', protocol: 'kition-kit/2', extensions: ['kislide'], views: [], build },
  ...overrides,
})

let work: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-packages-'))
})
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

/** A fake fetch over `routes` (address to a Response maker or an Error); answers 404 otherwise. */
function fakeFetch(routes: Record<string, (() => Response) | Error>) {
  const asked: string[] = []
  const fetchImpl = async (url: string) => {
    asked.push(url)
    const route = routes[url]
    if (route instanceof Error) throw route
    return route ? route() : new Response('not found', { status: 404 })
  }
  return { asked, fetchImpl }
}

describe('kitPackageProblem', () => {
  let kitsDir: string

  beforeEach(() => {
    kitsDir = path.join(work, 'kits')
    fs.mkdirSync(path.join(kitsDir, 'slide-ui'), { recursive: true })
    fs.writeFileSync(
      path.join(kitsDir, 'slide-ui', 'kit-ui.json'),
      JSON.stringify({ kitId: 'kit.slide', version: pinned.version, commit: pinned.commit, entry: 'index.html', protocol: 'kition-kit-ui/1' }),
    )
  })

  const stamp = (value: unknown) => fs.writeFileSync(path.join(kitsDir, 'slide-ui', KIT_PACKAGE_STAMP), JSON.stringify(value))

  it('accepts a fetched package whose stamp matches the lock', () => {
    writeKitPackageStamp(kitsDir, 'slide', publishedKitPackageStamp(pinned))
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toBeNull()
  })

  it('stamps the whole lock entry', () => {
    expect(publishedKitPackageStamp({ ...pinned, extra: true })).toEqual(pinned)
  })

  it('rejects a package without a stamp', () => {
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/not a fetched package/)
  })

  it('rejects a local build of the pinned version and commit', () => {
    stamp({ local: true, kitCommit: pinned.commit, sdkCommit: pinned.sdkCommit, builtAt: '2026-01-01T00:00:00Z' })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/a local build .*, not the published @kition\/kit-slide-ui@0\.4\.7/)
  })

  it('rejects a stamp that differs from the lock', () => {
    stamp({ ...publishedKitPackageStamp(pinned), integrity: `sha512-${'b'.repeat(86)}==` })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(integrity sha512-b+== instead of sha512-a+==\)/)
    stamp({ ...publishedKitPackageStamp(pinned), sdkCommit: '5'.repeat(40) })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(sdkCommit/)
    stamp({ ...publishedKitPackageStamp(pinned), tesseraCommit: undefined })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(tesseraCommit missing/)
  })

  it('rejects the stamp of a GitHub Release asset', () => {
    stamp({ version: pinned.version, asset: 'kition-slide-0.4.7.tgz', sha256: 'a'.repeat(64), commit: pinned.commit, sdkCommit: pinned.sdkCommit })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(package missing instead of @kition\/kit-slide-ui, integrity missing/)
  })

  it('checks only kit-ui.json without the stamp check', () => {
    stamp({ local: true })
    expect(kitPackageProblem(kitsDir, 'slide', pinned, { stamp: false })).toBeNull()
    expect(kitPackageProblem(kitsDir, 'slide', { ...pinned, version: '0.4.8' }, { stamp: false })).toMatch(/0\.4\.7 .* instead of 0\.4\.8/)
  })

  it('reports a missing package', () => {
    expect(kitPackageProblem(kitsDir, 'word', pinned)).toMatch(/word: not in/)
  })
})

describe('kitLockEntry', () => {
  it("takes the registry's metadata as the lock entry, in the lock order", () => {
    const entry = kitLockEntry('slide', { extra: true, ...metadata() })
    expect(Object.keys(entry)).toEqual(['package', 'version', 'integrity', 'commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit'])
    expect(entry).toEqual(pinned)
    expect(kitLockEntry('slide', metadata(), { version: '0.4.7' })).toEqual(pinned)
  })

  it('rejects metadata of another version, kit, package or role', () => {
    expect(() => kitLockEntry('slide', metadata('0.4.8'), { version: '0.4.7' })).toThrow(/version 0\.4\.8 instead of 0\.4\.7/)
    expect(() => kitLockEntry('sheet', metadata())).toThrow(/name @kition\/kit-slide-ui instead of @kition\/kit-sheet-ui.*kition field of kit slide/)
    expect(() => kitLockEntry('slide', metadata('0.4.7', { name: '@kition/kit-slide-linux-x64' }))).toThrow(/name @kition\/kit-slide-linux-x64 instead of @kition\/kit-slide-ui/)
    expect(() => kitLockEntry('slide', metadata('0.4.7', { kition: { ...metadata().kition, role: 'headless' } }))).toThrow(/kition\.role headless instead of ui/)
    expect(() => kitLockEntry('slide', metadata('0.4.7', { kition: { ...metadata().kition, version: '0.4.6' } }))).toThrow(/kition\.version 0\.4\.6 instead of 0\.4\.7/)
  })

  it("rejects metadata without npm's integrity or without every build commit", () => {
    expect(() => kitLockEntry('slide', metadata('0.4.7', { dist: { shasum: 'a'.repeat(40) } }))).toThrow(/dist\.integrity missing/)
    expect(() => kitLockEntry('slide', metadata('0.4.7', { dist: { integrity: 'sha1-abc' } }))).toThrow(/dist\.integrity sha1-abc is not an npm integrity/)
    const { tesseraCommit: _tessera, ...withoutTessera } = build
    expect(() => kitLockEntry('slide', metadata('0.4.7', { kition: { ...metadata().kition, build: withoutTessera } }))).toThrow(/kition\.build has no valid tesseraCommit/)
    expect(() => kitLockEntry('slide', metadata('0.4.7', { kition: { ...metadata().kition, build: undefined } }))).toThrow(/no valid commit, sdkCommit, tesseraCommit, fontsCommit/)
  })
})

describe('pinKit', () => {
  it("pins the version asked for, or the registry's latest, from the first registry that has it", async () => {
    const { asked, fetchImpl } = fakeFetch({
      [`${A}@kition%2fkit-slide-ui/0.4.6`]: () => new Response('busy', { status: 503 }),
      [`${B}@kition%2fkit-slide-ui/0.4.6`]: () => new Response(JSON.stringify(metadata('0.4.6'))),
      [`${A}@kition%2fkit-slide-ui/latest`]: () => new Response(JSON.stringify(metadata('0.4.7'))),
    })
    expect(await pinKit('slide', '0.4.6', [A, B], fetchImpl)).toEqual({ registry: B, entry: { ...pinned, version: '0.4.6' } })
    expect(await pinKit('slide', undefined, [A, B], fetchImpl)).toEqual({ registry: A, entry: pinned })
    expect(asked).toEqual([`${A}@kition%2fkit-slide-ui/0.4.6`, `${B}@kition%2fkit-slide-ui/0.4.6`, `${A}@kition%2fkit-slide-ui/latest`])
  })

  it('fails when no registry has the version', async () => {
    await expect(pinKit('slide', '9.9.9', [A, B], fakeFetch({}).fetchImpl)).rejects.toThrow(/@kition\/kit-slide-ui@9\.9\.9: no registry has it/)
  })
})

describe('the lock file', () => {
  let repoRoot: string
  const lockFile = () => path.join(repoRoot, 'kits', 'kits.lock.json')

  beforeEach(() => {
    repoRoot = path.join(work, 'repo')
    fs.mkdirSync(path.join(repoRoot, 'kits'), { recursive: true })
    fs.writeFileSync(lockFile(), JSON.stringify({ $comment: 'old words', slide: pinned, board: { ...pinned, package: '@kition/kit-board-ui' } }))
  })

  it('writes entries replacing or adding kits, its own comment first and the kits sorted', () => {
    writeKitLock(repoRoot, { slide: { ...pinned, version: '0.4.8' }, cad: { ...pinned, package: '@kition/kit-cad-ui' } })
    const text = fs.readFileSync(lockFile(), 'utf8')
    const lock = JSON.parse(text)
    expect(Object.keys(lock)).toEqual(['$comment', 'board', 'cad', 'slide'])
    expect(lock.$comment).toMatch(/@kition\/kit-<kit>-ui on npm/)
    expect(lock.slide.version).toBe('0.4.8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(Object.keys(readKitLock(repoRoot))).toEqual(['board', 'cad', 'slide'])
  })

  it('refuses entries that are not npm pins, naming each and how to pin them', () => {
    const release = { repository: 'KitionAI/kition-cad', version: '0.1.0', tag: 'package-v0.1.0', asset: 'kition-cad-0.1.0.tgz', size: 1, sha256: 'a'.repeat(64), ...build }
    fs.writeFileSync(lockFile(), JSON.stringify({ $comment: 'x', cad: release, slide: { ...pinned, integrity: 'sha256-x' }, board: { ...pinned, package: '@kition/kit-board-ui', fontsCommit: 'main' } }))
    const error = (() => {
      try {
        readKitLock(repoRoot)
        return null
      } catch (caught) {
        return String(caught)
      }
    })()
    expect(error).toMatch(/node scripts\/pin-kits\.mjs/)
    expect(error).toMatch(/cad: fields repository, tag, asset, size, sha256 are not lock fields.*package missing instead of @kition\/kit-cad-ui.*integrity missing/)
    expect(error).toMatch(/slide: integrity sha256-x is not an npm integrity/)
    expect(error).toMatch(/board: no valid fontsCommit/)
  })
})

describe('fetching a pinned package', () => {
  let kitsDir: string

  beforeEach(() => {
    kitsDir = path.join(work, 'public-kits')
  })

  /** An npm tarball of the slide editor package: package/package.json and package/slide-ui/, as kition-sdk's `pack` writes it. */
  function npmTarball({ manifest = metadata(), files = { 'kit-ui.json': JSON.stringify({ kitId: 'kit.slide', version: '0.4.7', commit: pinned.commit }), 'index.html': '<!doctype html>' } as Record<string, string>, extra = {} as Record<string, string> } = {}) {
    const stage = fs.mkdtempSync(path.join(work, 'stage-'))
    const top = path.join(stage, 'package')
    fs.mkdirSync(path.join(top, 'slide-ui'), { recursive: true })
    const { dist: _dist, ...packageJson } = manifest
    fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify({ ...packageJson, files: ['slide-ui'] }))
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(top, 'slide-ui', name), text)
    for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(top, name), text)
    execFileSync('tar', ['-czf', 'out.tgz', 'package'], { cwd: stage })
    return fs.readFileSync(path.join(stage, 'out.tgz'))
  }

  it('downloads the tarball from the first registry with the pinned integrity, unpacks <kit>-ui and stamps it', async () => {
    const bytes = npmTarball()
    const lock = { ...pinned, integrity: integrityOf(bytes) }
    fs.mkdirSync(path.join(kitsDir, 'slide-ui'), { recursive: true })
    fs.writeFileSync(path.join(kitsDir, 'slide-ui', 'stale.js'), 'old')
    const { asked, fetchImpl } = fakeFetch({
      [tarballUrl(A, lock.package, lock.version)]: () => new Response(Buffer.from('a mirror with other bytes')),
      [tarballUrl(B, lock.package, lock.version)]: () => new Response(bytes),
    })
    expect(await fetchKitPackage('slide', lock, kitsDir, [A, B], fetchImpl)).toBe(B)
    expect(asked).toEqual([`${A}@kition/kit-slide-ui/-/kit-slide-ui-0.4.7.tgz`, `${B}@kition/kit-slide-ui/-/kit-slide-ui-0.4.7.tgz`])
    expect(fs.readdirSync(path.join(kitsDir, 'slide-ui')).sort()).toEqual([KIT_PACKAGE_STAMP, 'index.html', 'kit-ui.json'])
    expect(JSON.parse(fs.readFileSync(path.join(kitsDir, 'slide-ui', KIT_PACKAGE_STAMP), 'utf8'))).toEqual(lock)
    expect(kitPackageProblem(kitsDir, 'slide', lock)).toBeNull()
    expect(fs.existsSync(path.join(kitsDir, 'package.json'))).toBe(false)
  })

  it('leaves the folder as it was when no registry serves the pinned bytes', async () => {
    fs.mkdirSync(path.join(kitsDir, 'slide-ui'), { recursive: true })
    fs.writeFileSync(path.join(kitsDir, 'slide-ui', 'kept.js'), 'kept')
    const { fetchImpl } = fakeFetch({ [tarballUrl(A, pinned.package, pinned.version)]: () => new Response(Buffer.from('other')) })
    await expect(fetchKitPackage('slide', pinned, kitsDir, [A, B], fetchImpl)).rejects.toThrow(/no registry has it/)
    expect(fs.readdirSync(path.join(kitsDir, 'slide-ui'))).toEqual(['kept.js'])
  })

  it('refuses a tarball with anything beside package.json and <kit>-ui', () => {
    expect(() => unpackKitPackage(npmTarball({ extra: { 'postinstall.js': 'x' } }), kitsDir, 'slide', pinned)).toThrow(/holds package\.json, postinstall\.js, slide-ui under package\//)
    expect(fs.existsSync(path.join(kitsDir, 'slide-ui'))).toBe(false)
  })

  it('refuses a package.json that is not the pinned package, version and build', () => {
    expect(() => unpackKitPackage(npmTarball({ manifest: metadata('0.4.8') }), kitsDir, 'slide', pinned)).toThrow(/package\.json differs from the lock \(version 0\.4\.8\)/)
    const otherBuild = metadata('0.4.7', { kition: { ...metadata().kition, build: { ...build, sdkCommit: '9'.repeat(40) } } })
    expect(() => unpackKitPackage(npmTarball({ manifest: otherBuild }), kitsDir, 'slide', pinned)).toThrow(/kition\.build\.sdkCommit 9{40}/)
  })

  it('refuses a package whose kit-ui.json is not the pinned version and commit', () => {
    const files = { 'kit-ui.json': JSON.stringify({ kitId: 'kit.slide', version: '0.4.7', commit: '8'.repeat(40) }), 'index.html': '' }
    expect(() => unpackKitPackage(npmTarball({ files }), kitsDir, 'slide', pinned)).toThrow(/0\.4\.7 \(8{40}\) instead of 0\.4\.7 \(1{40}\)/)
  })
})
