import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, person, Replica, Version } from '@/lib/kdm'
import { blobHashCandidates, decodeBlobSection, encodeBlobSection } from './blobSection'
import { LORO_REPLICA_VERSIONS as versions } from './replicaVersions'

const schema = parseSchema({ kdm: 1, kit: 'kit.collab-test', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' }, image: { kind: 'string', optional: true } } } } })

describe('replica versions over real KDM exports', () => {
  it('tells an empty export, and merges what a peer sent so it is not sent back', () => {
    const a = Replica.create(schema, newDocId(), 1n)
    const note = a.transact(person('user:a'), (tx) => tx.create('Note', {}))
    const b = Replica.load(schema, a.snapshot(), 2n)
    let sentFromB = b.version().encode()
    expect(versions.isEmpty(b.exportChanges(b.version()))).toBe(true)

    const before = a.version()
    a.transact(person('user:a'), (tx) => tx.textInsert(note, 'body', 0, 'hello'))
    const change = a.exportChanges(before)
    expect(versions.isEmpty(change)).toBe(false)
    b.importChanges(change)
    sentFromB = versions.merge(sentFromB, versions.endOf(change)!)
    // What B imported is covered: exporting since `sentFromB` has nothing of A's to send back.
    expect(versions.isEmpty(b.exportChanges(decode(sentFromB)))).toBe(true)
    b.transact(person('user:b'), (tx) => tx.textInsert(note, 'body', 5, '!'))
    expect(versions.isEmpty(b.exportChanges(decode(sentFromB)))).toBe(false)
  })

  it('finds a blob hash a change references', () => {
    const a = Replica.create(schema, newDocId(), 1n)
    const note = a.transact(person('user:a'), (tx) => tx.create('Note', {}))
    const hash = createHash('sha256').update('pixels').digest('hex')
    const before = a.version()
    a.transact(person('user:a'), (tx) => tx.set(note, 'image', hash))
    expect(blobHashCandidates(a.exportChanges(before))).toContain(hash)
  })

  it('tells whether a version holds every change of another', () => {
    const a = Replica.create(schema, newDocId(), 1n)
    const note = a.transact(person('user:a'), (tx) => tx.create('Note', {}))
    const b = Replica.load(schema, a.snapshot(), 2n)
    const seen = a.version().encode()
    b.transact(person('user:b'), (tx) => tx.textInsert(note, 'body', 0, 'later'))
    expect(versions.includes(b.version().encode(), seen)).toBe(true)
    expect(versions.includes(seen, b.version().encode())).toBe(false)
    expect(versions.includes(seen, new Uint8Array())).toBe(true)
    expect(versions.includes(new Uint8Array(), seen)).toBe(false)
  })
})

describe('blob sections', () => {
  it('round-trips entries', () => {
    const entries = [
      { hash: 'a'.repeat(64), data: new Uint8Array([1, 2, 3]) },
      { hash: 'b'.repeat(64), data: new Uint8Array() },
    ]
    expect(decodeBlobSection(encodeBlobSection(entries))).toEqual(entries)
    expect(() => decodeBlobSection(encodeBlobSection(entries).subarray(0, 70))).toThrow()
  })

  it('offers every 64-hex window of a hex run, and nothing shorter', () => {
    const hash = 'c'.repeat(63) + 'd'
    const bytes = new TextEncoder().encode(`x${hash}y` + 'e'.repeat(63))
    expect(blobHashCandidates(bytes)).toEqual([hash])
    expect(blobHashCandidates(new TextEncoder().encode(`9${hash}`))).toEqual([`9${hash.slice(0, 63)}`, hash])
  })
})

function decode(version: Uint8Array) {
  return Version.decode(version)
}
