import { useTranslation } from 'react-i18next'
import type { DataField, DataRecord } from '@/types/dataDocument'
import {
  findImageLikeString,
  normalizeAttachmentValue,
  type RowDropPosition,
} from '@/features/table/lib/tableEditorShared'
import { copyImageToClipboard, resolvePublicFileURL } from '@/services/desktop'
import { notify } from '@/lib/notify'

import { DataRecordContextMenu } from './TableEditorOverlays'

export function TableRecordContextMenu({
  menu,
  record,
  busy,
  canInsert,
  fields,
  selectedFieldName,
  onClose,
  onInsertRecords,
  onDuplicateRecord,
  onCopyRecordURL,
  onOpenRecord,
  onCopyRecordForChat,
  onDeleteRecord,
  onRegenerateAIField,
  onStatus,
}: {
  menu: { x: number; y: number } | null
  record: DataRecord | null
  busy: boolean
  canInsert: boolean
  fields: DataField[]
  selectedFieldName?: string | null
  onClose: () => void
  onInsertRecords: (
    record: DataRecord,
    count: number,
    position: RowDropPosition,
  ) => void | Promise<void>
  onDuplicateRecord: (record: DataRecord) => void | Promise<void>
  onCopyRecordURL: (record: DataRecord) => void | Promise<void>
  onOpenRecord: (record: DataRecord) => void
  onCopyRecordForChat: (record: DataRecord) => void | Promise<void>
  onDeleteRecord: (recordId: number) => void | Promise<void>
  onRegenerateAIField: (record: DataRecord, field: DataField) => void
  onStatus: (message: string) => void
}) {
  const { t } = useTranslation('table')
  if (!menu || !record) return null

  function closeAndRun(action: () => void | Promise<void>) {
    onClose()
    void action()
  }

  const aiFields = fields.filter((field) => field.ai_config?.enabled)
  const selectedField = selectedFieldName
    ? fields.find((field) => field.name === selectedFieldName)
    : null
  const selectedImage = selectedField?.type === 'attachment'
    ? normalizeAttachmentValue(record.values?.[selectedField.name] ?? null)
      .map((attachment) => findImageLikeString(attachment))
      .find(Boolean) || ''
    : ''

  async function copySelectedImage() {
    if (!selectedImage) return
    try {
      await copyImageToClipboard(resolvePublicFileURL(selectedImage))
      onStatus(t('recordMenu.imageCopied'))
    } catch (error) {
      notify.error(t('recordMenu.imageCopyFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <DataRecordContextMenu
      record={record}
      position={menu}
      busy={busy}
      canInsert={canInsert}
      canRegenerateAI={aiFields.length > 0}
      onClose={onClose}
      onInsertAbove={(count) =>
        closeAndRun(() => onInsertRecords(record, count, 'before'))
      }
      onInsertBelow={(count) =>
        closeAndRun(() => onInsertRecords(record, count, 'after'))
      }
      onDuplicate={() => closeAndRun(() => onDuplicateRecord(record))}
      onCopyURL={() => closeAndRun(() => onCopyRecordURL(record))}
      onCopyImage={selectedImage ? () => closeAndRun(copySelectedImage) : undefined}
      onHistory={() => {
        onClose()
        onStatus(t('recordMenu.historyUnavailable'))
      }}
      onComment={() => {
        onClose()
        onOpenRecord(record)
        onStatus(t('recordMenu.commentsHint'))
      }}
      onAddToChat={() => closeAndRun(() => onCopyRecordForChat(record))}
      onRegenerateAI={() => {
        onClose()
        for (const field of aiFields) {
          onRegenerateAIField(record, field)
        }
      }}
      onDelete={() => closeAndRun(() => onDeleteRecord(record.id))}
    />
  )
}
