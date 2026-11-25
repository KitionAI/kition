import { describe, expect, it } from 'vitest'
import { documentCommentAccess, LOCAL_COMMENT_AUTHOR } from './documentComments'

describe('documentCommentAccess', () => {
  it('comments as the local person, with others’ threads as history', () => {
    const access = documentCommentAccess(false)
    expect(access).toMatchObject({ me: expect.any(String), canComment: true, othersReadOnly: true })
    expect(access.mine(LOCAL_COMMENT_AUTHOR)).toBe(true)
    expect(access.mine('u:someone-else')).toBe(false)
    // A read-only document takes no comments.
    expect(documentCommentAccess(true).canComment).toBe(false)
  })
})
