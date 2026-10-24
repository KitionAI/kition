/**
 * Hand-off from a design to the rest of the workspace: the exported image
 * becomes an attachment on the table record the design came from. API access is injected so the flows stay testable.
 */
import type { DesignRecordRef } from '@/types/designStart'

/** An attachment cell's entry, as the Table kit stores it. */
type Attachment = Record<string, unknown> & { url: string }

export type DesignHandoffApi = {
  uploadAttachment: (ref: DesignRecordRef, file: File) => Promise<Attachment>
  readRecordValue: (ref: DesignRecordRef) => Promise<unknown>
  updateRecord: (ref: DesignRecordRef, values: Record<string, unknown>) => Promise<unknown>
}

/** Uploads the image and appends it to the record's attachment field. */
export async function sendDesignToTable(
  api: DesignHandoffApi,
  ref: DesignRecordRef,
  file: File,
): Promise<Attachment> {
  const attachment = await api.uploadAttachment(ref, file)
  const current = await api.readRecordValue(ref)
  const existing = Array.isArray(current)
    ? (current as unknown[]).filter((entry): entry is Attachment => Boolean(entry && typeof entry === 'object' && 'url' in entry))
    : current && typeof current === 'object' && 'url' in current
      ? [current as Attachment]
      : []
  await api.updateRecord(ref, { [ref.field]: [...existing, attachment] })
  return attachment
}
