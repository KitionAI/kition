import { describe, it, expect } from 'vitest'
import { sliceForEmbed } from './_embed-slice'

const doc = [
  '# A',
  'para A',
  '',
  '## B',
  'para B',
  '',
  '### C',
  'para C',
  '',
  '## D',
  'para D',
].join('\n')

describe('sliceForEmbed', () => {
  it('returns first 80 lines when no heading/blockId given', () => {
    expect(sliceForEmbed('a\nb\nc', undefined, undefined)).toBe('a\nb\nc')
  })

  it('slices a heading section to the next equal-or-higher level', () => {
    const out = sliceForEmbed(doc, 'B', undefined)
    expect(out).toContain('## B')
    expect(out).toContain('### C')
    expect(out).toContain('para C')
    expect(out).not.toContain('## D')
  })

  it('matches heading case-insensitively', () => {
    expect(sliceForEmbed(doc, 'b', undefined)).toContain('## B')
  })

  it('returns empty string when heading not found', () => {
    expect(sliceForEmbed(doc, 'Z', undefined)).toBe('')
  })

  it('slices around a block-id with ±3 lines context', () => {
    const blockDoc = [
      'l1',
      'l2',
      'l3',
      'l4 ^foo',
      'l5',
      'l6',
      'l7',
      'l8',
    ].join('\n')
    const out = sliceForEmbed(blockDoc, undefined, 'foo')
    expect(out).toContain('l4 ^foo')
    expect(out).toContain('l3')
    expect(out).toContain('l5')
  })

  it('returns empty string when block-id not found', () => {
    expect(sliceForEmbed('l1\nl2', undefined, 'foo')).toBe('')
  })
})
