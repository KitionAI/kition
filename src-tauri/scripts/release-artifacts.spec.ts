import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildUpdaterManifest, collectArtifacts, describeTarget, expectedReleaseAssets, plannedArtifacts } from './release-artifacts.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

describe('release artifacts', () => {
  it('describes supported targets', () => {
    expect(describeTarget('aarch64-apple-darwin')).toEqual({ os: 'macos', arch: 'arm64' })
    expect(describeTarget('x86_64-pc-windows-msvc')).toEqual({ os: 'windows', arch: 'x64' })
    expect(describeTarget('x86_64-unknown-linux-gnu')).toEqual({ os: 'linux', arch: 'x64' })
    expect(() => describeTarget('riscv64gc-unknown-linux-gnu')).toThrow('unsupported desktop target')
  })

  it('plans stable release names', () => {
    const intel = plannedArtifacts({ bundleDir: '/b', version: '1.2.3', triple: 'x86_64-apple-darwin' })
    expect(intel.map((item) => item.to)).toEqual(['Kition-1.2.3-macos-x64.dmg', 'Kition-1.2.3-macos-x64.app.tar.gz'])
    expect(intel[0].from).toBe(path.join('/b', 'dmg', 'Kition_1.2.3_x64.dmg'))
    const silicon = plannedArtifacts({ bundleDir: '/b', version: '1.2.3', triple: 'aarch64-apple-darwin' })
    expect(silicon[0].from).toBe(path.join('/b', 'dmg', 'Kition_1.2.3_aarch64.dmg'))
    const windows = plannedArtifacts({ bundleDir: '/b', version: '1.2.3', triple: 'x86_64-pc-windows-msvc' })
    expect(windows[0].from).toBe(path.join('/b', 'nsis', 'Kition_1.2.3_x64-setup.exe'))
  })

  it('collects bundles with their signatures and writes the updater manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-release-artifacts-'))
    cleanupPaths.push(root)
    const bundleDir = path.join(root, 'bundle')
    await fs.mkdir(path.join(bundleDir, 'appimage'), { recursive: true })
    await fs.writeFile(path.join(bundleDir, 'appimage', 'Kition_1.2.3_amd64.AppImage'), 'app')
    await fs.writeFile(path.join(bundleDir, 'appimage', 'Kition_1.2.3_amd64.AppImage.sig'), 'sig-linux\n')
    const outputDir = path.join(root, 'out')

    const copied = await collectArtifacts({ bundleDir, outputDir, version: '1.2.3', triple: 'x86_64-unknown-linux-gnu', signed: true })
    expect(copied).toEqual(['Kition-1.2.3-linux-x64.AppImage', 'Kition-1.2.3-linux-x64.AppImage.sig'])

    const manifest = await buildUpdaterManifest({
      artifactDir: outputDir,
      version: '1.2.3',
      repository: 'KitionAI/kition',
      tag: 'v1.2.3',
      pubDate: '2026-10-09T00:00:00.000Z',
    })
    expect(manifest).toEqual({
      version: '1.2.3',
      notes: '',
      pub_date: '2026-10-09T00:00:00.000Z',
      platforms: {
        'linux-x86_64': {
          signature: 'sig-linux',
          url: 'https://github.com/KitionAI/kition/releases/download/v1.2.3/Kition-1.2.3-linux-x64.AppImage',
        },
      },
    })
  })

  it('refuses a manifest without signed artifacts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-release-empty-'))
    cleanupPaths.push(root)
    await expect(buildUpdaterManifest({ artifactDir: root, version: '1.0.0', repository: 'a/b', tag: 'v1.0.0' })).rejects.toThrow('no signed update artifacts')
  })
})

describe('expectedReleaseAssets', () => {
  it('lists installers and signed update archives for every platform', () => {
    const names = expectedReleaseAssets('2.0.0')
    expect(names).toContain('Kition-2.0.0-macos-arm64.dmg')
    expect(names).toContain('Kition-2.0.0-macos-x64.app.tar.gz.sig')
    expect(names).toContain('Kition-2.0.0-windows-x64-setup.exe.sig')
    expect(names).toContain('Kition-2.0.0-linux-x64.AppImage')
    expect(names).toHaveLength(10)
  })
})
