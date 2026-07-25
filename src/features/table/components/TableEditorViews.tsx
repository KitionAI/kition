import { useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { GalleryHorizontalEnd, GripVertical, Plus } from 'lucide-react'
import type { DataAttachment, DataField, DataRecord, DataRecordValue } from '@/types/dataDocument'
import { Badge, Button } from '@/components/ui'
import { coerceValue, displayValue, findImageLikeString, normalizeAttachmentValue } from '@/features/table/lib/tableEditorShared'
import { resolvePublicFileURL } from '@/services/desktop'
import { cn } from '@/lib/utils'

import { DataCellDisplay, DataInlineCell } from './TableEditorCells'

export function KanbanView({
  fields,
  groupField,
  groups,
  primaryField,
  canMoveCards,
  draggingRecordId,
  dragOverRecordId,
  dragOverGroup,
  onDragStart,
  onDragEnd,
  onDragOverRecord,
  onDragOverGroup,
  onMoveRecord,
  onAddRecord,
  onOpenRecord,
  onOpenDocument,
  onPreviewAttachments,
  tableId,
  onRegenerate,
}: {
  fields: DataField[]
  groupField: DataField | null
  groups: Array<[string, DataRecord[]]>
  primaryField: DataField | null
  canMoveCards: boolean
  draggingRecordId: number | null
  dragOverRecordId: number | null
  dragOverGroup: string
  onDragStart: (recordId: number) => void
  onDragEnd: () => void
  onDragOverRecord: (recordId: number | null) => void
  onDragOverGroup: (group: string) => void
  onMoveRecord: (recordId: number, group: string, targetRecordId?: number) => void
  onAddRecord: (group: string) => void
  onOpenRecord: (record: DataRecord) => void
  onOpenDocument?: (path: string) => void
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  tableId: number
  onRegenerate?: (record: DataRecord, field: DataField) => void
}) {
  const { t } = useTranslation('table')
  const suppressCardClickRef = useRef(false)
  const previewFields = fields.filter((field) => field.name !== primaryField?.name && field.name !== groupField?.name).slice(0, 3)

  function startCardDrag(event: DragEvent<HTMLElement>, recordId: number) {
    if (!canMoveCards) return
    suppressCardClickRef.current = true
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(recordId))
    const card = event.currentTarget.closest('.data-inline-kanban-card')
    if (card instanceof HTMLElement) {
      event.dataTransfer.setDragImage(card, 18, 18)
    }
    onDragStart(recordId)
  }

  return (
    <div className="data-inline-kanban">
      {groups.map(([group, records]) => (
        <section
          key={group}
          className={cn('data-inline-kanban-column', dragOverGroup === group && 'is-drop-target')}
          onDragOver={(event) => {
            if (!canMoveCards || draggingRecordId === null) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            onDragOverGroup(group)
            onDragOverRecord(null)
          }}
          onDragLeave={() => {
            if (dragOverGroup === group) onDragOverGroup('')
          }}
          onDrop={(event) => {
            event.preventDefault()
            const sourceId = Number(event.dataTransfer.getData('text/plain') || draggingRecordId)
            onDragEnd()
            if (Number.isFinite(sourceId)) onMoveRecord(sourceId, group)
          }}
        >
          <header>
            <span>{group}</span>
            <Badge>{records.length}</Badge>
          </header>
          <div className="data-inline-kanban-cards">
            {records.map((record) => (
              <article
                key={record.id}
                className={cn('data-inline-kanban-card', draggingRecordId === record.id && 'is-dragging', dragOverRecordId === record.id && 'is-drag-over', canMoveCards && 'is-draggable')}
                draggable={canMoveCards}
                onDragStart={(event) => startCardDrag(event, record.id)}
                onDragOver={(event) => {
                  if (!canMoveCards || draggingRecordId === null || draggingRecordId === record.id) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  onDragOverGroup(group)
                  onDragOverRecord(record.id)
                }}
                onDragLeave={() => {
                  if (dragOverRecordId === record.id) onDragOverRecord(null)
                }}
                onDrop={(event) => {
                  if (!canMoveCards || draggingRecordId === null || draggingRecordId === record.id) return
                  event.preventDefault()
                  event.stopPropagation()
                  const sourceId = Number(event.dataTransfer.getData('text/plain') || draggingRecordId)
                  onDragEnd()
                  if (Number.isFinite(sourceId)) onMoveRecord(sourceId, group, record.id)
                }}
                onDragEnd={onDragEnd}
                onClick={() => {
                  if (suppressCardClickRef.current) {
                    suppressCardClickRef.current = false
                    return
                  }
                  onOpenRecord(record)
                }}
              >
                <div className="data-inline-kanban-card-head">
                  <button
                    type="button"
                    className="data-inline-kanban-drag-handle"
                    title={canMoveCards ? t('views.dragCard') : t('views.dragCardDisabled')}
                    draggable={canMoveCards}
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => {
                      event.stopPropagation()
                      startCardDrag(event, record.id)
                    }}
                    onDragEnd={(event) => {
                      event.stopPropagation()
                      onDragEnd()
                    }}
                  >
                    <GripVertical className="size-4" />
                  </button>
                  <strong>{primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('views.untitled') : t('views.untitled')}</strong>
                </div>
                {previewFields.map((field) => (
                  <div key={field.id} className="data-inline-kanban-meta">
                    <span>{field.title}</span>
                    <DataCellDisplay
                      field={field}
                      value={record.values?.[field.name] ?? null}
                      onPreviewAttachments={onPreviewAttachments}
                      onOpenDocument={onOpenDocument}
                      tableId={tableId}
                      recordId={record.id}
                      onRegenerate={onRegenerate ? (f) => onRegenerate(record, f) : undefined}
                    />
                  </div>
                ))}
              </article>
            ))}
            <button type="button" className="data-inline-kanban-add" onClick={() => onAddRecord(group)}>
              <Plus className="size-4" />{t('views.new')}
            </button>
          </div>
        </section>
      ))}
    </div>
  )
}

export function CalendarView({
  records,
  fields,
  primaryField,
  dateField,
  onAddRecord,
  onOpenRecord,
  onOpenDocument,
  onPreviewAttachments,
  tableId,
  onRegenerate,
}: {
  records: DataRecord[]
  fields: DataField[]
  primaryField: DataField | null
  dateField: DataField | null
  onAddRecord: () => void
  onOpenRecord: (record: DataRecord) => void
  onOpenDocument?: (path: string) => void
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  tableId: number
  onRegenerate?: (record: DataRecord, field: DataField) => void
}) {
  const { t } = useTranslation('table')
  const previewFields = fields.filter((field) => field.id !== primaryField?.id && field.id !== dateField?.id).slice(0, 2)
  return (
    <div className="data-inline-calendar">
      <div className="data-inline-calendar-head">
        <div>
          <strong>{dateField ? t('views.calendarByField', { title: dateField.title }) : t('views.calendarNeedsDate')}</strong>
          <span>{t('views.scheduledRecords', { count: records.length })}</span>
        </div>
        <Button variant="outline" onClick={onAddRecord}><Plus className="size-4" />{t('views.new')}</Button>
      </div>
      <div className="data-inline-calendar-list">
        {records.map((record) => (
          <article key={record.id} className="data-inline-calendar-item" onClick={() => onOpenRecord(record)}>
            <div className="data-inline-calendar-date">{dateField ? displayValue(record.values?.[dateField.name] ?? null) || t('views.noDate') : t('views.noDate')}</div>
            <div className="data-inline-calendar-card">
              <strong>{primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('views.untitled') : t('views.untitled')}</strong>
              <div>
                {previewFields.map((field) => (
                  <DataCellDisplay
                    key={field.id}
                    field={field}
                    value={record.values?.[field.name] ?? null}
                    onPreviewAttachments={onPreviewAttachments}
                    onOpenDocument={onOpenDocument}
                    tableId={tableId}
                    recordId={record.id}
                    onRegenerate={onRegenerate ? (f) => onRegenerate(record, f) : undefined}
                  />
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

export function GalleryView({
  records,
  fields,
  primaryField,
  coverField,
  onOpenRecord,
  onOpenDocument,
  onPreviewAttachments,
  tableId,
  onRegenerate,
}: {
  records: DataRecord[]
  fields: DataField[]
  primaryField: DataField | null
  coverField: DataField | null
  onOpenRecord: (record: DataRecord) => void
  onOpenDocument?: (path: string) => void
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  tableId: number
  onRegenerate?: (record: DataRecord, field: DataField) => void
}) {
  const { t } = useTranslation('table')
  const previewFields = fields.filter((field) => field.id !== primaryField?.id && field.id !== coverField?.id).slice(0, 4)
  return (
    <div className="data-inline-gallery">
      {records.map((record) => {
        const coverValue = coverField ? record.values?.[coverField.name] ?? null : null
        const coverAttachments = coverField ? normalizeAttachmentValue(coverValue) : []
        const coverSrc = coverField
          ? coverAttachments.length
            ? findImageLikeString(coverAttachments[0])
            : findImageLikeString(coverValue)
          : ''
        return (
          <article key={record.id} className="data-inline-gallery-card" onClick={() => onOpenRecord(record)}>
            <div className={cn('data-inline-gallery-cover', coverSrc && 'has-image')}>
              {coverSrc ? (
                <button
                  type="button"
                  className="data-inline-gallery-cover-button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (coverAttachments.length) {
                      onPreviewAttachments(coverAttachments, 0)
                    } else {
                      onPreviewAttachments(
                        [
                          {
                            name: primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('views.galleryCover') : t('views.galleryCover'),
                            url: coverSrc,
                          },
                        ],
                        0,
                      )
                    }
                  }}
                >
                  <img src={resolvePublicFileURL(coverSrc)} alt={primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('views.galleryCover') : t('views.galleryCover')} loading="lazy" />
                </button>
              ) : <GalleryHorizontalEnd className="size-5" />}
            </div>
            <strong>{primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('views.untitled') : t('views.untitled')}</strong>
            {coverField ? (
              <div className="data-inline-gallery-meta">
                <span>{t('views.cover')}</span>
                <span className={cn(coverSrc ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground')}>{coverSrc ? coverField.title : t('views.empty')}</span>
              </div>
            ) : null}
            {previewFields.map((field) => (
              <div key={field.id} className="data-inline-gallery-meta">
                <span>{field.title}</span>
                <DataCellDisplay
                  field={field}
                  value={record.values?.[field.name] ?? null}
                  onPreviewAttachments={onPreviewAttachments}
                  onOpenDocument={onOpenDocument}
                  tableId={tableId}
                  recordId={record.id}
                  onRegenerate={onRegenerate ? (f) => onRegenerate(record, f) : undefined}
                />
              </div>
            ))}
          </article>
        )
      })}
    </div>
  )
}

export function FormView({
  fields,
  documentId,
  tableId,
  onPreviewAttachments,
  onOpenDocument,
  onSubmit,
}: {
  fields: DataField[]
  documentId?: number
  tableId?: number
  onPreviewAttachments?: (items: DataAttachment[], index: number) => void
  onOpenDocument?: (path: string) => void
  onSubmit: (values: Record<string, DataRecordValue>) => void
}) {
  const { t } = useTranslation('table')
  const [values, setValues] = useState<Record<string, DataRecordValue>>({})
  return (
    <div className="data-inline-form-view">
      <div className="data-inline-form-card">
        <header>
          <strong>{t('views.newRecordForm')}</strong>
          <span>{t('views.newRecordFormHint')}</span>
        </header>
        {fields.filter((field) => !field.readonly).map((field) => (
          <label key={field.id} className="data-inline-form-field">
            <span>{field.title}</span>
            <DataInlineCell
              field={field}
              value={values[field.name] ?? null}
              documentId={documentId}
              tableId={tableId}
              onPreviewAttachments={onPreviewAttachments}
              onOpenDocument={onOpenDocument}
              onCommit={(value) => setValues((current) => ({ ...current, [field.name]: coerceValue(field, value) }))}
            />
          </label>
        ))}
        <Button onClick={() => onSubmit(values)}><Plus className="size-4" />{t('views.createRecord')}</Button>
      </div>
    </div>
  )
}
