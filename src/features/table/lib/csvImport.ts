import type { DataFieldOptions, DataFieldType } from '@/types/dataDocument'

const CSV_DELIMITERS = [',', '\t', ';'] as const
const MAX_SINGLE_SELECT_CHOICES = 50
const MIN_SINGLE_SELECT_ROWS = 8

export type CsvFieldInference = {
  title: string
  type: DataFieldType
  options?: DataFieldOptions
}

export type CsvImportAnalysis = {
  fields: CsvFieldInference[]
  headers: string[]
  normalizedContent: string
  recordCount: number
  rows: string[][]
}

export type CsvFieldTypeOverride = {
  index: number
  type: CsvFieldInference['type']
}

function parseDelimitedRows(content: string, delimiter: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]

    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          value += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        value += character
      }
      continue
    }

    if (character === '"' && value.trim().length === 0) {
      quoted = true
      continue
    }
    if (character === delimiter) {
      row.push(value)
      value = ''
      continue
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') {
        index += 1
      }
      row.push(value)
      rows.push(row)
      row = []
      value = ''
      continue
    }
    value += character
  }

  if (value.length || row.length) {
    row.push(value)
    rows.push(row)
  }

  return rows
}

function scoreDelimiter(rows: string[][]) {
  const sampledRows = rows.slice(0, 100).filter((row) => row.some((value) => value.trim()))
  if (!sampledRows.length) return Number.NEGATIVE_INFINITY
  const widths = sampledRows.map((row) => row.length)
  const frequency = new Map<number, number>()
  for (const width of widths) {
    frequency.set(width, (frequency.get(width) || 0) + 1)
  }
  const [modeWidth, modeCount] = [...frequency.entries()].sort((first, second) => (
    second[1] - first[1] || second[0] - first[0]
  ))[0]
  if (modeWidth <= 1) return -1000 + modeCount
  return (modeCount / sampledRows.length) * 1000 + Math.min(modeWidth, 100)
}

function parseCsvRows(content: string) {
  const withoutBom = content.replace(/^\uFEFF/, '')
  let bestRows: string[][] = []
  let bestScore = Number.NEGATIVE_INFINITY

  for (const delimiter of CSV_DELIMITERS) {
    const rows = parseDelimitedRows(withoutBom, delimiter)
    const score = scoreDelimiter(rows)
    if (score > bestScore) {
      bestRows = rows
      bestScore = score
    }
  }

  return bestRows
    .map((row) => row.map((value) => value.trim()))
    .filter((row) => row.some(Boolean))
}

function makeUniqueHeaders(rawHeaders: string[]) {
  const used = new Set<string>()
  return rawHeaders.map((rawHeader, index) => {
    const base = rawHeader.trim() || `Column ${index + 1}`
    let title = base
    let suffix = 2
    while (used.has(title.toLocaleLowerCase())) {
      title = `${base} ${suffix}`
      suffix += 1
    }
    used.add(title.toLocaleLowerCase())
    return title
  })
}

function isNumberColumn(values: string[]) {
  return values.every((value) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
}

function isCheckboxColumn(values: string[]) {
  const tokens = new Set(values.map((value) => value.toLocaleLowerCase()))
  return tokens.size <= 2 && [...tokens].every((value) => (
    value === 'true' || value === 'false' || value === 'yes' || value === 'no'
  ))
}

function isDateColumn(values: string[]) {
  return values.every((value) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value))
}

function isDateTimeColumn(values: string[]) {
  return values.every((value) => (
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)
  ))
}

function isUrlColumn(values: string[]) {
  return values.every((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  })
}

function inferField(values: string[]): Omit<CsvFieldInference, 'title'> {
  const populated = values.filter(Boolean)
  if (!populated.length) return { type: 'text' }
  if (isCheckboxColumn(populated)) return { type: 'checkbox' }
  if (isNumberColumn(populated)) return { type: 'number' }
  if (isDateTimeColumn(populated)) return { type: 'datetime' }
  if (isDateColumn(populated)) return { type: 'date' }
  if (isUrlColumn(populated)) return { type: 'url' }

  const uniqueValues = [...new Set(populated)]
  const maxLength = Math.max(...populated.map((value) => Array.from(value).length))
  const averageLength = populated.reduce((total, value) => total + Array.from(value).length, 0) / populated.length
  if (maxLength > 120 || averageLength > 80 || populated.some((value) => value.includes('\n'))) {
    return { type: 'long_text' }
  }
  if (
    populated.length >= MIN_SINGLE_SELECT_ROWS
    && uniqueValues.length <= MAX_SINGLE_SELECT_CHOICES
    && uniqueValues.length / populated.length <= 0.2
    && maxLength <= 80
  ) {
    return {
      type: 'single_select',
      options: { choices: uniqueValues },
    }
  }
  return { type: 'text' }
}

function serializeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function analyzeCsvImport(content: string): CsvImportAnalysis {
  const parsedRows = parseCsvRows(content)
  if (!parsedRows.length) {
    throw new Error('The CSV file is empty.')
  }

  let columnCount = 0
  for (const row of parsedRows) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (row[index]) {
        columnCount = Math.max(columnCount, index + 1)
        break
      }
    }
  }
  if (!columnCount) {
    throw new Error('The CSV file does not contain any fields.')
  }

  const headers = makeUniqueHeaders(parsedRows[0].slice(0, columnCount))
  const rows = parsedRows.slice(1).map((row) => (
    Array.from({ length: columnCount }, (_, index) => row[index] || '')
  ))
  const fields = headers.map((title, index) => ({
    title,
    ...inferField(rows.map((row) => row[index])),
  }))
  const normalizedRows = [headers, ...rows]
  const normalizedContent = `${normalizedRows
    .map((row) => row.map(serializeCsvCell).join(','))
    .join('\n')}\n`

  return {
    fields,
    headers,
    normalizedContent,
    recordCount: rows.length,
    rows,
  }
}

export function applyCsvFieldTypeOverrides(
  analysis: CsvImportAnalysis,
  overrides: CsvFieldTypeOverride[],
): CsvImportAnalysis {
  const overrideByIndex = new Map(overrides.map((override) => [override.index, override.type]))
  const fields = analysis.fields.map((field, index) => {
    const type = overrideByIndex.get(index)
    if (!type || type === field.type) return field
    if (type === 'single_select' || type === 'multi_select') {
      const choices = [...new Set(analysis.rows.map((row) => row[index]).filter(Boolean))].slice(0, MAX_SINGLE_SELECT_CHOICES)
      return { ...field, type, options: { choices } }
    }
    return { title: field.title, type }
  })
  return { ...analysis, fields }
}
