import { describe, expect, it } from 'vitest'

import { resolveInitialDocumentPath } from './initialDocument'

const items = [
  { path: 'Home.md' },
  { path: 'notes/a.md' },
  { path: 'data/leads.kitable', format: 'data' as const },
  { path: 'assets/logo.png' },
]

describe('resolveInitialDocumentPath', () => {
  it('prefers the explicit path, then the open document, then the last active one, then Home', () => {
    expect(resolveInitialDocumentPath(items, { preferredPath: 'notes/a.md', activeDocumentPath: 'Home.md' })).toBe('notes/a.md')
    expect(resolveInitialDocumentPath(items, { activeDocumentPath: 'notes/a.md', lastActivePath: 'Home.md' })).toBe('notes/a.md')
    expect(resolveInitialDocumentPath(items, { lastActivePath: 'notes/a.md' })).toBe('notes/a.md')
    expect(resolveInitialDocumentPath(items, {})).toBe('Home.md')
  })

  it('skips candidates that are no longer listed or not editable and falls back to the first editable file', () => {
    expect(resolveInitialDocumentPath(items, { preferredPath: 'gone.md', lastActivePath: 'assets/logo.png' })).toBe('Home.md')
    expect(resolveInitialDocumentPath([{ path: 'assets/logo.png' }, { path: 'z.md' }], { preferredPath: 'assets/logo.png' })).toBe('z.md')
    expect(resolveInitialDocumentPath([{ path: 'assets/logo.png' }], {})).toBe('')
  })
})
