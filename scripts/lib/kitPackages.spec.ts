import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIT_PACKAGE_STAMP, kitLockEntry, kitPackageProblem, publishedKitPackageStamp, writeKitLock, writeKitPackageStamp } from './kitPackages.mjs'

const pinned = {
  repository: 'KitionAI/kition-slide',
  version: '0.4.7',
  tag: 'package-v0.4.7',
  asset: 'kition-slide-0.4.7.tgz',
  size: 1234,
  sha256: 'a'.repeat(64),
  commit: '1'.repeat(40),
  sdkCommit: '2'.repeat(40),
  fontsCommit: '3'.repeat(40),
}

describe('kitPackageProblem', () => {
  let kitsDir: string

  beforeEach(() => {
    kitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-packages-'))
    fs.mkdirSync(path.join(kitsDir, 'slide-ui'))
    fs.writeFileSync(
      path.join(kitsDir, 'slide-ui', 'kit-ui.json'),
      JSON.stringify({ kitId: 'kit.slide', version: pinned.version, commit: pinned.commit, entry: 'index.html', protocol: 'kition-kit-ui/1' }),
    )
  })

  afterEach(() => {
    fs.rmSync(kitsDir, { recursive: true, force: true })
  })

  const stamp = (value: unknown) => fs.writeFileSync(path.join(kitsDir, 'slide-ui', KIT_PACKAGE_STAMP), JSON.stringify(value))

  it('accepts a fetched package whose stamp matches the lock', () => {
    writeKitPackageStamp(kitsDir, 'slide', publishedKitPackageStamp(pinned))
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toBeNull()
  })

  it('rejects a package without a stamp', () => {
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/not a fetched package/)
  })

  it('rejects a local build of the pinned version and commit', () => {
    stamp({ local: true, kitCommit: pinned.commit, sdkCommit: pinned.sdkCommit, builtAt: '2026-01-01T00:00:00Z' })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/a local build/)
  })

  it('rejects a stamp that differs from the lock', () => {
    stamp({ ...publishedKitPackageStamp(pinned), sha256: 'b'.repeat(64) })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(sha256 b+ instead of a+\)/)
    stamp({ ...publishedKitPackageStamp(pinned), sdkCommit: '4'.repeat(40) })
    expect(kitPackageProblem(kitsDir, 'slide', pinned)).toMatch(/differs from the lock \(sdkCommit/)
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
  const metadata = { ...pinned, tesseraCommit: '4'.repeat(40) }
  const asked = { repository: pinned.repository, version: pinned.version }
  const download = { size: pinned.size, sha256: pinned.sha256 }

  it('takes the Release metadata as the lock entry, in the lock order', () => {
    const entry = kitLockEntry('slide', asked, { extra: true, ...metadata }, download)
    expect(Object.keys(entry)).toEqual(['repository', 'version', 'tag', 'asset', 'size', 'sha256', 'commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit'])
    expect(entry).toEqual(metadata)
  })

  it('rejects a download whose size or SHA-256 differs from the metadata', () => {
    expect(() => kitLockEntry('slide', asked, metadata, { ...download, sha256: 'b'.repeat(64) })).toThrow(/sha256 a+ instead of b+/)
    expect(() => kitLockEntry('slide', asked, metadata, { ...download, size: 1 })).toThrow(/size 1234 instead of 1/)
  })

  it('rejects metadata of another kit, repository or version', () => {
    expect(() => kitLockEntry('slide', { ...asked, version: '0.4.8' }, metadata, download)).toThrow(/version 0\.4\.7 instead of 0\.4\.8/)
    expect(() => kitLockEntry('slide', { ...asked, repository: 'KitionAI/kition-sheet' }, metadata, download)).toThrow(/repository/)
    expect(() => kitLockEntry('sheet', { ...asked, repository: 'KitionAI/kition-sheet' }, { ...metadata, repository: 'KitionAI/kition-sheet' }, download)).toThrow(/asset kition-slide-0\.4\.7\.tgz instead of kition-sheet-0\.4\.7\.tgz/)
  })

  it('rejects metadata without every commit', () => {
    const { tesseraCommit: _tessera, ...withoutTessera } = metadata
    expect(() => kitLockEntry('slide', asked, withoutTessera, download)).toThrow(/no valid tesseraCommit/)
  })
})

describe('writeKitLock', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-lock-'))
    fs.mkdirSync(path.join(repoRoot, 'kits'))
    fs.writeFileSync(path.join(repoRoot, 'kits', 'kits.lock.json'), JSON.stringify({ $comment: 'pins', slide: { version: '1' }, board: { version: '1' } }))
  })

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })

  it('replaces and adds entries, keeping the comment first and the kits sorted', () => {
    writeKitLock(repoRoot, { slide: { version: '2' }, cad: { version: '1' } })
    const text = fs.readFileSync(path.join(repoRoot, 'kits', 'kits.lock.json'), 'utf8')
    expect(Object.keys(JSON.parse(text))).toEqual(['$comment', 'board', 'cad', 'slide'])
    expect(JSON.parse(text).slide).toEqual({ version: '2' })
    expect(text.endsWith('}\n')).toBe(true)
  })
})
