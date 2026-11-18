import { describe, expect, it } from 'vitest'

import { remapPathSetAfterMove } from './documentRename'

describe('remapPathSetAfterMove', () => {
  it('returns a new set with remapped members', () => {
    const paths = new Set(['a/x.md', 'b/y.md'])
    const result = remapPathSetAfterMove(paths, 'a/x.md', 'c/x.md')
    expect([...result]).toEqual(['c/x.md', 'b/y.md'])
    expect(result).not.toBe(paths)
  })
})
