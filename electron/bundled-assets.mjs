import fs from 'node:fs/promises'
import path from 'node:path'

export const KITION_BUNDLED_ASSET_SCHEME = 'kition-bundled'
export const KITION_BUNDLED_ASSET_HOST = 'assets'

const contentTypes = new Map([
  ['.csv', 'text/csv; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
])

export function resolveBundledAssetPath(requestURL, distDir) {
  const parsed = new URL(requestURL)
  if (parsed.protocol !== `${KITION_BUNDLED_ASSET_SCHEME}:`) {
    throw new Error('bundled asset protocol is invalid')
  }
  if (parsed.hostname !== KITION_BUNDLED_ASSET_HOST) {
    throw new Error('bundled asset host is invalid')
  }

  const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  if (!relativePath || relativePath.includes('\0')) {
    throw new Error('bundled asset path is invalid')
  }

  const root = path.resolve(distDir)
  const absolutePath = path.resolve(root, relativePath)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('bundled asset path is outside the renderer bundle')
  }
  return absolutePath
}

export async function createBundledAssetResponse(requestURL, distDir) {
  try {
    const absolutePath = resolveBundledAssetPath(requestURL, distDir)
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 })
    }
    const bytes = await fs.readFile(absolutePath)
    const contentType = contentTypes.get(path.extname(absolutePath).toLowerCase())
      || 'application/octet-stream'
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': contentType,
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
