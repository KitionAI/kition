import { describe, expect, it } from 'vitest'
import { analyzeCsvImport, applyCsvFieldTypeOverrides } from './csvImport'

describe('analyzeCsvImport', () => {
  it('normalizes a BOM-prefixed CSV with tabs around comma delimiters and a trailing empty field', () => {
    const content = [
      '\uFEFFOwner\t,Status\t,Hours\t,',
      'alice\t,Done\t,2.5\t,',
      'bob\t,Open\t,1.0\t,',
    ].join('\n')

    const result = analyzeCsvImport(content)

    expect(result.headers).toEqual(['Owner', 'Status', 'Hours'])
    expect(result.recordCount).toBe(2)
    expect(result.rows).toEqual([
      ['alice', 'Done', '2.5'],
      ['bob', 'Open', '1.0'],
    ])
    expect(result.fields.map((field) => field.type)).toEqual(['text', 'text', 'number'])
    expect(result.normalizedContent).toBe('Owner,Status,Hours\nalice,Done,2.5\nbob,Open,1.0\n')
  })

  it('preserves quoted commas, escaped quotes, and embedded newlines', () => {
    const result = analyzeCsvImport('Title,Notes\nOne,"Hello, ""world"""\nTwo,"Line 1\nLine 2"\n')

    expect(result.rows).toEqual([
      ['One', 'Hello, "world"'],
      ['Two', 'Line 1\nLine 2'],
    ])
    expect(result.normalizedContent).toContain('"Hello, ""world"""')
    expect(result.normalizedContent).toContain('"Line 1\nLine 2"')
  })

  it('infers categorical, long text, date, checkbox, URL, and numeric fields', () => {
    const rows = Array.from({ length: 10 }, (_, index) => [
      index % 2 ? 'Open' : 'Done',
      `${'A'.repeat(130)} ${index}`,
      `2026-08-${String(index + 1).padStart(2, '0')}`,
      index % 2 ? 'true' : 'false',
      `https://example.com/${index}`,
      String(index + 0.5),
    ].join(','))
    const result = analyzeCsvImport(['Status,Description,Due,Enabled,Link,Score', ...rows].join('\n'))

    expect(result.fields).toEqual([
      { title: 'Status', type: 'single_select', options: { choices: ['Done', 'Open'] } },
      { title: 'Description', type: 'long_text' },
      { title: 'Due', type: 'date' },
      { title: 'Enabled', type: 'checkbox' },
      { title: 'Link', type: 'url' },
      { title: 'Score', type: 'number' },
    ])
  })

  it('deduplicates headers without dropping columns', () => {
    const result = analyzeCsvImport('Name,Name,,\nalice,smith,value,\n')

    expect(result.headers).toEqual(['Name', 'Name 2', 'Column 3'])
    expect(result.rows[0]).toEqual(['alice', 'smith', 'value'])
  })

  it('applies reviewed field types and derives select choices', () => {
    const analysis = analyzeCsvImport('Status,Hours\nOpen,1\nDone,2\nOpen,3\n')
    const reviewed = applyCsvFieldTypeOverrides(analysis, [
      { index: 0, type: 'single_select' },
      { index: 1, type: 'text' },
    ])

    expect(reviewed.fields).toEqual([
      { title: 'Status', type: 'single_select', options: { choices: ['Open', 'Done'] } },
      { title: 'Hours', type: 'text' },
    ])
  })
})
