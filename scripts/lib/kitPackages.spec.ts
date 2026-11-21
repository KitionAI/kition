import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { integrityOf, metadataUrl, tarballUrl } from './kitNpm.mjs'
import {
  editorMetadata,
  fetchHeadlessPackages,
  fetchKitPackage,
  headlessMetadata,
  KIT_PACKAGE_STAMP,
  kitPackageProblem,
  pinKit,
  PLATFORMS,
  publishedKitPackageStamp,
  readKitLockFile,
  releaseAssetUrl,
  unpackKitPackage,
  writeKitLockFile,
  writeKitPackageStamp,
} from './kitPackages.mjs'

const A = 'https://a.example.test/'
const B = 'https://b.example.test/'
const STAGE = '@kitionstage'

type Metadata = { name: string; version: string; dist: { integrity: string; tarball?: string }; kition: Record<string, unknown> & { build: Record<string, string> } }

/** The real registry metadata of note 0.1.5 (five platforms) and html 0.1.3 (darwin-arm64 only) on @kitionstage. */
const REAL: Record<string, Metadata> = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kitionstage-packages.json'), 'utf8')).packages
const real = (name: string): Metadata => structuredClone(REAL[name])
const noteBuild = real(`${STAGE}/note`).kition.build
const commits = { commit: noteBuild.commit, sdkCommit: noteBuild.sdkCommit, tesseraCommit: noteBuild.tesseraCommit, fontsCommit: noteBuild.fontsCommit }

/** note 0.1.5 pinned on npm as the registry has it: npm's integrity of each tarball, sizes as published. */
const notePin = {
  scope: STAGE,
  version: '0.1.5',
  ...commits,
  editor: { integrity: REAL[`${STAGE}/note`].dist.integrity, size: 12_000_000 },
  platforms: Object.fromEntries(PLATFORMS.map((platform: string) => [platform, { integrity: REAL[`${STAGE}/note-${platform}`].dist.integrity, size: 9_000_000 }])),
}

/** note 0.1.2 pinned as a GitHub Release asset, as kits/kits.lock.json pins kits until they are on npm. */
const releasePin = {
  repository: 'KitionAI/kition-note',
  version: '0.1.2',
  tag: 'package-v0.1.2',
  asset: 'kition-note-0.1.2.tgz',
  size: 12971385,
  sha256: 'a'.repeat(64),
  ...commits,
}

let work: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-packages-'))
})
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true })
  vi.unstubAllEnvs()
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

/** A .tgz of `files` (path to text) under `top`, as npm or a Release packs a folder. */
function tarball(files: Record<string, string>, top = 'package') {
  const stage = fs.mkdtempSync(path.join(work, 'stage-'))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(stage, top, name)), { recursive: true })
    fs.writeFileSync(path.join(stage, top, name), text)
  }
  execFileSync('tar', ['-czf', 'out.tgz', ...fs.readdirSync(stage)], { cwd: stage })
  return fs.readFileSync(path.join(stage, 'out.tgz'))
}

const kitUi = (version = '0.1.5', commit = commits.commit) => JSON.stringify({ kitId: 'kit.note', version, commit, entry: 'index.html' })
/** The note editor package's tarball: package/package.json and package/note-ui/. */
const editorTarball = (manifest: object = real(`${STAGE}/note`), files: Record<string, string> = { 'note-ui/kit-ui.json': kitUi(), 'note-ui/index.html': '<!doctype html>' }) =>
  tarball({ 'package.json': JSON.stringify(manifest), ...files })
/** A note headless package's tarball for `platform`: package.json, kit.json and the executable. */
const headlessTarball = (platform: string, manifest: object = real(`${STAGE}/note-${platform}`)) =>
  tarball({ 'package.json': JSON.stringify(manifest), 'kit.json': '{"id":"kit.note"}', [`kition-note${platform.startsWith('win32') ? '.exe' : ''}`]: 'binary' })

describe('the lock entry forms', () => {
  const lockFile = () => path.join(work, 'kits.lock.json')
  const write = (kits: object) => fs.writeFileSync(lockFile(), JSON.stringify({ $comment: 'x', ...kits }))
  const problems = (kits: object) => {
    write(kits)
    try {
      readKitLockFile(lockFile())
      return ''
    } catch (error) {
      return String(error)
    }
  }

  it('reads npm pins of real packages (all five platforms, or one) beside a Release pin', () => {
    const html = { scope: STAGE, version: '0.1.3', ...commits, editor: { integrity: REAL[`${STAGE}/html`].dist.integrity, size: 11_000_000 }, platforms: { 'darwin-arm64': { integrity: REAL[`${STAGE}/html-darwin-arm64`].dist.integrity, size: 8_000_000 } } }
    write({ note: notePin, html, cad: { ...releasePin, repository: 'KitionAI/kition-cad', asset: 'kition-cad-0.1.2.tgz' } })
    expect(Object.keys(readKitLockFile(lockFile()))).toEqual(['note', 'html', 'cad'])
  })

  it('refuses an npm pin without an integrity, a size, a known platform or a valid scope, naming each', () => {
    const text = problems({
      note: { ...notePin, editor: { integrity: 'sha1-abc', size: 0 } },
      board: { ...notePin, platforms: { 'darwin-arm64': { integrity: notePin.editor.integrity }, 'sunos-x64': notePin.editor } },
      table: { ...notePin, scope: 'kitionstage' },
      sdk: notePin,
      slide: { ...notePin, package: '@kitionstage/slide', fontsCommit: 'main' },
    })
    expect(text).toMatch(/node scripts\/pin-kits\.mjs/)
    expect(text).toMatch(/note: editor\.integrity sha1-abc is not an npm integrity.*editor\.size 0 is not a size/)
    expect(text).toMatch(/board: platforms\.darwin-arm64\.size missing.*platform sunos-x64 is not one of darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64/)
    expect(text).toMatch(/table: scope is "kitionstage", not an npm scope/)
    expect(text).toMatch(/sdk: sdk is not a kit name in @kitionstage/)
    expect(text).toMatch(/slide: fields package are not npm pin fields.*no valid fontsCommit/)
  })

  it('refuses a Release pin of another repository, tag or asset, or without a size or SHA-256', () => {
    const text = problems({ note: { ...releasePin, tag: 'v0.1.2', sha256: 'abc', size: '12' }, cad: { ...releasePin, integrity: notePin.editor.integrity } })
    expect(text).toMatch(/note: tag v0\.1\.2 instead of package-v0\.1\.2; size 12 is not a size in bytes; sha256 abc is not a SHA-256/)
    expect(text).toMatch(/cad: fields integrity are not Release pin fields.*repository KitionAI\/kition-note instead of KitionAI\/kition-cad.*asset kition-note-0\.1\.2\.tgz instead of kition-cad-0\.1\.2\.tgz/)
  })

  it('writes entries replacing or adding kits, its comment first and the kits sorted, making a missing file', () => {
    writeKitLockFile(lockFile(), { note: notePin })
    writeKitLockFile(lockFile(), { cad: { ...releasePin, repository: 'KitionAI/kition-cad', asset: 'kition-cad-0.1.2.tgz' }, note: { ...notePin, version: '0.1.6' } })
    const text = fs.readFileSync(lockFile(), 'utf8')
    expect(Object.keys(JSON.parse(text))).toEqual(['$comment', 'cad', 'note'])
    expect(JSON.parse(text).$comment).toMatch(/An npm pin .* a Release pin/)
    expect(JSON.parse(text).note.version).toBe('0.1.6')
    expect(text.endsWith('}\n')).toBe(true)
  })
})

describe('registry metadata', () => {
  it("takes the real editor package's version, integrity and build commits in its scope", () => {
    expect(editorMetadata('note', real(`${STAGE}/note`), { scope: STAGE, version: '0.1.5' })).toEqual({ version: '0.1.5', integrity: REAL[`${STAGE}/note`].dist.integrity, commits })
    expect(editorMetadata('html', real(`${STAGE}/html`), { scope: STAGE }).version).toBe('0.1.3')
  })

  it("refuses metadata of another scope's name, version, kit or role, or without every build commit", () => {
    expect(() => editorMetadata('note', real(`${STAGE}/note`), { scope: '@kition' })).toThrow(/name @kitionstage\/note instead of @kition\/kit-note-ui/)
    expect(() => editorMetadata('note', real(`${STAGE}/note`), { scope: STAGE, version: '0.1.4' })).toThrow(/version 0\.1\.5 instead of 0\.1\.4/)
    expect(() => editorMetadata('html', real(`${STAGE}/note`), { scope: STAGE })).toThrow(/name @kitionstage\/note instead of @kitionstage\/html.*kition field of kit note/)
    expect(() => editorMetadata('note', { ...real(`${STAGE}/note-linux-x64`), name: `${STAGE}/note` }, { scope: STAGE })).toThrow(/kition\.role headless instead of ui/)
    const noFonts = real(`${STAGE}/note`)
    delete noFonts.kition.build.fontsCommit
    expect(() => editorMetadata('note', noFonts, { scope: STAGE })).toThrow(/kition\.build has no valid fontsCommit/)
  })

  it("checks a real headless package belongs to the editor's build", () => {
    const at = { scope: STAGE, version: '0.1.5', commit: commits.commit }
    expect(headlessMetadata('note', 'linux-x64', real(`${STAGE}/note-linux-x64`), at)).toBe(REAL[`${STAGE}/note-linux-x64`].dist.integrity)
    expect(() => headlessMetadata('note', 'linux-x64', real(`${STAGE}/note-linux-x64`), { ...at, commit: '9'.repeat(40) })).toThrow(/kition\.build\.commit f\w+ instead of the editor's 9{40}/)
    expect(() => headlessMetadata('note', 'darwin-x64', real(`${STAGE}/note-linux-x64`), at)).toThrow(/name @kitionstage\/note-linux-x64 instead of @kitionstage\/note-darwin-x64.*kition\.platform linux-x64 instead of darwin-x64/)
  })
})

describe('pinKit', () => {
  /**
   * A registry serving the real metadata of `kit` at `version`, each tarball synthetic (`bytes`), with
   * the metadata's integrity made the synthetic tarball's unless `realIntegrity`.
   */
  function registryOf(kit: string, version: string, { realIntegrity = false, registry = A } = {}) {
    const routes: Record<string, () => Response> = {}
    const sizes: Record<string, number> = {}
    for (const name of Object.keys(REAL).filter((name) => name === `${STAGE}/${kit}` || name.startsWith(`${STAGE}/${kit}-`))) {
      const metadata = real(name)
      const platform = name === `${STAGE}/${kit}` ? null : name.slice(`${STAGE}/${kit}-`.length)
      const bytes = platform ? tarball({ 'package.json': JSON.stringify(metadata), [`kition-${kit}`]: platform }) : tarball({ 'package.json': JSON.stringify(metadata) })
      if (!realIntegrity) metadata.dist.integrity = integrityOf(bytes)
      sizes[name] = bytes.length
      routes[metadataUrl(registry, name, version)] = () => new Response(JSON.stringify(metadata))
      if (!platform) routes[metadataUrl(registry, name, 'latest')] = () => new Response(JSON.stringify(metadata))
      routes[tarballUrl(registry, name, version)] = () => new Response(bytes)
    }
    return { routes, sizes }
  }

  it('pins the editor and the five platforms of note 0.1.5 with their integrity and tarball size', async () => {
    const { routes, sizes } = registryOf('note', '0.1.5')
    const { asked, fetchImpl } = fakeFetch(routes)
    const { registry, entry, missing } = await pinKit('note', '0.1.5', [A], { scope: STAGE, fetchImpl })
    expect(registry).toBe(A)
    expect(missing).toEqual([])
    expect(Object.keys(entry)).toEqual(['scope', 'version', 'commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit', 'editor', 'platforms'])
    expect(entry).toMatchObject({ scope: STAGE, version: '0.1.5', ...commits })
    expect(entry.editor).toEqual({ integrity: expect.stringMatching(/^sha512-/), size: sizes[`${STAGE}/note`] })
    expect(Object.keys(entry.platforms)).toEqual(PLATFORMS)
    expect(entry.platforms['win32-x64'].size).toBe(sizes[`${STAGE}/note-win32-x64`])
    expect(asked).toContain(`${A}@kitionstage/note-linux-x64/-/note-linux-x64-0.1.5.tgz`)
    // What it pins reads back as a lock entry.
    writeKitLockFile(path.join(work, 'lock.json'), { note: entry })
    expect(readKitLockFile(path.join(work, 'lock.json')).note).toEqual(entry)
  })

  it("pins html 0.1.3's latest with the one platform npm has, naming the others", async () => {
    const { fetchImpl } = fakeFetch(registryOf('html', '0.1.3').routes)
    const { entry, missing } = await pinKit('html', undefined, [A], { scope: STAGE, fetchImpl })
    expect(entry.version).toBe('0.1.3')
    expect(Object.keys(entry.platforms)).toEqual(['darwin-arm64'])
    expect(missing).toEqual(['darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  })

  it('takes the scope from KITION_NPM_SCOPE', async () => {
    vi.stubEnv('KITION_NPM_SCOPE', STAGE)
    const { fetchImpl } = fakeFetch(registryOf('html', '0.1.3').routes)
    expect((await pinKit('html', '0.1.3', [A], { fetchImpl })).entry.scope).toBe(STAGE)
  })

  it("refuses tarballs whose bytes are not npm's integrity", async () => {
    const { fetchImpl } = fakeFetch(registryOf('note', '0.1.5', { realIntegrity: true }).routes)
    await expect(pinKit('note', '0.1.5', [A], { scope: STAGE, fetchImpl })).rejects.toThrow(/@kitionstage\/note@0\.1\.5: no registry has it[\s\S]*its tarball's integrity is sha512-\S+, not sha512-JUzmH0/)
  })

  it('fails rather than leave a platform out when a registry cannot be asked about it', async () => {
    const { routes } = registryOf('html', '0.1.3')
    routes[metadataUrl(A, `${STAGE}/html-linux-x64`, '0.1.3')] = () => new Response('busy', { status: 503 })
    const { fetchImpl } = fakeFetch(routes)
    await expect(pinKit('html', '0.1.3', [A, B], { scope: STAGE, fetchImpl })).rejects.toThrow(/@kitionstage\/html-linux-x64@0\.1\.3: no registry has it[\s\S]*HTTP 503/)
  })

  it('fails when no registry has the version', async () => {
    await expect(pinKit('note', '9.9.9', [A, B], { scope: STAGE, fetchImpl: fakeFetch({}).fetchImpl })).rejects.toThrow(/@kitionstage\/note@9\.9\.9: no registry has it/)
  })
})

describe('kitPackageProblem', () => {
  let kitsDir: string

  beforeEach(() => {
    kitsDir = path.join(work, 'kits')
    fs.mkdirSync(path.join(kitsDir, 'note-ui'), { recursive: true })
    fs.writeFileSync(path.join(kitsDir, 'note-ui', 'kit-ui.json'), kitUi())
  })

  const stamp = (value: unknown) => fs.writeFileSync(path.join(kitsDir, 'note-ui', KIT_PACKAGE_STAMP), JSON.stringify(value))

  it('accepts a fetched package whose stamp matches the lock', () => {
    writeKitPackageStamp(kitsDir, 'note', publishedKitPackageStamp(notePin))
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toBeNull()
  })

  it("stamps an npm pin's scope, version, editor integrity and build, and a Release pin's asset", () => {
    expect(publishedKitPackageStamp({ ...notePin, extra: true })).toEqual({ scope: STAGE, version: '0.1.5', integrity: notePin.editor.integrity, ...commits })
    expect(publishedKitPackageStamp(releasePin)).toEqual({ repository: releasePin.repository, version: '0.1.2', asset: releasePin.asset, sha256: releasePin.sha256, ...commits })
  })

  it('rejects a package without a stamp, or a local build of the pinned version and commit', () => {
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toMatch(/not a fetched package/)
    stamp({ local: true, kitCommit: commits.commit, sdkCommit: commits.sdkCommit, builtAt: '2026-01-01T00:00:00Z' })
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toMatch(/a local build .*, not the published @kitionstage\/note@0\.1\.5/)
  })

  it('rejects a stamp that differs from the lock, of another scope or of a Release asset', () => {
    stamp({ ...publishedKitPackageStamp(notePin), integrity: `sha512-${'b'.repeat(86)}==` })
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toMatch(/differs from the lock \(integrity sha512-b+== instead of sha512-JUzmH0/)
    stamp({ ...publishedKitPackageStamp(notePin), scope: '@kition' })
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toMatch(/differs from the lock \(scope @kition instead of @kitionstage\)/)
    stamp(publishedKitPackageStamp({ ...releasePin, version: '0.1.5' }))
    expect(kitPackageProblem(kitsDir, 'note', notePin)).toMatch(/differs from the lock \(scope missing instead of @kitionstage, integrity missing.*repository KitionAI\/kition-note instead of none/)
  })

  it('checks only kit-ui.json without the stamp check, and reports a missing package', () => {
    stamp({ local: true })
    expect(kitPackageProblem(kitsDir, 'note', notePin, { stamp: false })).toBeNull()
    expect(kitPackageProblem(kitsDir, 'note', { ...notePin, version: '0.1.6' }, { stamp: false })).toMatch(/0\.1\.5 .* instead of 0\.1\.6/)
    expect(kitPackageProblem(kitsDir, 'html', notePin)).toMatch(/html: not in/)
  })
})

describe('fetching an npm pin', () => {
  let kitsDir: string
  beforeEach(() => {
    kitsDir = path.join(work, 'public-kits')
  })

  const pinOf = (bytes: Buffer) => ({ ...notePin, editor: { integrity: integrityOf(bytes), size: bytes.length } })

  it('downloads the editor from the first registry with the pinned integrity and size, unpacks <kit>-ui and stamps it', async () => {
    const bytes = editorTarball()
    const pinned = pinOf(bytes)
    fs.mkdirSync(path.join(kitsDir, 'note-ui'), { recursive: true })
    fs.writeFileSync(path.join(kitsDir, 'note-ui', 'stale.js'), 'old')
    const { asked, fetchImpl } = fakeFetch({
      [tarballUrl(A, `${STAGE}/note`, '0.1.5')]: () => new Response(Buffer.from('a mirror with other bytes')),
      [tarballUrl(B, `${STAGE}/note`, '0.1.5')]: () => new Response(bytes),
    })
    expect(await fetchKitPackage('note', pinned, kitsDir, [A, B], fetchImpl)).toBe(B)
    expect(asked).toEqual([`${A}@kitionstage/note/-/note-0.1.5.tgz`, `${B}@kitionstage/note/-/note-0.1.5.tgz`])
    expect(fs.readdirSync(path.join(kitsDir, 'note-ui')).sort()).toEqual([KIT_PACKAGE_STAMP, 'index.html', 'kit-ui.json'])
    expect(kitPackageProblem(kitsDir, 'note', pinned)).toBeNull()
  })

  it('refuses bytes of another size, and leaves the folder as it was when no registry serves the pinned bytes', async () => {
    const bytes = editorTarball()
    const { fetchImpl } = fakeFetch({ [tarballUrl(A, `${STAGE}/note`, '0.1.5')]: () => new Response(bytes) })
    await expect(fetchKitPackage('note', { ...pinOf(bytes), editor: { integrity: integrityOf(bytes), size: bytes.length + 1 } }, kitsDir, [A], fetchImpl)).rejects.toThrow(
      new RegExp(`${bytes.length} bytes; the lock pins ${bytes.length + 1}`),
    )
    fs.mkdirSync(path.join(kitsDir, 'note-ui'), { recursive: true })
    fs.writeFileSync(path.join(kitsDir, 'note-ui', 'kept.js'), 'kept')
    await expect(fetchKitPackage('note', notePin, kitsDir, [A, B], fetchImpl)).rejects.toThrow(/no registry has it/)
    expect(fs.readdirSync(path.join(kitsDir, 'note-ui'))).toEqual(['kept.js'])
  })

  it('refuses a tarball with anything beside package.json and <kit>-ui, or another package, version or build', () => {
    expect(() => unpackKitPackage(editorTarball(real(`${STAGE}/note`), { 'note-ui/kit-ui.json': kitUi(), 'postinstall.js': 'x' }), kitsDir, 'note', notePin)).toThrow(/holds note-ui, package\.json, postinstall\.js under package\//)
    expect(() => unpackKitPackage(editorTarball({ ...real(`${STAGE}/note`), name: '@kition/kit-note-ui' }), kitsDir, 'note', notePin)).toThrow(/package\.json differs from the lock \(name @kition\/kit-note-ui\)/)
    const other = real(`${STAGE}/note`)
    other.kition.build.sdkCommit = '9'.repeat(40)
    expect(() => unpackKitPackage(editorTarball(other), kitsDir, 'note', notePin)).toThrow(/kition\.build\.sdkCommit 9{40}/)
    expect(() => unpackKitPackage(editorTarball(real(`${STAGE}/note`), { 'note-ui/kit-ui.json': kitUi('0.1.5', '8'.repeat(40)) }), kitsDir, 'note', notePin)).toThrow(/0\.1\.5 \(8{40}\) instead of 0\.1\.5/)
    expect(fs.existsSync(path.join(kitsDir, 'note-ui', KIT_PACKAGE_STAMP))).toBe(false)
  })

  it('downloads every pinned platform package, checked, into <dir>/<kit>-<platform>', async () => {
    const routes: Record<string, () => Response> = {}
    const platforms: Record<string, { integrity: string; size: number }> = {}
    for (const platform of ['linux-x64', 'win32-x64']) {
      const bytes = headlessTarball(platform)
      platforms[platform] = { integrity: integrityOf(bytes), size: bytes.length }
      routes[tarballUrl(A, `${STAGE}/note-${platform}`, '0.1.5')] = () => new Response(bytes)
    }
    const dir = path.join(work, 'headless')
    const { fetchImpl } = fakeFetch(routes)
    expect(await fetchHeadlessPackages('note', { ...notePin, platforms }, dir, [A], fetchImpl)).toEqual({ 'linux-x64': A, 'win32-x64': A })
    expect(fs.readdirSync(dir).sort()).toEqual(['note-linux-x64', 'note-win32-x64'])
    expect(fs.readdirSync(path.join(dir, 'note-win32-x64')).sort()).toEqual(['kit.json', 'kition-note.exe', 'package.json'])
  })

  it("refuses a platform package that is another platform's, and a Release pin's platforms", async () => {
    const bytes = headlessTarball('linux-x64', real(`${STAGE}/note-darwin-x64`))
    const { fetchImpl } = fakeFetch({ [tarballUrl(A, `${STAGE}/note-linux-x64`, '0.1.5')]: () => new Response(bytes) })
    await expect(fetchHeadlessPackages('note', { ...notePin, platforms: { 'linux-x64': { integrity: integrityOf(bytes), size: bytes.length } } }, work, [A], fetchImpl)).rejects.toThrow(
      /@kitionstage\/note-linux-x64@0\.1\.5: differs from the lock \(name @kitionstage\/note-darwin-x64, kition\.platform darwin-x64\)/,
    )
    await expect(fetchHeadlessPackages('note', releasePin, work, [A], fetchImpl)).rejects.toThrow(/a Release pin has no headless packages/)
  })
})

describe('fetching a Release pin', () => {
  const asset = (files: Record<string, string> = { 'kit-ui.json': kitUi('0.1.2'), 'index.html': '' }) => tarball(files, 'note-ui')
  const pinOf = (bytes: Buffer) => ({ ...releasePin, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })

  it('downloads the asset from GitHub, checks its size and SHA-256, unpacks it and stamps it', async () => {
    const bytes = asset()
    const pinned = pinOf(bytes)
    const kitsDir = path.join(work, 'kits')
    const { asked, fetchImpl } = fakeFetch({ [releaseAssetUrl(pinned)]: () => new Response(bytes) })
    expect(await fetchKitPackage('note', pinned, kitsDir, [A], fetchImpl)).toBe('https://github.com/KitionAI/kition-note/releases/download/package-v0.1.2/kition-note-0.1.2.tgz')
    expect(asked).toEqual([releaseAssetUrl(pinned)])
    expect(kitPackageProblem(kitsDir, 'note', pinned)).toBeNull()
  })

  it('refuses other bytes, and an asset with anything beside <kit>-ui', async () => {
    const bytes = asset()
    const { fetchImpl } = fakeFetch({ [releaseAssetUrl(releasePin)]: () => new Response(bytes) })
    await expect(fetchKitPackage('note', releasePin, work, [A], fetchImpl)).rejects.toThrow(/the lock pins 12971385 bytes, sha256 a{64}/)
    const extra = tarball({ 'README.md': 'x' }, '.')
    expect(() => unpackKitPackage(extra, work, 'note', pinOf(extra))).toThrow(/holds README\.md, not note-ui\//)
  })
})
