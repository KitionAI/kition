import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { readWorkspaceImage } from './workspace-image-read.mjs'
it('reads workspace-owned image bytes locally and rejects traversal, unsupported files, and escaping symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-design-image-'))
  try {
    await fs.mkdir(path.join(root, 'workspace'))
    await fs.writeFile(path.join(root, 'source.png'), 'fixture')
    await fs.writeFile(path.join(root, 'workspace', 'image.png'), 'pixels')
    expect(
      await readWorkspaceImage(path.join(root, 'workspace'), 'image.png'),
    ).toEqual({
      mime_type: 'image/png',
      base64_content: Buffer.from('pixels').toString('base64'),
    })
    await expect(
      readWorkspaceImage(path.join(root, 'workspace'), '../source.png'),
    ).rejects.toThrow()
    await expect(
      readWorkspaceImage(path.join(root, 'workspace'), 'secret.txt'),
    ).rejects.toThrow()
    await fs.symlink(
      path.join(root, 'source.png'),
      path.join(root, 'workspace', 'link.png'),
    )
    await expect(
      readWorkspaceImage(path.join(root, 'workspace'), 'link.png'),
    ).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
