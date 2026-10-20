// Copied from kition-sdk packages/sdk/src/capabilities.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Capability sets (Kit Standard 2.0 section 10): named, versioned groups of APIs a host or a
 * server advertises and a script tests, never a product or its version. A minor version only adds
 * members, so `Name a.b` satisfies a request for `Name a.c` when `c` is at most `b`.
 */
import { servesCapabilitySet } from '../sync'

/** The capability sets of Kit Standard 2.0. */
export const CAPABILITY_SETS = {
  model: 'KitModel 1.0',
  collab: 'KitCollab 1.0',
  objectModel: 'KitObjectModel 1.0',
  extensions: 'KitExtensions 1.0',
  embed: 'KitEmbed 1.0',
} as const

/** What this library serves by itself: the KDM and the object model over it. */
let advertised: readonly string[] = [CAPABILITY_SETS.model, CAPABILITY_SETS.objectModel]

/**
 * Declares the sets the environment a script runs in serves (a host's `capabilitySets`, a sync
 * server's `sync/hello` capabilities): what `supports` tests when given no list.
 */
export function advertiseCapabilitySets(sets: readonly string[]): void {
  advertised = [...sets]
}

/** The sets `supports` tests by default. */
export function capabilitySets(): readonly string[] {
  return advertised
}

/**
 * Whether `required` (such as `'KitCollab 1.0'`) is served by `sets` (by default what
 * `advertiseCapabilitySets` declared): a set of the same name and major version with at least its
 * minor version. A malformed name is never supported.
 */
export function supports(required: string, sets: readonly string[] = advertised): boolean {
  return servesCapabilitySet(required, sets)
}
