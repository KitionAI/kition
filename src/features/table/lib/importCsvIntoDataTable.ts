import {
  createDataField,
  deleteDataField,
  deleteDataRecord,
  importDataTableCSV,
  listDataRecords,
  updateDataField,
} from '@/api/dataDocuments'
import { analyzeCsvImport, type CsvImportAnalysis } from '@/features/table/lib/csvImport'
import { DEFAULT_NEW_TABLE_FIELDS, DEFAULT_EMPTY_ROW_COUNT } from '@/features/table/lib/tableCreation'
import type { DataField, DataRecord, DataTable } from '@/types/dataDocument'

const FAILED_CSV_IMPORT_MAX_RECORDS = 200

function normalizeTitle(value: string) {
  return value.trim().toLocaleLowerCase()
}

function normalizeCellToken(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s"',;]+/g, '')
}

function hasRecordValue(record: DataRecord) {
  return Object.values(record.values || {}).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === 'object') return true
    return value !== null && value !== undefined && String(value).trim().length > 0
  })
}

function hasDefaultFields(fields: DataField[]) {
  if (fields.length !== DEFAULT_NEW_TABLE_FIELDS.length) return false
  return DEFAULT_NEW_TABLE_FIELDS.every((seed, index) => (
    fields[index]?.title === seed.title && fields[index]?.type === seed.type
  ))
}

function looksLikeFailedCsvImport(records: DataRecord[], headers: string[]) {
  const headerTokens = new Set(headers.map(normalizeCellToken).filter(Boolean))
  return records.slice(0, 3).some((record) => {
    const recordTokens = Object.values(record.values || {}).flatMap((value) => (
      typeof value === 'string' ? [normalizeCellToken(value)] : []
    ))
    const matchedHeaders = new Set(recordTokens.filter((value) => headerTokens.has(value)))
    return matchedHeaders.size >= 2
  })
}

async function replaceDefaultTableSchema(
  documentId: number,
  tableId: number,
  fields: DataField[],
  records: DataRecord[],
  inferredFields: ReturnType<typeof analyzeCsvImport>['fields'],
) {
  const sharedFieldCount = Math.min(fields.length, inferredFields.length)
  for (let index = 0; index < sharedFieldCount; index += 1) {
    const inferred = inferredFields[index]
    await updateDataField(documentId, tableId, fields[index].id, {
      title: inferred.title,
      type: inferred.type,
      options: inferred.options || {},
      order: index + 1,
    })
  }
  for (let index = fields.length; index < inferredFields.length; index += 1) {
    const inferred = inferredFields[index]
    await createDataField(documentId, tableId, {
      title: inferred.title,
      type: inferred.type,
      options: inferred.options,
      order: index + 1,
    })
  }
  for (let index = inferredFields.length; index < fields.length; index += 1) {
    await deleteDataField(documentId, tableId, fields[index].id)
  }
  await Promise.all(records.map((record) => deleteDataRecord(documentId, tableId, record.id)))
}

async function addMissingFields(
  documentId: number,
  tableId: number,
  fields: DataField[],
  inferredFields: ReturnType<typeof analyzeCsvImport>['fields'],
) {
  const existingTitles = new Set(fields.map((field) => normalizeTitle(field.title)))
  let added = 0
  for (const inferred of inferredFields) {
    const normalizedTitle = normalizeTitle(inferred.title)
    if (existingTitles.has(normalizedTitle)) continue
    await createDataField(documentId, tableId, {
      title: inferred.title,
      type: inferred.type,
      options: inferred.options,
      order: fields.length + added + 1,
    })
    existingTitles.add(normalizedTitle)
    added += 1
  }
  return added
}

export async function importCsvIntoDataTable({
  content,
  documentId,
  analysis: providedAnalysis,
  table,
}: {
  content: string
  documentId: number
  analysis?: CsvImportAnalysis
  table: DataTable
}) {
  const analysis = providedAnalysis || analyzeCsvImport(content)
  const fields = [...(table.fields || [])].sort((first, second) => first.order - second.order || first.id - second.id)
  const recordWindow = await listDataRecords(documentId, table.id, { limit: FAILED_CSV_IMPORT_MAX_RECORDS, offset: 0 })
  const records = recordWindow.items || []
  const defaultSchema = hasDefaultFields(fields)
  const pristineDefaultTable = defaultSchema
    && recordWindow.total <= DEFAULT_EMPTY_ROW_COUNT
    && records.every((record) => !hasRecordValue(record))
  const failedPreviousImport = defaultSchema
    && analysis.fields.length > fields.length
    && recordWindow.total > 0
    && recordWindow.total <= FAILED_CSV_IMPORT_MAX_RECORDS
    && looksLikeFailedCsvImport(records, analysis.headers)

  let addedFields = 0
  let replacedDefaultFields = false
  if (pristineDefaultTable || failedPreviousImport) {
    await replaceDefaultTableSchema(documentId, table.id, fields, records, analysis.fields)
    addedFields = Math.max(0, analysis.fields.length - fields.length)
    replacedDefaultFields = true
  } else {
    addedFields = await addMissingFields(documentId, table.id, fields, analysis.fields)
  }

  const result = await importDataTableCSV(documentId, table.id, analysis.normalizedContent)
  return {
    ...result,
    addedFields,
    fieldCount: analysis.fields.length,
    inferredFields: analysis.fields,
    recordCount: analysis.recordCount,
    recoveredFailedImport: failedPreviousImport,
    replacedDefaultFields,
  }
}
