/**
 * Who comments on a document here, and how (Kition platform rule M23). Kition Desktop has one
 * person: they comment as the local person, and comment threads others wrote (in a file someone
 * sent them) are read-only history.
 */
/** The principal of edits and comments made in this window. */
export const LOCAL_COMMENT_AUTHOR = 'user:local'

export type DocumentCommentAccess = {
  /** The `author` of what this person writes. */
  me: string
  /** Whether this person may write comments. */
  canComment: boolean
  /** Threads others opened are read-only history. */
  othersReadOnly: boolean
  /** Whether `author` is this person. */
  mine: (author: string) => boolean
}

/** The comment access of a document; a `readOnly` document takes no comments. */
export function documentCommentAccess(readOnly: boolean): DocumentCommentAccess {
  return { me: LOCAL_COMMENT_AUTHOR, canComment: !readOnly, othersReadOnly: true, mine: (author) => author === LOCAL_COMMENT_AUTHOR }
}
