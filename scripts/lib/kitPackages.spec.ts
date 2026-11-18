import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIT_PACKAGE_STAMP, kitPackageProblem, publishedKitPackageStamp, writeKitPackageStamp } from './kitPackages.mjs'

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
