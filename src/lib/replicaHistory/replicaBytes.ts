/**
 * KDM replicas as bytes (a snapshot or a change export, in the KDM envelope), for what keeps and restores them without
 * a kit's schema: the document store (a snapshot and the changes appended after it), the deltas a save appends, and
 * the document as of a version in its history. Every replica holds its whole history, so a version it ever had can be
 * read again (`stateAt`) and restored as one new change (`revertTo`). Loaded on demand: it carries the CRDT engine.
 */
import { LoroDoc, VersionVector } from 'loro-crdt'
import { openEnvelope } from '@/lib/kdm'
import { wrap } from '@/lib/kdm/envelope'

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('not a hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

/** The replica's document id (its envelope's), as lowercase hex. */
export function replicaIdOf(bytes: Uint8Array): string {
  return toHex(openEnvelope(bytes).docId)
}

function load(parts: readonly Uint8Array[]): { doc: LoroDoc; docId: Uint8Array } {
  const doc = new LoroDoc()
  let docId: Uint8Array | null = null
  for (const part of parts) {
    const opened = openEnvelope(part)
    if (docId && toHex(docId) !== toHex(opened.docId)) throw new Error('the bytes belong to different documents')
    docId ??= opened.docId
    doc.import(opened.engine)
  }
  if (!docId) throw new Error('no replica bytes')
  return { doc, docId }
}

/** The version (an encoded version vector) `bytes` brings a replica to. */
export function versionOf(parts: readonly Uint8Array[]): Uint8Array {
  return load(parts).doc.oplogVersion().encode()
}

/**
 * A stored replica as one snapshot: `snapshot` with `changes` imported in order, and the version it holds. Answers
 * `snapshot` itself when there are no changes.
 */
export function mergeReplica(snapshot: Uint8Array, changes: readonly Uint8Array[]): { bytes: Uint8Array; version: Uint8Array } {
  const { doc, docId } = load([snapshot, ...changes])
  const version = doc.oplogVersion().encode()
  if (!changes.length) return { bytes: snapshot, version }
  return { bytes: wrap(docId, doc.export({ mode: 'snapshot' })), version }
}

/** Whether `version` holds every change of `other` (encoded version vectors; empty is the empty version). */
export function includesVersion(version: Uint8Array, other: Uint8Array): boolean {
  if (!other.length) return true
  if (!version.length) return false
  const order = VersionVector.decode(version).compare(VersionVector.decode(other))
  return order === 0 || order === 1
}

/**
 * The changes `replica` (a snapshot or a full export) holds that a replica at `since` lacks, in the envelope, and the
 * version `replica` holds; `null` when `replica` does not continue `since` (another document, or a replica that lacks
 * some of its changes: one made anew).
 */
export function changesSince(replica: Uint8Array, since: Uint8Array, replicaId: string): { changes: Uint8Array; version: Uint8Array } | null {
  const { doc, docId } = load([replica])
  if (toHex(docId) !== replicaId) return null
  const version = doc.oplogVersion().encode()
  if (!includesVersion(version, since)) return null
  const from = since.length ? VersionVector.decode(since) : new VersionVector(null)
  return { changes: wrap(docId, doc.export({ mode: 'update', from })), version }
}

function frontiersAt(doc: LoroDoc, version: Uint8Array) {
  if (!includesVersion(doc.oplogVersion().encode(), version)) throw new Error('the replica does not hold that version')
  return doc.vvToFrontiers(VersionVector.decode(version))
}

/** The document as of `version` (which `full`, a replica with its history, must hold), as a snapshot. */
export function stateAt(full: readonly Uint8Array[], version: Uint8Array): Uint8Array {
  const { doc, docId } = load(full)
  const fork = doc.forkAt(frontiersAt(doc, version))
  return wrap(docId, fork.export({ mode: 'snapshot' }))
}

/** Whether `full` holds `version` in its history (so it can be shown and restored). */
export function holdsVersion(full: readonly Uint8Array[], version: Uint8Array): boolean {
  try {
    return includesVersion(load(full).doc.oplogVersion().encode(), version)
  } catch {
    return false
  }
}

/**
 * One new change that brings the document `full` holds back to how it was at `version`, made by a new author of its
 * own (so it is nobody's undo step and merges with concurrent edits like any change); `null` when the document is
 * already that way.
 */
export function revertTo(full: readonly Uint8Array[], version: Uint8Array): Uint8Array | null {
  const { doc, docId } = load(full)
  const frontiers = frontiersAt(doc, version)
  const before = doc.oplogVersion()
  doc.revertTo(frontiers)
  doc.commit({ origin: 'restore' })
  const after = doc.oplogVersion()
  if (before.compare(after) === 0) return null
  return wrap(docId, doc.export({ mode: 'update', from: before }))
}
