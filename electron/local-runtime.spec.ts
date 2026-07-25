import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { discoverSiblingRuntimeBinary } from './local-runtime.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createWorkspace(binaryName = 'kition-api') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-local-runtime-'))
  cleanupPaths.push(root)
  const clientRoot = path.join(root, 'kition')
  const runtimeDist = path.join(root, 'kition-runtime', 'dist')
  const binaryPath = path.join(runtimeDist, binaryName)
  await fs.mkdir(clientRoot)
  await fs.mkdir(runtimeDist, { recursive: true })
  await fs.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { clientRoot, binaryPath }
}

describe('discoverSiblingRuntimeBinary', () => {
  it('uses an executable runtime from the sibling private checkout', async () => {
    const fixture = await createWorkspace()

    await expect(discoverSiblingRuntimeBinary({
      clientRoot: fixture.clientRoot,
      env: {},
      platform: 'darwin',
    })).resolves.toBe(fixture.binaryPath)
  })

  it('does not override an explicit runtime binary', async () => {
    const fixture = await createWorkspace()

    await expect(discoverSiblingRuntimeBinary({
      clientRoot: fixture.clientRoot,
      env: { KITION_API_BINARY: '/custom/kition-api' },
      platform: 'darwin',
    })).resolves.toBe('')
  })

  it('falls through to release resolution when the sibling runtime is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-local-runtime-missing-'))
    cleanupPaths.push(root)
    const clientRoot = path.join(root, 'kition')
    await fs.mkdir(clientRoot)

    await expect(discoverSiblingRuntimeBinary({ clientRoot, env: {}, platform: 'darwin' }))
      .resolves.toBe('')
  })
})
