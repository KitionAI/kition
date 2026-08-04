import { describe, expect, it } from 'vitest'

import {
  applyDocumentRevisionDecisions,
  buildDocumentRevisionDisplayBlocks,
  createDocumentRevisionComparison,
} from './documentRevision'

describe('document revision comparison', () => {
  it('keeps word-level additions and removals inside one changed paragraph', () => {
    const comparison = createDocumentRevisionComparison(
      'The quick brown fox jumps.\n',
      'The quick green fox jumps higher.\n',
    )

    expect(comparison.changes).toHaveLength(1)
    expect(comparison.changes[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removed', text: 'brown' }),
      expect.objectContaining({ kind: 'added', text: 'green' }),
      expect.objectContaining({ kind: 'added', text: ' higher' }),
    ]))
  })

  it('creates separate decisions for changes separated by unchanged lines', () => {
    const comparison = createDocumentRevisionComparison(
      'First old line.\nStable context.\nLast old line.\n',
      'First new line.\nStable context.\nLast new line.\n',
    )

    expect(comparison.changes).toHaveLength(2)
    expect(applyDocumentRevisionDecisions(comparison, {
      [comparison.changes[0].id]: 'accepted',
      [comparison.changes[1].id]: 'rejected',
    })).toBe('First new line.\nStable context.\nLast old line.\n')
  })

  it('supports accepting or rejecting pure insertions and deletions', () => {
    const comparison = createDocumentRevisionComparison(
      'Keep.\nRemove me.\n',
      'Keep.\nAdd me.\n',
    )
    const changeId = comparison.changes[0].id

    expect(applyDocumentRevisionDecisions(comparison, { [changeId]: 'accepted' }))
      .toBe('Keep.\nAdd me.\n')
    expect(applyDocumentRevisionDecisions(comparison, { [changeId]: 'rejected' }))
      .toBe('Keep.\nRemove me.\n')
  })

  it('builds a continuous line-numbered document around changed rows', () => {
    const comparison = createDocumentRevisionComparison(
      '# Title\nOld paragraph.\nStable context.\n',
      '# Title\nNew paragraph.\nStable context.\n',
    )
    const blocks = buildDocumentRevisionDisplayBlocks(comparison)

    expect(blocks.flatMap((block) => block.lines)).toEqual([
      expect.objectContaining({ kind: 'equal', text: '# Title', oldLineNumber: 1, newLineNumber: 1 }),
      expect.objectContaining({ kind: 'removed', text: 'Old paragraph.', oldLineNumber: 2, newLineNumber: null }),
      expect.objectContaining({ kind: 'added', text: 'New paragraph.', oldLineNumber: null, newLineNumber: 2 }),
      expect.objectContaining({ kind: 'equal', text: 'Stable context.', oldLineNumber: 3, newLineNumber: 3 }),
    ])
  })
})
