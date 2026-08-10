import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  deleteWorkspaceDocumentPermanently,
  deleteWorkspaceFolderPermanently,
} from './workspace-delete.mjs'

const temporaryRoots: string[] = []

async function makeTemporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-workspace-delete-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )))
})

describe('workspace permanent deletion', () => {
  it('deletes a document and its same-named child folder', async () => {
    const root = await makeTemporaryRoot()
    const documentPath = path.join(root, 'Campaign.md')
    const childFolderPath = path.join(root, 'Campaign')
    await fs.writeFile(documentPath, '# Campaign')
    await fs.mkdir(childFolderPath)
    await fs.writeFile(path.join(childFolderPath, 'Plan.md'), '# Plan')

    await deleteWorkspaceDocumentPermanently(documentPath, childFolderPath)

    await expect(fs.stat(documentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(childFolderPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes a folder recursively', async () => {
    const root = await makeTemporaryRoot()
    const folderPath = path.join(root, 'campaigns')
    await fs.mkdir(path.join(folderPath, 'launch'), { recursive: true })
    await fs.writeFile(path.join(folderPath, 'launch', 'Plan.md'), '# Plan')

    await deleteWorkspaceFolderPermanently(folderPath)

    await expect(fs.stat(folderPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
