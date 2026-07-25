import { isDesktopRuntime, resolvePublicFileURL } from './desktop'

export function resolveAgentImageURL(value?: string) {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }
  const legacyWorkspaceURL = resolveKitionWorkspaceURL(raw)
  if (legacyWorkspaceURL) {
    return legacyWorkspaceURL
  }
  if (isPublicOrExternalFileURL(raw)) {
    return resolvePublicFileURL(raw)
  }
  if (isWorkspaceImagePath(raw)) {
    return resolveWorkspaceFileURL(raw)
  }
  return resolvePublicFileURL(raw)
}

export function resolveWorkspaceImageURL(value: string | undefined, documentPath: string) {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }
  const legacyWorkspaceURL = resolveKitionWorkspaceURL(raw)
  if (legacyWorkspaceURL) {
    return legacyWorkspaceURL
  }
  if (isPublicOrExternalFileURL(raw)) {
    return resolvePublicFileURL(raw)
  }
  if (!isWorkspaceImagePath(raw)) {
    return raw
  }

  const { path, suffix } = splitPathSuffix(raw)
  const workspacePath = resolveWorkspaceMarkdownImagePath(decodeURIPath(path), parentDocumentFolderPath(documentPath))
  return workspacePath ? `${resolveWorkspaceFileURL(workspacePath)}${suffix}` : raw
}

export function resolveWorkspaceImageSources(html: string, documentPath: string) {
  if (!html || !isDesktopRuntime()) {
    return html
  }
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/gi, (match, before, src, after) => {
    const raw = String(src || '').trim()
    if (!raw) {
      return match
    }
    const decoded = decodeHTMLAttribute(raw)
    const workspaceURL = resolveWorkspaceImageURL(decoded, documentPath)
    if (!workspaceURL || workspaceURL === decoded) {
      return match
    }
    return `<img${before}src="${escapeHTMLAttribute(workspaceURL)}"${after}>`
  })
}

export function resolveWorkspaceFileURL(path: string) {
  const normalized = normalizeWorkspacePath(path)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return normalized ? resolvePublicFileURL(`/workspace-files/${normalized}`) : ''
}

export function resolveWorkspaceMarkdownImagePath(path: string, documentFolder: string) {
  const decoded = String(path || '').trim().replace(/\\/g, '/')
  if (!decoded) {
    return ''
  }
  const folderParts = normalizeWorkspacePath(documentFolder)
  const imageParts = decoded.split('/').filter(Boolean)
  const documentRoot = folderParts[0] || ''
  const imageRoot = imageParts[0] || ''
  if (documentRoot && imageRoot === documentRoot) {
    return imageParts.join('/')
  }
  return normalizeWorkspacePath([...folderParts, ...imageParts].join('/')).join('/')
}

export function normalizeWorkspacePath(path: string) {
  const parts: string[] = []
  String(path || '')
    .trim()
    .replace(/^\/+/, '')
    .split('/')
    .forEach((part) => {
      if (!part || part === '.') {
        return
      }
      if (part === '..') {
        parts.pop()
        return
      }
      parts.push(part)
    })
  return parts
}

export function isWorkspaceImagePath(path: string) {
  const raw = String(path || '').trim()
  if (!raw || isPublicOrExternalFileURL(raw)) {
    return false
  }
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(raw.split(/[?#]/)[0])
}

export function isPublicOrExternalFileURL(path: string) {
  return /^(https?:|data:|blob:|file:|kition-workspace:|\/)/i.test(String(path || '').trim())
}

export function parentDocumentFolderPath(path: string) {
  const normalized = String(path || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function splitPathSuffix(path: string) {
  const match = String(path || '').match(/^([^?#]*)([?#].*)?$/)
  return {
    path: match?.[1] || '',
    suffix: match?.[2] || '',
  }
}

function resolveKitionWorkspaceURL(path: string) {
  if (!/^kition-workspace:/i.test(String(path || '').trim())) {
    return ''
  }
  const { path: legacyPath, suffix } = splitPathSuffix(path)
  const workspacePath = legacyPath.replace(/^kition-workspace:\/{0,2}/i, '').replace(/^\/+/, '')
  if (!workspacePath) {
    return ''
  }
  return `${resolveWorkspaceFileURL(decodeURIPath(workspacePath))}${suffix}`
}

function decodeURIPath(path: string) {
  return String(path || '')
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

function decodeHTMLAttribute(value: string) {
  try {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = value
    return textarea.value
  } catch {
    return value
  }
}

function escapeHTMLAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
