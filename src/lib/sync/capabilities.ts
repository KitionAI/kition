// Copied from kition-sdk packages/sync/src/capabilities.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Capability sets in `sync/hello` (Kit Standard `spec/index.md` section 3.1, rule CS2): next to its protocol
 * capabilities (`leases`, `headless`), a server lists the versioned capability sets it serves for
 * the principal, such as `"KitModel 1.0"` and `"KitCollab 1.1"`. A set is `Name major.minor`; a
 * minor version only adds members, so `Name a.b` serves a request for `Name a.c` when `c` is at
 * most `b`. Scripts test for a set, never for a server product or its version.
 */

/** `Name major.minor` as its parts; `null` for anything else (a protocol capability). */
export function parseCapabilitySet(set: string): { name: string; major: number; minor: number } | null {
  const match = /^([A-Z][A-Za-z0-9]*) (\d+)\.(\d+)$/.exec(set.trim())
  return match ? { name: match[1], major: Number(match[2]), minor: Number(match[3]) } : null
}

/** The capability sets among `capabilities` (what `sync/hello` lists), in their order. */
export function capabilitySetsOf(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => typeof capability === 'string' && parseCapabilitySet(capability) !== null)
}

/**
 * Whether `sets` serve `required` (such as `'KitCollab 1.0'`): a set of the same name and major
 * version with at least its minor version. A malformed name is never served.
 */
export function servesCapabilitySet(required: string, sets: readonly string[]): boolean {
  const wanted = parseCapabilitySet(required)
  if (!wanted) return false
  return sets.some((set) => {
    const offered = typeof set === 'string' ? parseCapabilitySet(set) : null
    return offered !== null && offered.name === wanted.name && offered.major === wanted.major && offered.minor >= wanted.minor
  })
}
