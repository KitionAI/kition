export const KITION_PROTOCOL_SCHEME = 'kition'

export function normalizeKitionDeepLink(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== `${KITION_PROTOCOL_SCHEME}:`) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

export function findKitionDeepLink(values = []) {
  for (const value of values) {
    const normalized = normalizeKitionDeepLink(value)
    if (normalized) return normalized
  }
  return ''
}
