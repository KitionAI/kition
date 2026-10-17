/**
 * What the relay needs to know about KDM versions and change exports without a replica of its
 * own: whether an export carries anything, the version two versions together reach, and the
 * version a change export reaches. Loaded on demand (`loadReplicaVersions`), so a window that
 * never relays a document never loads the CRDT engine.
 */
import { decodeImportBlobMeta, VersionVector, type PeerID } from 'loro-crdt'
import { open } from '@/lib/kdm/envelope'

export type ReplicaVersions = {
  /** Whether `changes` (a KDM change export) carries no change at all. */
  isEmpty: (changes: Uint8Array) => boolean
  /** The version holding every change of `a` and of `b`. */
  merge: (a: Uint8Array, b: Uint8Array) => Uint8Array
  /** The version `changes` reaches for each author it carries changes of; `null` if unreadable. */
  endOf: (changes: Uint8Array) => Uint8Array | null
  /** Whether `version` holds every change `other` holds. */
  includes: (version: Uint8Array, other: Uint8Array) => boolean
}

function counters(version: Uint8Array): Map<string, number> {
  return version.length ? new Map(VersionVector.decode(version).toJSON()) : new Map()
}

export const LORO_REPLICA_VERSIONS: ReplicaVersions = {
  isEmpty: (changes) => {
    try {
      return decodeImportBlobMeta(open(changes).engine, false).changeNum === 0
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
      return decodeImportBlobMeta(open(changes).engine, false).partialEndVersionVector.encode()
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
}
