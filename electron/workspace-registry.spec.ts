import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WorkspaceRegistry } from './workspace-registry.mjs'

describe('WorkspaceRegistry multi-process refresh', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-workspace-registry-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('reloads workspaces written by another registry instance', async () => {
    const firstWorkspace = path.join(dataDir, 'first')
    const secondWorkspace = path.join(dataDir, 'second')
    await Promise.all([
      fs.mkdir(firstWorkspace, { recursive: true }),
      fs.mkdir(secondWorkspace, { recursive: true }),
    ])

    const firstRegistry = new WorkspaceRegistry(dataDir)
    const secondRegistry = new WorkspaceRegistry(dataDir)
    await firstRegistry.addVault({ path: firstWorkspace })
    await secondRegistry.load()
    await firstRegistry.addVault({ path: secondWorkspace })

    await secondRegistry.reload()

    expect(secondRegistry.list().vaults.map((vault) => vault.path)).toEqual(
      expect.arrayContaining([firstWorkspace, secondWorkspace]),
    )
    await expect(
      fs.readFile(path.join(dataDir, 'workspaces.json'), 'utf8').then(JSON.parse),
    ).resolves.toMatchObject({
      vaults: expect.any(Array),
    })
  })
})
