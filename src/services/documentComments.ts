/**
 * Who comments on a document here, and how (Kit Standard 2.0 rule M23). Co-editing sets it for the
 * documents it relays (this person's principal and role in the room); every other document is
 * not co-edited now, so comment threads others wrote are read-only history, and this person
 * comments as the identity they last co-edited with (or as the local person).
 */
/** The principal of edits and comments made in this window without a co-editing identity. */
export const LOCAL_COMMENT_AUTHOR = 'user:local'

export type CommentIdentity = { id: string; name: string }

/** A co-edited document's access: this person's principal there and their role. */
export type SharedCommentAccess = { principal: CommentIdentity; role: 'owner' | 'editor' | 'commenter' | 'viewer' }

export type DocumentCommentAccess = {
  /** The `author` of what this person writes. */
  me: string
  name?: string
  /** Whether this person may write comments. */
  canComment: boolean
  /** Threads others opened are read-only history: the document is not co-edited now. */
  othersReadOnly: boolean
  /** Whether `author` is this person (any identity they wrote comments as here). */
  mine: (author: string) => boolean
}

const IDENTITY_KEY = 'kition.collab.identity.v1'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readIdentity(): CommentIdentity | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(IDENTITY_KEY) || 'null') as Partial<CommentIdentity> | null
    return parsed && typeof parsed.id === 'string' && parsed.id ? { id: parsed.id, name: typeof parsed.name === 'string' ? parsed.name : '' } : null
  } catch {
    return null
  }
}

let identity: CommentIdentity | null = readIdentity()
const shared = new Map<string, SharedCommentAccess>()

/** Remembers the identity this person co-edits with (a sync server's `sync/hello` principal). */
export function setCommentIdentity(next: CommentIdentity) {
  if (identity?.id === next.id && identity.name === next.name) return
  identity = next
  storage()?.setItem(IDENTITY_KEY, JSON.stringify(next))
}

/** Marks the document at `path` co-edited with `access` (or no longer, with `null`). */
export function setSharedCommentAccess(path: string, access: SharedCommentAccess | null) {
  const current = shared.get(path)
  if (!access ? !current : current && current.role === access.role && current.principal.id === access.principal.id) return
  if (access) shared.set(path, access)
  else shared.delete(path)
}

/** The comment access of the document at `path`; `readOnly` documents take no comments unless co-editing allows them. */
export function documentCommentAccess(path: string, readOnly: boolean): DocumentCommentAccess {
  const room = shared.get(path)
  const own = new Set([LOCAL_COMMENT_AUTHOR, ...(identity ? [identity.id] : []), ...(room ? [room.principal.id] : [])])
  const mine = (author: string) => own.has(author)
  if (room) return { me: room.principal.id, name: room.principal.name, canComment: room.role !== 'viewer', othersReadOnly: false, mine }
  return { me: identity?.id ?? LOCAL_COMMENT_AUTHOR, ...(identity?.name ? { name: identity.name } : {}), canComment: !readOnly, othersReadOnly: true, mine }
}

