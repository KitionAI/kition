import fs from 'node:fs/promises'
const pending = new Map()
/** Serialize compare-and-write requests for the same file within the desktop process. */
export async function guardedWorkspaceWrite(
  absolutePath,
  expectedContent,
  write,
) {
  const previous = pending.get(absolutePath) || Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (expectedContent !== undefined) {
        const current = await fs
          .readFile(absolutePath, 'utf8')
          .catch((error) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
        if (current !== expectedContent) throw new Error('DESIGN_SAVE_CONFLICT')
      }
      return write()
    })
  pending.set(absolutePath, next)
  try {
    return await next
  } finally {
    if (pending.get(absolutePath) === next) pending.delete(absolutePath)
  }
}
