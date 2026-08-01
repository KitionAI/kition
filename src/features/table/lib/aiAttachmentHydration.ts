import {
  updateDataRecord,
  uploadDataAttachment,
} from '@/api/dataDocuments'
import { resolvePublicFileURL } from '@/services/desktop'
import type { AnyAIConfig } from '@/types/aiConfig'
import type {
  DataAttachment,
  DataField,
  DataRecord,
} from '@/types/dataDocument'

type AttachmentHydrationDependencies = {
  fetchAsset: typeof fetch
  updateRecord: typeof updateDataRecord
  uploadAttachment: typeof uploadDataAttachment
}

const defaultDependencies: AttachmentHydrationDependencies = {
  fetchAsset: fetch,
  updateRecord: updateDataRecord,
  uploadAttachment: uploadDataAttachment,
}

export async function hydrateBundledAIFieldAttachments({
  documentId,
  tableId,
  record,
  config,
  fields,
  signal,
  dependencies = defaultDependencies,
}: {
  documentId: number
  tableId: number
  record: DataRecord
  config: AnyAIConfig
  fields: DataField[]
  signal?: AbortSignal
  dependencies?: AttachmentHydrationDependencies
}) {
  const sourceFieldId = 'source_field_id' in config ? config.source_field_id : undefined
  if (!sourceFieldId) return record

  const sourceField = fields.find((field) => field.id === sourceFieldId)
  if (!sourceField || sourceField.type !== 'attachment') return record

  const attachments = normalizeAttachments(record.values?.[sourceField.name])
  if (!attachments.some((attachment) => isBundledAttachmentURL(attachment.url))) {
    return record
  }

  const hydrated = await Promise.all(attachments.map(async (attachment) => {
    if (!isBundledAttachmentURL(attachment.url)) return attachment
    const assetURL = resolvePublicFileURL(attachment.url)
    const response = await dependencies.fetchAsset(assetURL, { signal })
    if (!response.ok) {
      throw new Error(`Bundled attachment could not be loaded: ${attachment.name || assetURL}`)
    }
    const bytes = await response.arrayBuffer()
    const mimeType = attachment.mimeType
      || response.headers.get('content-type')
      || 'application/octet-stream'
    const filename = attachment.name || filenameFromURL(assetURL)
    const file = new File([bytes], filename, { type: mimeType })
    return dependencies.uploadAttachment(documentId, tableId, file)
  }))

  return dependencies.updateRecord(documentId, tableId, record.id, {
    [sourceField.name]: hydrated,
  })
}

function normalizeAttachments(value: unknown): DataAttachment[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.filter((item): item is DataAttachment => Boolean(
    item
    && typeof item === 'object'
    && typeof (item as DataAttachment).url === 'string',
  ))
}

function isBundledAttachmentURL(url: string) {
  return /^kition-bundled:/i.test(url.trim())
}

function filenameFromURL(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]
  return pathname.split('/').pop() || 'attachment'
}
