export function isPristine(current: unknown, snapshot: unknown): boolean {
  if (Object.is(current, snapshot)) return true
  if (typeof current !== typeof snapshot) return false
  if (current === null || snapshot === null) return current === snapshot

  if (Array.isArray(current)) {
    if (!Array.isArray(snapshot)) return false
    if (current.length !== snapshot.length) return false
    for (let i = 0; i < current.length; i++) {
      if (!isPristine(current[i], snapshot[i])) return false
    }
    return true
  }

  if (typeof current === 'object' && typeof snapshot === 'object') {
    const a = current as Record<string, unknown>
    const b = snapshot as Record<string, unknown>
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!isPristine(a[key], b[key])) return false
    }
    return true
  }

  return current === snapshot
}
