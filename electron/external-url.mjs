const allowedExternalProtocols = new Set(['http:', 'https:', 'mailto:'])

export function normalizeExternalURL(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('url is required')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('url must be absolute')
  }
  if (!allowedExternalProtocols.has(parsed.protocol)) {
    throw new Error(`url protocol is not allowed: ${parsed.protocol}`)
  }
  return parsed.toString()
}

export function isTrustedWindowNavigation(targetValue, initialValue) {
  try {
    const target = new URL(targetValue)
    const initial = new URL(initialValue)
    if (target.protocol !== initial.protocol) return false
    if (initial.protocol === 'file:') {
      return target.host === initial.host && target.pathname === initial.pathname
    }
    if (initial.protocol === 'about:') return target.toString() === initial.toString()
    return target.origin === initial.origin
  } catch {
    return false
  }
}
