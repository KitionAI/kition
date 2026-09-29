/**
 * Hand-off from a design to the rest of the workspace: the exported image
 * becomes a Markdown link in a document or an attachment on the table record
 * the design came from. API access is injected so the flows stay testable.
 */
import type { DataAttachment, DataRecordValue } from '@/types/dataDocument'
import type { DesignRecordRef } from '@/types/designStart'

export type DesignHandoffApi = {
  uploadAttachment: (documentId: number, tableId: number, file: File) => Promise<DataAttachment>
  readRecordValue: (ref: DesignRecordRef) => Promise<DataRecordValue | undefined>
  updateRecord: (ref: DesignRecordRef, values: Record<string, DataRecordValue>) => Promise<unknown>
}

/** The Markdown that embeds an exported design in a document. */
export function designMarkdownLink(title: string, relativePath: string) {
  const alt = title.replace(/[[\]\\]/g, '\\$&')
  return `![${alt}](<${relativePath}>)`
}

/** Uploads the image and appends it to the record's attachment field. */
export async function sendDesignToTable(
  api: DesignHandoffApi,
  ref: DesignRecordRef,
  file: File,
): Promise<DataAttachment> {
  const attachment = await api.uploadAttachment(ref.documentId, ref.tableId, file)
  const current = await api.readRecordValue(ref)
  const existing = Array.isArray(current)
    ? (current as unknown[]).filter((entry): entry is DataAttachment => Boolean(entry && typeof entry === 'object' && 'url' in entry))
    : current && typeof current === 'object' && 'url' in current
      ? [current as DataAttachment]
      : []
  await api.updateRecord(ref, { [ref.field]: [...existing, attachment] as unknown as DataRecordValue })
  return attachment
}
