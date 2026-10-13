import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, person, Replica } from './index'

const schema = parseSchema({ kdm: 1, kit: 'kit.smoke', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' } } } } })

describe('@kition/kdm in Kition', () => {
  it('creates, edits, snapshots, and reloads a document', () => {
    const doc = Replica.create(schema, newDocId(), 1n)
    const note = doc.transact(person('user:smoke'), (tx) => tx.create('Note', {}))
    doc.transact(person('user:smoke'), (tx) => tx.textInsert(note, 'body', 0, 'hello'))
    const copy = Replica.load(schema, doc.snapshot(), 2n)
    expect(copy.text(note, 'body')).toBe('hello')
  })
})
