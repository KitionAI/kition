import { describe, expect, it } from 'vitest'
import { addThread, commentThreads, COMMENT_TYPE, deleteComment, person, Replica, reply, system } from '@kition/kdm'
import { repairCommentThreads } from './documentComments'
import { DOCUMENT_BODY, documentSchema } from './documentSchema'
import { createDocumentReplica, documentRootId } from './documentText'

const ada = person('user:ada')
const said = (body: string) => ({ author: 'user:ada', body, created: '2026-01-01T00:00:00.000Z' })

/** A document with one thread of `count` comments, and a second replica of it. */
function twoReplicas(count: number) {
  const { replica: first, rootId } = createDocumentReplica('# Plan\n\nGoals\n', 1n)
  const { thread, comment } = first.transact(ada, (tx) => addThread(tx, { object: rootId, field: DOCUMENT_BODY, range: { start: 8, end: 13 }, quote: 'Goals' }, said('Which quarter?')))
  const comments = [comment]
  for (let index = 1; index < count; index += 1) comments.push(first.transact(ada, (tx) => reply(tx, thread, said(`Reply ${index}`))))
  const second = Replica.load(documentSchema, first.snapshot(), 2n)
  return { first, second, thread, comments }
}

/** Exchanges both replicas' changes, each repairing after its import, until they hold still. */
function exchange(a: Replica, b: Replica) {
  for (let round = 0; round < 3; round += 1) {
    b.importChanges(a.exportChanges(b.version()))
    b.transact(system('repair'), (tx) => repairCommentThreads(tx))
    a.importChanges(b.exportChanges(a.version()))
    a.transact(system('repair'), (tx) => repairCommentThreads(tx))
  }
}

const comments = (replica: Replica) => replica.objectsOfType(COMMENT_TYPE)

describe('repairCommentThreads', () => {
  it('leaves whole threads alone', () => {
    const { first } = twoReplicas(2)
    expect(first.transact(system('repair'), (tx) => repairCommentThreads(tx))).toBe(false)
    expect(commentThreads(first)[0].comments).toHaveLength(2)
  })

  it('deletes a thread whose comments two people deleted at once', () => {
    const { first, second, thread, comments: [c1, c2] } = twoReplicas(2)
    first.transact(ada, (tx) => deleteComment(tx, thread, c1))
    second.transact(ada, (tx) => deleteComment(tx, thread, c2))
    // Each delete left a comment on its own replica, so neither deleted the thread.
    second.importChanges(first.exportChanges(second.version()))
    expect(commentThreads(second)).toEqual([expect.objectContaining({ id: thread, comments: [] })])
    exchange(first, second)
    expect(commentThreads(first)).toEqual([])
    expect(first.stateText()).toBe(second.stateText())
  })

  it('deletes a reply to a thread someone deleted meanwhile', () => {
    const { first, second, thread, comments: [only] } = twoReplicas(1)
    first.transact(ada, (tx) => deleteComment(tx, thread, only))
    second.transact(ada, (tx) => reply(tx, thread, said('Q3')))
    second.importChanges(first.exportChanges(second.version()))
    // The thread is gone, its reply a comment in no thread.
    expect(commentThreads(second)).toEqual([])
    expect(comments(second)).toHaveLength(1)
    exchange(first, second)
    expect(comments(first)).toEqual([])
    expect(comments(second)).toEqual([])
    expect(first.stateText()).toBe(second.stateText())
    expect(documentRootId(first)).toBe(documentRootId(second))
  })
})
