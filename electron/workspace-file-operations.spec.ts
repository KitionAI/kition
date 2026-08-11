import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertWorkspacePathSafe,
  trashWorkspaceDocument,
  trashWorkspaceFolder,
  writeFileAtomically,
} from './workspace-file-operations.mjs'

const temporaryRoots: string[] = []

async function makeTemporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-workspace-files-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )))
})

describe('workspace file operations', () => {
  it('writes through a temporary file and atomically replaces existing content', async () => {
    const root = await makeTemporaryRoot()
    const filePath = path.join(root, 'Plan.md')
    await fs.writeFile(filePath, 'before', 'utf8')

    await writeFileAtomically(filePath, 'after', 'utf8')

    expect(await fs.readFile(filePath, 'utf8')).toBe('after')
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('allows a missing file under a real workspace directory', async () => {
    const root = await makeTemporaryRoot()
    const folderPath = path.join(root, 'Notes')
    await fs.mkdir(folderPath)

    await expect(assertWorkspacePathSafe(
      root,
      path.join(folderPath, 'New.md'),
      { allowMissing: true },
    )).resolves.toBe(path.join(folderPath, 'New.md'))
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link file that resolves outside the workspace', async () => {
    const root = await makeTemporaryRoot()
    const outside = await makeTemporaryRoot()
    const outsideFile = path.join(outside, 'secret.txt')
    const linkPath = path.join(root, 'linked.txt')
    await fs.writeFile(outsideFile, 'secret', 'utf8')
    await fs.symlink(outsideFile, linkPath)

    await expect(assertWorkspacePathSafe(root, linkPath)).rejects.toThrow('symbolic links')
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link directory used as a parent', async () => {
    const root = await makeTemporaryRoot()
    const outside = await makeTemporaryRoot()
    const linkPath = path.join(root, 'linked-folder')
    await fs.symlink(outside, linkPath, 'dir')

    await expect(assertWorkspacePathSafe(
      root,
      path.join(linkPath, 'New.md'),
      { allowMissing: true },
    )).rejects.toThrow('symbolic links')
  })

  it('moves documents, child folders, and folders through the system trash API', async () => {
    const root = await makeTemporaryRoot()
    const filePath = path.join(root, 'Plan.md')
    const childFolderPath = path.join(root, 'Plan')
    await fs.writeFile(filePath, '# Plan', 'utf8')
    await fs.mkdir(childFolderPath)
    const shell = { trashItem: vi.fn().mockResolvedValue(undefined) }

    await trashWorkspaceDocument(shell, filePath, childFolderPath)
    await trashWorkspaceFolder(shell, childFolderPath)

    expect(shell.trashItem).toHaveBeenNthCalledWith(1, filePath)
    expect(shell.trashItem).toHaveBeenNthCalledWith(2, childFolderPath)
    expect(shell.trashItem).toHaveBeenNthCalledWith(3, childFolderPath)
  })
})
