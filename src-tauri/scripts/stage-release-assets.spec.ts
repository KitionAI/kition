import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { expectedReleaseAssets, releaseTargets } from './release-artifacts.mjs'
import { parseTargets, stageReleaseAssets } from './stage-release-assets.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function fixture(names: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-stage-release-'))
  cleanupPaths.push(root)
  const artifacts = path.join(root, 'artifacts')
  for (const [index, name] of names.entries()) {
    const folder = path.join(artifacts, `desktop-${index % 3}`)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, name), name.endsWith('.sig') ? `sig-${name}` : 'bytes')
  }
  return { root, artifacts, out: path.join(root, 'out') }
}

describe('stageReleaseAssets', () => {
  it('flattens a complete release and writes the updater manifest', async () => {
    const { artifacts, out } = await fixture(expectedReleaseAssets('2.0.0'))
    const staged = await stageReleaseAssets({ artifacts, out, version: '2.0.0', tag: 'v2.0.0', repository: 'KitionAI/kition' })

    expect(staged).toContain('latest.json')
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'latest.json'), 'utf8'))
    expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64'])
    expect(manifest.platforms['windows-x86_64'].url).toBe(
      'https://github.com/KitionAI/kition/releases/download/v2.0.0/Kition-2.0.0-windows-x64-setup.exe',
    )
  })

  it('refuses an incomplete release', async () => {
    const { artifacts, out } = await fixture(expectedReleaseAssets('2.0.0').slice(1))
    await expect(stageReleaseAssets({ artifacts, out, version: '2.0.0', tag: 'v2.0.0', repository: 'a/b' }))
      .rejects.toThrow('missing release assets: Kition-2.0.0-macos-arm64.dmg')
  })

  it('stages a draft of the targets asked for, with an updater manifest of those platforms', async () => {
    const { artifacts, out } = await fixture(expectedReleaseAssets('2.0.0', ['aarch64-apple-darwin']))
    const staged = await stageReleaseAssets({
      artifacts,
      out,
      version: '2.0.0',
      tag: 'v2.0.0',
      repository: 'KitionAI/kition',
      targets: ['aarch64-apple-darwin'],
    })

    expect(staged).toEqual([
      'Kition-2.0.0-macos-arm64.app.tar.gz',
      'Kition-2.0.0-macos-arm64.app.tar.gz.sig',
      'Kition-2.0.0-macos-arm64.dmg',
      'latest.json',
    ])
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'latest.json'), 'utf8'))
    expect(Object.keys(manifest.platforms)).toEqual(['darwin-aarch64'])
  })

  it('refuses a draft that misses a file of a target asked for', async () => {
    const { artifacts, out } = await fixture(['Kition-2.0.0-macos-arm64.dmg', 'Kition-2.0.0-macos-arm64.app.tar.gz'])
    await expect(
      stageReleaseAssets({ artifacts, out, version: '2.0.0', tag: 'v2.0.0', repository: 'a/b', targets: ['aarch64-apple-darwin'] }),
    ).rejects.toThrow('missing release assets: Kition-2.0.0-macos-arm64.app.tar.gz.sig')
  })

  it('reads --targets as a list of release targets, and every target without it', () => {
    expect(parseTargets(undefined)).toEqual(releaseTargets)
    expect(parseTargets('aarch64-apple-darwin')).toEqual(['aarch64-apple-darwin'])
    expect(parseTargets('aarch64-apple-darwin, x86_64-unknown-linux-gnu')).toEqual(['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'])
    expect(() => parseTargets('aarch64-unknown-linux-gnu')).toThrow('unknown release targets: aarch64-unknown-linux-gnu')
    expect(() => parseTargets(',')).toThrow('unknown release targets')
  })
})
