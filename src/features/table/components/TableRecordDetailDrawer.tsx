import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, ClipboardList, Link as LinkIcon, Trash2 } from 'lucide-react'
import type { DataAttachment, DataField, DataRecord, DataRecordValue, LinkRef, RecordHistoryEntry } from '@/types/dataDocument'
import { Button } from '@/components/ui'
import { listRecordHistory } from '@/api/dataDocuments'
import { displayValue } from '@/features/table/lib/tableEditorShared'
import { buildRecordDeepLink } from '@/features/table/lib/recordUrl'
import { getCurrentLocale } from '@/i18n'

import { DataInlineCell, LinkFieldEditor } from './TableEditorCells'

export function RecordDetailDrawer({
  record,
  fields,
  primaryField,
  documentId,
  tableId,
  navIndex,
  navTotal,
  canNavigatePrev,
  canNavigateNext,
  onPreviewAttachments,
  onOpenDocument,
  onClose,
  onDelete,
  onUpdate,
  onReplaceLinks,
  onNavigatePrev,
  onNavigateNext,
}: {
  record: DataRecord
  fields: DataField[]
  primaryField: DataField | null
  documentId: number
  tableId: number
  navIndex?: number
  navTotal?: number
  canNavigatePrev?: boolean
  canNavigateNext?: boolean
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  onOpenDocument?: (path: string) => void
  onClose: () => void
  onDelete: () => void
  onUpdate: (field: DataField, value: DataRecordValue) => void
  onReplaceLinks?: (field: DataField, rowKeys: string[]) => Promise<LinkRef[] | null>
  onNavigatePrev?: () => void
  onNavigateNext?: () => void
}) {
  const { t } = useTranslation('table')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopyLink = useCallback(async () => {
    const link = buildRecordDeepLink(documentId, tableId, record.row_key)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }, [documentId, tableId, record.row_key])

  return (
    <aside className="data-inline-record-drawer">
      <header>
        <div>
          <strong>{primaryField ? displayValue(record.values?.[primaryField.name] ?? null) || t('drawer.untitled') : t('drawer.untitled')}</strong>
          <span>{t('drawer.recordId', { id: record.id })}</span>
        </div>
        <div className="data-inline-record-drawer-actions">
          {typeof navIndex === 'number' && typeof navTotal === 'number' ? (
            <span className="data-inline-record-drawer-nav-count">{navIndex + 1} / {navTotal}</span>
          ) : null}
          <button
            type="button"
            className="data-inline-record-drawer-nav-btn"
            disabled={!canNavigatePrev || !onNavigatePrev}
            onClick={() => onNavigatePrev?.()}
            aria-label={t('drawer.previousRecord')}
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            className="data-inline-record-drawer-nav-btn"
            disabled={!canNavigateNext || !onNavigateNext}
            onClick={() => onNavigateNext?.()}
            aria-label={t('drawer.nextRecord')}
          >
            <ChevronDown className="size-4" />
          </button>
          <button
            type="button"
            className="data-inline-record-drawer-nav-btn"
            onClick={() => void handleCopyLink()}
            aria-label={t('drawer.copyRecordLink')}
            title={copied ? t('drawer.copied') : t('drawer.copyRecordLink')}
          >
            <LinkIcon className="size-4" />
          </button>
          <button onClick={onClose} aria-label={t('drawer.close')}>×</button>
        </div>
      </header>
      <div className="data-inline-record-fields">
        {fields.map((field) => (
          <label key={field.id}>
            <span>{field.title}</span>
            {field.type === 'link_to_record' && onReplaceLinks ? (
              <LinkFieldEditor
                field={field}
                value={record.values?.[field.name] ?? null}
                documentId={documentId}
                tableId={tableId}
                onReplace={(rowKeys) => onReplaceLinks(field, rowKeys)}
              />
            ) : (
              <DataInlineCell
                field={field}
                value={record.values?.[field.name] ?? null}
                documentId={documentId}
                tableId={tableId}
                onPreviewAttachments={onPreviewAttachments}
                onOpenDocument={onOpenDocument}
                onCommit={(value) => onUpdate(field, value)}
              />
            )}
          </label>
        ))}
      </div>

      <button
        type="button"
        className="data-inline-record-history-toggle"
        onClick={() => setHistoryOpen((prev) => !prev)}
      >
        <ClipboardList className="size-4" />
        <span>{t('drawer.history')}</span>
        {historyOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      {historyOpen ? (
        <RecordHistoryPanel
          documentId={documentId}
          tableId={tableId}
          recordId={record.id}
          fields={fields}
        />
      ) : null}

      <Button variant="destructive" onClick={onDelete}>
        <Trash2 className="size-4" />{t('drawer.deleteRecord')}
      </Button>
    </aside>
  )
}

function RecordHistoryPanel({
  documentId,
  tableId,
  recordId,
  fields,
}: {
  documentId: number
  tableId: number
  recordId: number
  fields: DataField[]
}) {
  const { t } = useTranslation('table')
  const [entries, setEntries] = useState<RecordHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listRecordHistory(documentId, tableId, recordId, { limit: 50 })
      .then((response) => {
        if (cancelled) return
        setEntries(response.items || [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('drawer.loadHistoryFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, tableId, recordId])

  const fieldById = new Map(fields.map((field) => [field.id, field] as const))

  if (loading) {
    return <div className="data-inline-record-history-empty">{t('drawer.loadingHistory')}</div>
  }
  if (error) {
    return <div className="data-inline-record-history-empty">{error}</div>
  }
  if (entries.length === 0) {
    return <div className="data-inline-record-history-empty">{t('drawer.noHistory')}</div>
  }
  return (
    <ol className="data-inline-record-history-list">
      {entries.map((entry) => {
        const field = entry.field_id ? fieldById.get(entry.field_id) : null
        const fieldLabel = field?.title || (entry.field_id ? t('drawer.fieldId', { id: entry.field_id }) : null)
        return (
          <li key={entry.id} className="data-inline-record-history-item">
            <div className="data-inline-record-history-meta">
              <span className={`data-inline-record-history-action data-inline-record-history-action--${entry.action}`}>
                {t(`drawer.historyAction.${entry.action}`, { defaultValue: entry.action })}
              </span>
              {fieldLabel ? <span className="data-inline-record-history-field">{fieldLabel}</span> : null}
              <span className="data-inline-record-history-time">{formatHistoryTime(entry.created_at)}</span>
            </div>
            {entry.action === 'update' && entry.field_id ? (
              <div className="data-inline-record-history-diff">
                <span className="data-inline-record-history-before">{displayValue(entry.before as DataRecordValue) || '∅'}</span>
                <span className="data-inline-record-history-arrow">→</span>
                <span className="data-inline-record-history-after">{displayValue(entry.after as DataRecordValue) || '∅'}</span>
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function formatHistoryTime(raw: string): string {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString(getCurrentLocale())
}
