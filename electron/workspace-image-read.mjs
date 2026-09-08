import fs from 'node:fs/promises'
import path from 'node:path'
import { assertWorkspacePathSafe } from './workspace-file-operations.mjs'
export async function readWorkspaceImage(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.startsWith('/') ||
    /[:\\\u0000-\u001f]/.test(relativePath) ||
    relativePath
      .split('/')
      .some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('Invalid workspace image path')
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }[path.extname(relativePath).toLowerCase()]
  if (!mime) throw new Error('Unsupported image format')
  const absolutePath = await assertWorkspacePathSafe(
    root,
    path.resolve(root, relativePath),
  )
  const stat = await fs.stat(absolutePath)
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
    throw new Error('Image exceeds 32 MB limit')
  const buffer = await fs.readFile(absolutePath)
  if (buffer.length > 32 * 1024 * 1024)
    throw new Error('Image exceeds 32 MB limit')
  return { mime_type: mime, base64_content: buffer.toString('base64') }
}
