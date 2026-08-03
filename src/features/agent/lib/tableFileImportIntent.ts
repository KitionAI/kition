import type { CsvFieldInference } from '@/features/table/lib/csvImport'

const HAN_IMPORT = String.fromCodePoint(0x5bfc, 0x5165)
const HAN_WRITE_IN = String.fromCodePoint(0x5199, 0x5165)
const HAN_CONVERT_TO_TABLE = String.fromCodePoint(0x8f6c, 0x6210, 0x8868, 0x683c)
const HAN_DO_NOT = String.fromCodePoint(0x4e0d, 0x8981)
const HAN_NO_NEED = String.fromCodePoint(0x4e0d, 0x7528)

export function isTableFileImportRequest(content: string) {
  const normalized = content.trim().toLocaleLowerCase()
  if (!normalized) return false
  if (/\b(?:do not|don't|dont)\s+(?:directly\s+)?(?:import|ingest|load)\b/.test(normalized)) {
    return false
  }
  if (
    normalized.includes(`${HAN_DO_NOT}${HAN_IMPORT}`)
    || normalized.includes(`${HAN_NO_NEED}${HAN_IMPORT}`)
  ) {
    return false
  }
  return /\b(?:import|ingest|load|populate)\b/.test(normalized)
    || normalized.includes(HAN_IMPORT)
    || normalized.includes(HAN_WRITE_IN)
    || normalized.includes(HAN_CONVERT_TO_TABLE)
}

export function buildCompletedTableFileImportPromptContext({
  fieldCount,
  fields,
  path,
  recordCount,
}: {
  fieldCount: number
  fields: CsvFieldInference[]
  path: string
  recordCount: number
}) {
  const typeSummary = fields.map((field) => `${field.title}: ${field.type}`).join(', ')
  return [
    'Deterministic spreadsheet import completed before this agent response:',
    `- Source: ${path}`,
    `- Imported records: ${recordCount}`,
    `- Imported fields: ${fieldCount}`,
    `- Inferred field types: ${typeSummary}`,
    'Do not read the source again or call table mutation tools for this request. Confirm the completed import and summarize the result only.',
  ].join('\n')
}
