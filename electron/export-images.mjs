/**
 * Inlining images into exported document HTML: workspace images become
 * data URLs so clipboard and PDF exports carry them. The pure helpers are
 * exported directly; `createExportImageInliner` takes the main-process
 * dependencies (workspace path resolution, file reads, network) so the
 * logic stays testable without Electron.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function decodeURIPath(pathname) {
  return String(pathname || '')
    .split('/')
    .map((part) => {
      let decoded = part
      for (let index = 0; index < 3; index += 1) {
        try {
          const next = decodeURIComponent(decoded)
          if (next === decoded) {
            break
          }
          decoded = next
        } catch {
          break
        }
      }
      return decoded
    })
    .join('/')
}

function stripURLSuffix(value) {
  return String(value || '').replace(/[?#].*$/, '')
}

export function unwrapMarkdownDestination(value) {
  const raw = String(value || '').trim()
  return raw.startsWith('<') && raw.endsWith('>')
    ? raw.slice(1, -1).trim()
    : raw
}

export function parentWorkspacePath(documentPath) {
  const normalized = String(documentPath || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

export function isImagePath(value) {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(stripURLSuffix(value))
}

export function isWorkspaceRootImagePath(value) {
  const [root = ''] = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  return ['agent', 'attachments', '.kition'].includes(root.toLowerCase())
}

export function imageMimeTypeFromPath(filePath) {
  switch (path.extname(stripURLSuffix(filePath)).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.avif':
      return 'image/avif'
    case '.png':
    default:
      return 'image/png'
  }
}

export function unresolvedClipboardImageSources(html) {
  const sources = []
  const imageSourcePattern = /<img\b[^>]*?\bsrc=(["'])(.*?)\1[^>]*>/gi
  for (const match of String(html || '').matchAll(imageSourcePattern)) {
    const source = decodeHtmlAttribute(match[2])
    if (source && !/^data:image\//i.test(source)) {
      sources.push(source)
    }
  }
  return sources
}

/**
 * @param {{
 *   getBackendPublicBaseURL: () => string
 *   getWorkspaceRoot: () => string
 *   resolveSafeWorkspacePath: (relativePath: string) => Promise<{ absolutePath: string }>
 *   resolveSafeWorkspaceProtocolPath: (url: string) => Promise<{ absolutePath: string }>
 *   assertWorkspacePathSafe: (root: string, target: string) => Promise<string>
 *   readFile: (filePath: string) => Promise<Buffer>
 *   fetchImage: (url: string) => Promise<{ ok: boolean; status: number; headers: { get: (name: string) => string | null }; arrayBuffer: () => Promise<ArrayBuffer> }>
 * }} deps
 */
export function createExportImageInliner(deps) {
  function resolveExportImageURL(src) {
    const raw = String(src || '').trim()
    if (!raw || /^(data:|blob:)/i.test(raw)) {
      return ''
    }
    if (/^(kition-workspace:|https?:\/\/)/i.test(raw)) {
      return raw
    }
    if (raw.startsWith('/')) {
      return new URL(raw, deps.getBackendPublicBaseURL()).toString()
    }
    return ''
  }

  function workspaceRelativePathFromPublicURL(raw) {
    const value = String(raw || '').trim()
    if (!value) {
      return ''
    }

    try {
      const parsedURL = new URL(value, deps.getBackendPublicBaseURL())
      const backendURL = new URL(deps.getBackendPublicBaseURL())
      const isBackendURL = parsedURL.origin === backendURL.origin
      const isRootRelativeURL = value.startsWith('/')
      if ((isBackendURL || isRootRelativeURL) && parsedURL.pathname.startsWith('/workspace-files/')) {
        return decodeURIPath(parsedURL.pathname.slice('/workspace-files/'.length))
      }
    } catch {
      return ''
    }

    return ''
  }

  async function exportImageFilePath(src, documentPath = '') {
    const raw = unwrapMarkdownDestination(src)
    if (!raw || (/^(data:|blob:|https?:\/\/)/i.test(raw) && !workspaceRelativePathFromPublicURL(raw))) {
      return ''
    }

    try {
      if (/^kition-workspace:/i.test(raw)) {
        return (await deps.resolveSafeWorkspaceProtocolPath(raw)).absolutePath
      }

      if (/^file:/i.test(raw)) {
        const absolutePath = fileURLToPath(stripURLSuffix(raw))
        const resolvedRoot = path.resolve(deps.getWorkspaceRoot())
        const resolvedTarget = path.resolve(absolutePath)
        if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
          return ''
        }
        return await deps.assertWorkspacePathSafe(resolvedRoot, resolvedTarget)
      }

      const publicWorkspacePath = workspaceRelativePathFromPublicURL(raw)
      if (publicWorkspacePath) {
        return (await deps.resolveSafeWorkspacePath(publicWorkspacePath)).absolutePath
      }

      if (isImagePath(raw)) {
        const relativePath = stripURLSuffix(raw).replace(/^\/+/, '')
        const basePath = isWorkspaceRootImagePath(relativePath)
          ? ''
          : parentWorkspacePath(documentPath)
        return (await deps.resolveSafeWorkspacePath(
          basePath ? `${basePath}/${relativePath}` : relativePath,
        )).absolutePath
      }
    } catch (error) {
      console.warn('failed to resolve export image file:', raw, error)
    }

    return ''
  }

  async function imageFileToDataURL(filePath) {
    if (!filePath) {
      return ''
    }
    try {
      const buffer = await deps.readFile(filePath)
      return `data:${imageMimeTypeFromPath(filePath)};base64,${buffer.toString('base64')}`
    } catch (error) {
      console.warn('failed to inline export image file:', filePath, error)
      return ''
    }
  }

  async function imageSourceToDataURL(src, documentPath = '') {
    const localDataURL = await imageFileToDataURL(await exportImageFilePath(src, documentPath))
    if (localDataURL) {
      return localDataURL
    }

    const url = resolveExportImageURL(src)
    if (!url) {
      return ''
    }
    try {
      const response = await deps.fetchImage(url)
      if (!response.ok) {
        console.warn('failed to inline export image:', url, response.status)
        return ''
      }
      const contentType = response.headers.get('content-type') || 'image/png'
      if (!/^image\//i.test(contentType)) {
        return ''
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      return `data:${contentType};base64,${buffer.toString('base64')}`
    } catch (error) {
      console.warn('failed to inline export image:', url, error)
      return ''
    }
  }

  async function inlineExportImages(html, documentPath = '') {
    const sourceByRawValue = new Map()
    const imageSourcePattern = /<img\b[^>]*?\bsrc=(["'])(.*?)\1[^>]*>/gi
    for (const match of String(html || '').matchAll(imageSourcePattern)) {
      const rawValue = match[2]
      if (!sourceByRawValue.has(rawValue)) {
        sourceByRawValue.set(rawValue, null)
      }
    }
    if (!sourceByRawValue.size) {
      return html
    }

    for (const rawValue of sourceByRawValue.keys()) {
      sourceByRawValue.set(rawValue, await imageSourceToDataURL(decodeHtmlAttribute(rawValue), documentPath))
    }

    return String(html || '').replace(imageSourcePattern, (tag, quote, rawValue) => {
      const dataURL = sourceByRawValue.get(rawValue)
      if (!dataURL) {
        return tag
      }
      return tag.replace(`${quote}${rawValue}${quote}`, `${quote}${escapeHtmlAttribute(dataURL)}${quote}`)
    })
  }

  return { exportImageFilePath, imageSourceToDataURL, inlineExportImages, resolveExportImageURL, workspaceRelativePathFromPublicURL }
}
