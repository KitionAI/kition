import { beforeEach, describe, expect, it } from 'vitest'

import {
  readAgentDocumentContextsForWorkspace,
  resolveAgentDocumentContextPath,
  resolveAgentDocumentContextPaths,
  writeAgentDocumentContextsForSession,
} from './agentDocumentContexts'

describe('agent document context persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('persists attached and detached session context per workspace', () => {
    writeAgentDocumentContextsForSession('/workspaces/alpha', 7, [])
    writeAgentDocumentContextsForSession('/workspaces/alpha', 8, [
      'Docs/Brief.md',
      'Notes/Research.md',
    ])

    expect(readAgentDocumentContextsForWorkspace('/workspaces/alpha')).toEqual({
      7: [],
      8: ['Docs/Brief.md', 'Notes/Research.md'],
    })
    expect(readAgentDocumentContextsForWorkspace('/workspaces/beta')).toEqual({})
  })

  it('falls back to the active editor only when the session has no override', () => {
    expect(resolveAgentDocumentContextPath({}, 7, 'Docs/Current.md')).toBe('Docs/Current.md')
    expect(resolveAgentDocumentContextPath({ 7: [] }, 7, 'Docs/Current.md')).toBe('')
    expect(resolveAgentDocumentContextPath(
      { 7: ['Docs/Attached.md', 'Notes/Research.md'] },
      7,
      'Docs/Current.md',
    )).toBe('Docs/Attached.md')
    expect(resolveAgentDocumentContextPaths(
      { 7: ['Docs/Attached.md', 'Notes/Research.md'] },
      7,
      'Docs/Current.md',
    )).toEqual(['Docs/Attached.md', 'Notes/Research.md'])
  })
})
