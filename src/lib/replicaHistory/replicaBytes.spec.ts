import { describe, expect, it } from 'vitest'
import { person, randomActor, Replica } from '@/lib/kdm'
import { createDocumentReplica, documentBody } from '@/features/document/kdm/documentText'
import { documentSchema } from '@/features/document/kdm/documentSchema'
import { applyTextEdits, diffText } from '@/features/document/kdm/documentMerge'
import { changesSince, fromHex, holdsVersion, includesVersion, mergeReplica, replicaIdOf, revertTo, stateAt, toHex, versionOf } from './replicaBytes'

const typing = person('user:test', 'typing')

function edit(replica: Replica, rootId: string, next: string) {
  const edits = diffText(documentBody(replica, rootId), next)
  replica.transact(typing, (tx) => applyTextEdits(tx, rootId, 'body', edits))
}

function text(bytes: Uint8Array) {
  const replica = Replica.load(documentSchema, bytes, randomActor())
  return documentBody(replica, replica.objectsOfType('Document')[0])
}

describe('replica bytes', () => {
  it('appends deltas, merges them back into one snapshot, and reads and restores past versions', () => {
    const { replica, rootId } = createDocumentReplica('one\n', randomActor())
    const snapshot = replica.snapshot()
    const first = replica.version().encode()
    const id = replicaIdOf(snapshot)
    expect(toHex(fromHex(id))).toBe(id)
    expect(versionOf([snapshot])).toEqual(first)

    edit(replica, rootId, 'one\ntwo\n')
    const second = replica.version().encode()
    const delta = changesSince(replica.snapshot(), first, id)
    expect(delta?.version).toEqual(second)
    edit(replica, rootId, 'one\ntwo\nthree\n')
    const third = changesSince(replica.snapshot(), second, id)

    // Snapshot plus the changes appended after it is the document.
    const merged = mergeReplica(snapshot, [delta!.changes, third!.changes])
    expect(text(merged.bytes)).toBe('one\ntwo\nthree\n')
    expect(includesVersion(merged.version, second)).toBe(true)
    expect(mergeReplica(snapshot, []).bytes).toBe(snapshot)

    // Another document, or a replica made anew, does not continue the stored one.
    const other = createDocumentReplica('one\n', randomActor()).replica
    expect(changesSince(other.snapshot(), first, id)).toBeNull()
    expect(changesSince(other.snapshot(), first, replicaIdOf(other.snapshot()))).toBeNull()

    // The document as of a version, and one change that brings it back there.
    const full = [replica.exportChanges()]
    expect(holdsVersion(full, second)).toBe(true)
    expect(holdsVersion([other.snapshot()], second)).toBe(false)
    expect(text(stateAt(full, second))).toBe('one\ntwo\n')
    const restore = revertTo(full, first)
    expect(restore).not.toBeNull()
    replica.importChanges(restore!)
    expect(documentBody(replica, rootId)).toBe('one\n')
    expect(revertTo([replica.exportChanges()], replica.version().encode())).toBeNull()
  })
})
