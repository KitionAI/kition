export type MarkdownLinkTarget = {
  path: string
  section?: string
}

export type MarkdownLinkPathResolver = (
  target: string,
  sourcePath?: string,
) => string | null

function decodeLinkPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeWorkspacePath(value: string): string {
  const segments: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

export function resolveMarkdownLinkTarget(
  href: string,
  sourcePath: string,
  resolvePath: MarkdownLinkPathResolver,
): MarkdownLinkTarget | null {
  let value = href.trim()
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim()
  }
  if (!value || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    return null
  }

  const hashIndex = value.indexOf('#')
  const queryIndex = value.indexOf('?')
  const pathEnd = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .reduce((smallest, index) => Math.min(smallest, index), value.length)
  const rawPath = value.slice(0, pathEnd)
  const rawSection = hashIndex >= 0 ? value.slice(hashIndex + 1) : ''
  const target = decodeLinkPart(rawPath)
  const sourceDirectory = normalizeWorkspacePath(sourcePath).split('/').slice(0, -1).join('/')
  const requestedPath = target
    ? normalizeWorkspacePath(target.startsWith('/') ? target : `${sourceDirectory}/${target}`)
    : normalizeWorkspacePath(sourcePath)
  const path = requestedPath
    ? resolvePath(`/${requestedPath}`, sourcePath) ?? requestedPath
    : ''
  if (!path) return null

  const section = rawSection ? `#${decodeLinkPart(rawSection)}` : undefined
  return { path, section }
}
