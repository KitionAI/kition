import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSidecar } from './build-sidecar.mjs'

const cleanupPaths: string[] = []
const originalBinary = process.env.KITION_API_BINARY
const originalAssetDir = process.env.KITION_RUNTIME_ASSET_DIR

afterEach(async () => {
  if (originalBinary === undefined) delete process.env.KITION_API_BINARY
  else process.env.KITION_API_BINARY = originalBinary
  if (originalAssetDir === undefined) delete process.env.KITION_RUNTIME_ASSET_DIR
  else process.env.KITION_RUNTIME_ASSET_DIR = originalAssetDir
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

describe('buildSidecar', () => {
  it('packages an explicitly supplied proprietary runtime binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-sidecar-build-'))
    cleanupPaths.push(root)
    const source = path.join(root, 'runtime', 'kition-api')
    const output = path.join(root, 'output')
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.writeFile(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.KITION_API_BINARY = source
    delete process.env.KITION_RUNTIME_ASSET_DIR

    const result = await buildSidecar(output, 'darwin', 'arm64')

    expect(result.source).toBe('explicit')
    expect(result.runtimeVersion).toBe('0.1.0')
    expect(result.protocolVersion).toBe(1)
    expect(await fs.readFile(result.outputPath, 'utf8')).toContain('exit 0')
    expect(result.sha256).toBe(createHash('sha256').update(await fs.readFile(result.outputPath)).digest('hex'))
  })

  it('rejects an asset directory without verified runtime metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-sidecar-asset-'))
    cleanupPaths.push(root)
    const source = path.join(root, 'asset', 'kition-api')
    const output = path.join(root, 'output')
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.writeFile(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    delete process.env.KITION_API_BINARY
    process.env.KITION_RUNTIME_ASSET_DIR = path.dirname(source)

    await expect(buildSidecar(output, 'darwin', 'arm64')).rejects.toThrow('.runtime.json')
  })
})
