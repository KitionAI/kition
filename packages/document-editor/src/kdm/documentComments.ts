/**
 * Keeps a document's comment threads (Kit Standard 2.0 rule M23) whole after merges. Each command
 * keeps them whole on its own replica, but concurrent ones may not: two people deleting the two
 * comments of a thread leave it with none, and a reply to a thread someone else deleted is a
 * comment in no thread. Deleting the last comment of a thread deletes it, so the repair does the
 * same, and deletes comments no thread holds. Every replica that merges the same changes repairs
 * them the same way, and its deletions are no conflict with another's.
 */
import { COMMENT_THREAD_TYPE, COMMENT_TYPE, type ObjectId, type Tx } from '@kition/kdm'

const COMMENTS = 'comments'

/**
 * Repairs the comment threads of `tx`'s document (whose schema has the comment types): list
 * entries naming no comment, or one the list holds already, are removed; threads left without a
 * comment are deleted, and so are comments no thread holds. Answers whether it changed anything.
 */
export function repairCommentThreads(tx: Tx): boolean {
  let changed = false
  const held = new Set<ObjectId>()
  for (const thread of tx.objectsOfType(COMMENT_THREAD_TYPE)) {
    const items = tx.listItems(thread, COMMENTS)
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      const repeated = items.indexOf(item) < index
      if (!repeated && tx.exists(item) && tx.objectType(item) === COMMENT_TYPE) continue
      tx.listRemove(thread, COMMENTS, index)
      changed = true
    }
    const kept = tx.listItems(thread, COMMENTS)
    if (kept.length === 0) {
      tx.delete(thread)
      changed = true
      continue
    }
    for (const item of kept) held.add(item)
  }
  for (const comment of tx.objectsOfType(COMMENT_TYPE)) {
    if (held.has(comment)) continue
    tx.delete(comment)
    changed = true
  }
  return changed
}
