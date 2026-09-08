import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { guardedWorkspaceWrite } from './workspace-guarded-write.mjs'
it('rejects a stale concurrent save and does not recreate an externally deleted file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-design-save-')),
    file = path.join(root, 'Poster.kidesign')
  try {
    await fs.writeFile(file, 'initial')
    const results = await Promise.allSettled([
      guardedWorkspaceWrite(file, 'initial', () => fs.writeFile(file, 'first')),
      guardedWorkspaceWrite(file, 'initial', () =>
        fs.writeFile(file, 'second'),
      ),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(await fs.readFile(file, 'utf8')).toBe('first')
    await fs.unlink(file)
    await expect(
      guardedWorkspaceWrite(file, 'first', () => fs.writeFile(file, 'stale')),
    ).rejects.toThrow('DESIGN_SAVE_CONFLICT')
    await expect(fs.stat(file)).rejects.toThrow()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
