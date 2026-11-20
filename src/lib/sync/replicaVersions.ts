// Copied from kition-sdk packages/sync/src/replicaVersions.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * What the relay needs to know about KDM versions and change exports without a replica of its
 * own: whether an export carries anything, the version two versions together reach, and the
 * version a change export reaches. Not exported from the package's index: a host loads it on
 * demand (`@kition/sync/replicaVersions`), so a page that never relays a document never loads the
 * CRDT engine.
 */
import { decodeImportBlobMeta, VersionVector, type PeerID } from 'loro-crdt'
import { openEnvelope } from '../kdm'

export type ReplicaVersions = {
  /** Whether `changes` (a KDM change export) carries no change at all. */
  isEmpty: (changes: Uint8Array) => boolean
  /** The version holding every change of `a` and of `b`. */
  merge: (a: Uint8Array, b: Uint8Array) => Uint8Array
  /** The version `changes` reaches for each author it carries changes of; `null` if unreadable. */
  endOf: (changes: Uint8Array) => Uint8Array | null
  /** Whether `version` holds every change `other` holds. */
  includes: (version: Uint8Array, other: Uint8Array) => boolean
  /**
   * The version `changes` hold at their root, its own operations included, when they are a shallow
   * replica's snapshot, which a KDM export answers for a `since` that does not reach the root
   * (KitModel M16a); the empty version for a full snapshot; `null` for a change set.
   */
  snapshotRoot: (changes: Uint8Array) => Uint8Array | null
}

function counters(version: Uint8Array): Map<string, number> {
  return version.length ? new Map(VersionVector.decode(version).toJSON()) : new Map()
}

export const LORO_REPLICA_VERSIONS: ReplicaVersions = {
  isEmpty: (changes) => {
    try {
      return decodeImportBlobMeta(openEnvelope(changes).engine, false).changeNum === 0
    } catch {
      return false
    }
  },
  merge: (a, b) => {
    const merged = counters(a)
    for (const [peer, counter] of counters(b)) merged.set(peer, Math.max(counter, merged.get(peer) ?? 0))
    return VersionVector.parseJSON(merged as Map<PeerID, number>).encode()
  },
  endOf: (changes) => {
    try {
      return decodeImportBlobMeta(openEnvelope(changes).engine, false).partialEndVersionVector.encode()
    } catch {
      return null
    }
  },
  includes: (version, other) => {
    try {
      const held = counters(version)
      for (const [peer, counter] of counters(other)) if ((held.get(peer) ?? 0) < counter) return false
      return true
    } catch {
      return false
    }
  },
  snapshotRoot: (changes) => {
    let meta: ReturnType<typeof decodeImportBlobMeta>
    try {
      meta = decodeImportBlobMeta(openEnvelope(changes).engine, false)
    } catch {
      return null
    }
    if (meta.mode === 'update' || meta.mode === 'outdated-update') return null
    // A full snapshot's changes start at the empty version.
    if (meta.mode !== 'shallow-snapshot') return new Uint8Array()
    // A shallow snapshot's at its root: the version before the root's operations, and those.
    const root = new Map(meta.partialStartVersionVector.toJSON())
    for (const { peer, counter } of meta.startFrontiers) root.set(peer, Math.max(counter + 1, root.get(peer) ?? 0))
    return VersionVector.parseJSON(root).encode()
  },
}
