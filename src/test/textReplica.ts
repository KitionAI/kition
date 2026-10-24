/**
 * A KDM replica holding one text, for tests of what Kition does with replica bytes (stores,
 * histories, relays) without a kit's own document model.
 */
import { newDocId, parseSchema, person, Replica, system, type ObjectId } from '@/lib/kdm'

export const textSchema = parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Text', types: { Text: { fields: { body: { kind: 'text' } } } } })

/** A new replica whose text is `text`. */
export function createTextReplica(text: string, actor: bigint, docId: string = newDocId()): { replica: Replica; rootId: ObjectId } {
  const { replica, result: rootId } = Replica.createWith(textSchema, docId, actor, system('create'), (tx) => {
    const id = tx.create('Text', {})
    if (text) tx.textInsert(id, 'body', 0, text)
    return id
  })
  return { replica, rootId }
}

/** The replica's text. */
export function textOf(replica: Replica, rootId: ObjectId = replica.objectsOfType('Text')[0]): string {
  return replica.text(rootId, 'body')
}

/** Replaces the text after the part `next` shares with it at its start, as one person's edit. */
export function editText(replica: Replica, rootId: ObjectId, next: string) {
  const current = textOf(replica, rootId)
  let common = 0
  while (common < current.length && common < next.length && current[common] === next[common]) common += 1
  replica.transact(person('user:test', 'typing'), (tx) => {
    if (current.length > common) tx.textDelete(rootId, 'body', common, current.length - common)
    if (next.length > common) tx.textInsert(rootId, 'body', common, next.slice(common))
  })
}
