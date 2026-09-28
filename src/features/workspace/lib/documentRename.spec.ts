import { describe, expect, it } from 'vitest'

import { remapPathSetAfterMove, remapSnapshotsAfterMove } from './documentRename'

describe('remapSnapshotsAfterMove', () => {
  it('moves the renamed document and its descendants, leaving others untouched', () => {
    const snapshots = [
      { path: 'notes/old.md', name: 'old.md', content: 'a' },
      { path: 'notes/old/child.md', name: 'child.md', content: 'b' },
      { path: 'other.md', name: 'other.md', content: 'c' },
    ]
    const result = remapSnapshotsAfterMove(snapshots, 'notes/old.md', 'notes/new.md', 'new.md')
    expect(result[0]).toEqual({ path: 'notes/new.md', name: 'new.md', content: 'a' })
    // Attachments folders follow the document's stem.
    expect(result[1]).toEqual({ path: 'notes/new/child.md', name: 'child.md', content: 'b' })
    expect(result[2]).toBe(snapshots[2])
  })
})

describe('remapPathSetAfterMove', () => {
  it('returns a new set with remapped members', () => {
    const paths = new Set(['a/x.md', 'b/y.md'])
    const result = remapPathSetAfterMove(paths, 'a/x.md', 'c/x.md')
    expect([...result]).toEqual(['c/x.md', 'b/y.md'])
    expect(result).not.toBe(paths)
  })
})
