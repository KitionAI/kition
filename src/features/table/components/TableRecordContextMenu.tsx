import { useTranslation } from 'react-i18next'
import type { DataField, DataRecord } from '@/types/dataDocument'
import type { RowDropPosition } from '@/features/table/lib/tableEditorShared'

import { DataRecordContextMenu } from './TableEditorOverlays'

export function TableRecordContextMenu({
  menu,
  record,
  busy,
  canInsert,
  fields,
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
