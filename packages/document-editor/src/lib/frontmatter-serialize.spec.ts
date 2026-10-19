import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './frontmatter-parser'
import { applyFrontmatter, serializeFrontmatter } from './frontmatter-serialize'

describe('serializeFrontmatter', () => {
  it('serializes a simple string field', () => {
    expect(serializeFrontmatter([{ key: 'title', value: 'Hello' }])).toBe(
      '---\ntitle: Hello\n---\n',
    )
  })

  it('quotes a value containing special characters', () => {
    const result = serializeFrontmatter([{ key: 'desc', value: 'a: b' }])
    expect(result).toContain('desc: "a: b"')
  })

  it('emits short array as inline list', () => {
    const result = serializeFrontmatter([{ key: 'tags', value: ['a', 'b', 'c'] }])
    expect(result).toBe('---\ntags: [a, b, c]\n---\n')
  })

  it('emits empty array as []', () => {
    expect(serializeFrontmatter([{ key: 'tags', value: [] }])).toBe('---\ntags: []\n---\n')
  })

  it('emits long array as block list', () => {
    const long = ['really-quite-a-long-value-1', 'really-quite-a-long-value-2', 'really-quite-a-long-value-3']
    const out = serializeFrontmatter([{ key: 'tags', value: long }])
    expect(out).toContain('tags:\n  - ')
  })

  it('returns empty string when no fields', () => {
    expect(serializeFrontmatter([])).toBe('')
  })
})

describe('applyFrontmatter', () => {
  it('inserts frontmatter when source has none', () => {
    const out = applyFrontmatter('# body\n', [{ key: 'title', value: 'X' }], null)
    expect(out).toBe('---\ntitle: X\n---\n# body\n')
  })

  it('replaces existing frontmatter', () => {
    const src = '---\ntitle: Old\n---\n# body'
    const parsed = parseFrontmatter(src)!
    const out = applyFrontmatter(src, [{ key: 'title', value: 'New' }], parsed)
    expect(out).toBe('---\ntitle: New\n---\n# body')
  })

  it('removes frontmatter when fields empty', () => {
    const src = '---\ntitle: Old\n---\n# body'
    const parsed = parseFrontmatter(src)!
    const out = applyFrontmatter(src, [], parsed)
    expect(out).toBe('# body')
  })
})
