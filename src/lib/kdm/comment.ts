// Copied from kition-sdk packages/kdm/src/comment.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Comments (Kition Kit Standard 2.0, rule M23), as the `kition-kdm` crate's `comment` module.
 *
 * People discuss a document in comment threads anchored to its objects. A thread is an object of
 * the reserved type `CommentThread`: its `anchor` (an object, and optionally a field and a range in
 * it), whether it is `resolved`, and its `comments` in order. A comment is an object of the
 * reserved type `Comment`: its `author` (a principal id; a file's own author name for comments
 * imported from a file), their display `name` when it was written, its `body` text, and when it was
 * `created` (ISO 8601 UTC).
 *
 * Comments live beside the content, never inside it, so a principal that may only comment (the
 * sync protocol's `commenter` role, 1.6) changes only these two types, which a server checks
 * without knowing the kit. A kit that keeps comments declares both types in its schema as
 * `COMMENT_THREAD_TYPE_DEF` and `COMMENT_TYPE_DEF` (it may add optional register fields of its own).
 */
import { KdmError } from './errors'
import type { ObjectId } from './ids'
import type { Replica } from './replica'
import type { Tx } from './tx'

export const COMMENT_THREAD_TYPE = 'CommentThread'
export const COMMENT_TYPE = 'Comment'

/** The `CommentThread` type's definition, as a kit adds it to its schema's `types`. */
export const COMMENT_THREAD_TYPE_DEF = {
  fields: { anchor: { kind: 'json' }, resolved: { kind: 'boolean', optional: true }, comments: { kind: 'list', of: COMMENT_TYPE } },
} as const

/** The `Comment` type's definition, as a kit adds it to its schema's `types`. */
export const COMMENT_TYPE_DEF = {
  fields: { author: { kind: 'string' }, name: { kind: 'string', optional: true }, body: { kind: 'text' }, created: { kind: 'string' } },
} as const

/** Whether `ty` is one of the comment types: the only types a commenter's change may touch. */
export function isCommentType(ty: string): boolean {
  return ty === COMMENT_THREAD_TYPE || ty === COMMENT_TYPE
}

/**
 * Where a thread is anchored: an object, and optionally a field of it and a range in that field
 * (character offsets in a `text` field when the thread was made; `quote` is the text the range held
 * then, so an editor can find it again after edits around it). Kits may add keys of their own.
 */
export type CommentAnchor = {
  object: string
  field?: string
  range?: { start: number; end: number }
  quote?: string
  [key: string]: unknown
}

/** A comment to write. `created` is ISO 8601 UTC (`new Date().toISOString()`). */
export type NewComment = { author: string; name?: string; body: string; created: string }

export type Comment = { id: ObjectId; author: string; name?: string; body: string; created: string }

export type CommentThread = { id: ObjectId; anchor: CommentAnchor | null; resolved: boolean; comments: Comment[] }

function commentObject(tx: Tx, comment: NewComment): ObjectId {
  const fields: Record<string, unknown> = { author: comment.author, created: comment.created }
  if (comment.name !== undefined) fields.name = comment.name
  const id = tx.create(COMMENT_TYPE, fields)
  if (comment.body) tx.textInsert(id, 'body', 0, comment.body)
  return id
}

function checkThread(tx: Tx, thread: ObjectId) {
  if (tx.objectType(thread) !== COMMENT_THREAD_TYPE) throw new KdmError('invalid-value', `${thread} is not a ${COMMENT_THREAD_TYPE}`)
}

/** Opens a thread at `anchor` with its first comment. */
export function addThread(tx: Tx, anchor: CommentAnchor, comment: NewComment): { thread: ObjectId; comment: ObjectId } {
  const thread = tx.create(COMMENT_THREAD_TYPE, { anchor, resolved: false })
  const first = commentObject(tx, comment)
  tx.listInsert(thread, 'comments', 0, first)
  return { thread, comment: first }
}

/** Adds `comment` at the end of `thread`. */
export function reply(tx: Tx, thread: ObjectId, comment: NewComment): ObjectId {
  checkThread(tx, thread)
  const id = commentObject(tx, comment)
  tx.listInsert(thread, 'comments', tx.listItems(thread, 'comments').length, id)
  return id
}

/** Resolves `thread` (or opens it again). */
export function setResolved(tx: Tx, thread: ObjectId, resolved: boolean): void {
  checkThread(tx, thread)
  tx.set(thread, 'resolved', resolved)
}

/** Deletes one comment of `thread`; deleting its last comment deletes the thread. */
export function deleteComment(tx: Tx, thread: ObjectId, comment: ObjectId): void {
  checkThread(tx, thread)
  const items = tx.listItems(thread, 'comments')
  const index = items.indexOf(comment)
  if (index < 0) throw new KdmError('not-found', comment)
  tx.listRemove(thread, 'comments', index)
  tx.delete(comment)
  if (items.length === 1) tx.delete(thread)
}

/** Deletes `thread` and its comments. */
export function deleteThread(tx: Tx, thread: ObjectId): void {
  checkThread(tx, thread)
  for (const comment of tx.listItems(thread, 'comments')) if (tx.exists(comment)) tx.delete(comment)
  tx.delete(thread)
}

function asAnchor(value: unknown): CommentAnchor | null {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { object?: unknown }).object === 'string' ? (value as CommentAnchor) : null
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

/**
 * The document's comment threads, oldest first (by their first comment's `created`, then id), with
 * their live comments in order. Empty for a schema without the comment types.
 */
export function commentThreads(replica: Replica): CommentThread[] {
  const types = replica.schema.types
  if (!Object.hasOwn(types, COMMENT_THREAD_TYPE) || !Object.hasOwn(types, COMMENT_TYPE)) return []
  const threads: CommentThread[] = []
  for (const id of replica.objectsOfType(COMMENT_THREAD_TYPE)) {
    const comments: Comment[] = []
    for (const item of replica.list(id, 'comments')) {
      // A comment a concurrent delete removed while another replica replied stays listed but gone.
      if (!replica.exists(item) || replica.objectType(item) !== COMMENT_TYPE) continue
      const name = optionalString(replica.get(item, 'name'))
      comments.push({
        id: item,
        author: optionalString(replica.get(item, 'author')) ?? '',
        ...(name === undefined ? {} : { name }),
        body: replica.text(item, 'body'),
        created: optionalString(replica.get(item, 'created')) ?? '',
      })
    }
    threads.push({ id, anchor: asAnchor(replica.get(id, 'anchor')), resolved: replica.get(id, 'resolved') === true, comments })
  }
  const opened = (thread: CommentThread) => thread.comments[0]?.created ?? ''
  return threads.sort((a, b) => (opened(a) < opened(b) ? -1 : opened(a) > opened(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Where a range anchor's text is now: its `range` while the text there still reads `quote`,
 * otherwise the occurrence of `quote` nearest the old start, or `null` when the quote is gone (the
 * thread then shows without a place in the text). An anchor without a range or quote answers its
 * range as is.
 */
export function relocateAnchorRange(anchor: CommentAnchor, text: string): { start: number; end: number } | null {
  const range = anchor.range
  if (!range) return null
  const quote = anchor.quote
  if (!quote) return range.end <= text.length ? range : null
  if (text.slice(range.start, range.end) === quote) return range
  let best: number | null = null
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    if (best === null || Math.abs(at - range.start) < Math.abs(best - range.start)) best = at
  }
  return best === null ? null : { start: best, end: best + quote.length }
}
