import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildMacUpdateMetadata,
  writeMacUpdateMetadata,
} from './generate-mac-update-metadata.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-mac-update-'))
  cleanupPaths.push(root)
  await fs.mkdir(path.join(root, 'arm64'), { recursive: true })
  await fs.mkdir(path.join(root, 'x64'), { recursive: true })
  const arm64 = path.join(root, 'arm64', 'Kition-0.1.7-macos-arm64.zip')
  const x64 = path.join(root, 'x64', 'Kition-0.1.7-macos-x64.zip')
  await fs.writeFile(arm64, 'arm64 update')
  await fs.writeFile(x64, 'x64 update')
  await fs.writeFile(path.join(root, 'arm64', 'Kition-0.1.7-macos-arm64.dmg'), 'installer')
  await fs.writeFile(path.join(root, 'arm64', 'latest-mac.yml'), 'stale')
  return { arm64, root, x64 }
}

describe('macOS update metadata', () => {
  it('selects architecture-specific ZIP files for a 0.1.7 update', async () => {
    const fixture = await createFixture()
    const metadata = buildMacUpdateMetadata({
      files: [fixture.arm64, fixture.x64],
      version: '0.1.7',
      releaseDate: '2026-08-02T12:00:00.000Z',
    })

    expect(metadata.version).toBe('0.1.7')
    expect(metadata.files.map((file) => file.url)).toEqual([
      'Kition-0.1.7-macos-arm64.zip',
      'Kition-0.1.7-macos-x64.zip',
    ])
    expect(metadata.path).toBe('Kition-0.1.7-macos-x64.zip')
    expect(metadata.files.every((file) => file.sha512 && file.size > 0)).toBe(true)
  })

  it('replaces per-architecture metadata with one combined file', async () => {
    const fixture = await createFixture()
    const result = writeMacUpdateMetadata({
      root: fixture.root,
      version: '0.1.7',
      releaseDate: '2026-08-02T12:00:00.000Z',
    })

    const written = JSON.parse(await fs.readFile(result.outputPath, 'utf8'))
    expect(written.files).toHaveLength(2)
    await expect(fs.stat(path.join(fixture.root, 'arm64', 'latest-mac.yml'))).rejects.toThrow()
  })

  it('rejects DMG-only releases because electron-updater requires ZIP', async () => {
    const fixture = await createFixture()
    expect(() => buildMacUpdateMetadata({
      files: [path.join(fixture.root, 'Kition-0.1.7-macos-arm64.dmg')],
      version: '0.1.7',
    })).toThrow('Expected one arm64 and one x64 macOS ZIP')
  })
})
