import { describe, expect, it } from 'vitest'
import {
  buildCompletedTableFileImportPromptContext,
  isTableFileImportRequest,
} from './tableFileImportIntent'

describe('table file import intent', () => {
  it('recognizes direct import requests and rejects explicit negation', () => {
    const hanImport = String.fromCodePoint(0x5bfc, 0x5165)
    const hanDoNot = String.fromCodePoint(0x4e0d, 0x8981)

    expect(isTableFileImportRequest('Import @{reports.xlsx} into this table')).toBe(true)
    expect(isTableFileImportRequest(`${hanImport} @{reports.csv}`)).toBe(true)
    expect(isTableFileImportRequest('Do not import @{reports.csv}; summarize it')).toBe(false)
    expect(isTableFileImportRequest(`${hanDoNot}${hanImport} @{reports.csv}`)).toBe(false)
  })

  it('builds a completion context with record, field, and type counts', () => {
    const context = buildCompletedTableFileImportPromptContext({
      fieldCount: 2,
      fields: [
        { title: 'Title', type: 'text' },
        { title: 'Hours', type: 'number' },
      ],
      path: 'reports.xlsx',
      recordCount: 42,
    })

    expect(context).toContain('Imported records: 42')
    expect(context).toContain('Imported fields: 2')
    expect(context).toContain('Hours: number')
    expect(context).toContain('Do not read the source again')
  })
})
