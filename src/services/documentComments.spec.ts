import { afterEach, describe, expect, it } from 'vitest'
import { documentCommentAccess, LOCAL_COMMENT_AUTHOR, setCommentIdentity, setSharedCommentAccess } from './documentComments'

afterEach(() => {
  setSharedCommentAccess('Notes.md', null)
  localStorage.clear()
})

describe('documentCommentAccess', () => {
  it('comments as the local person on a document never co-edited, with others’ threads as history', () => {
    const access = documentCommentAccess('Draft.md', false)
    expect(access).toMatchObject({ me: expect.any(String), canComment: true, othersReadOnly: true })
    expect(access.mine(LOCAL_COMMENT_AUTHOR)).toBe(true)
    expect(access.mine('u:someone-else')).toBe(false)
    // A read-only document takes no comments without co-editing.
    expect(documentCommentAccess('Draft.md', true).canComment).toBe(false)
  })

  it('follows the room while co-edited: a commenter comments on a read-only text, a viewer does not', () => {
    setSharedCommentAccess('Notes.md', { principal: { id: 'u:bob', name: 'Bob' }, role: 'commenter' })
    expect(documentCommentAccess('Notes.md', true)).toMatchObject({ me: 'u:bob', name: 'Bob', canComment: true, othersReadOnly: false })
    setSharedCommentAccess('Notes.md', { principal: { id: 'u:bob', name: 'Bob' }, role: 'viewer' })
    expect(documentCommentAccess('Notes.md', true).canComment).toBe(false)
  })

  it('remembers the co-editing identity, so this person’s own threads stay theirs offline', () => {
    setCommentIdentity({ id: 'u:alice', name: 'Alice' })
    const access = documentCommentAccess('Notes.md', false)
    expect(access).toMatchObject({ me: 'u:alice', name: 'Alice', othersReadOnly: true })
    expect(access.mine('u:alice')).toBe(true)
    expect(JSON.parse(localStorage.getItem('kition.collab.identity.v1') ?? 'null')).toEqual({ id: 'u:alice', name: 'Alice' })
  })
})
