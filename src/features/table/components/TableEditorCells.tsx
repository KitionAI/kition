import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, FileText, Heart, LoaderCircle, Plus, RefreshCcw, Star, ThumbsUp, Upload, User as UserIcon, X } from 'lucide-react'
import { listLinkCandidates, uploadDataAttachment } from '@/api/dataDocuments'
import { resolvePublicFileURL } from '@/services/desktop'
import type { DataAttachment, DataField, DataRecordValue, LinkRef } from '@/types/dataDocument'
import { Select } from '@/components/ui'
import {
  attachmentNameFromURL,
  displayValue,
  extractClipboardFiles,
  findImageLikeString,
  getSelectChoiceTone,
  normalizeAttachmentValue,
  normalizeChoiceList,
  parseUrlValue,
} from '@/features/table/lib/tableEditorShared'
import {
  formatTableFieldValue,
  fromDateInputValue,
  toDateInputValue,
} from '@/features/table/lib/dateFormatting'
import { cn } from '@/lib/utils'
import { useAICellStatus, buildCellKey } from '@/features/table/store/aiCellGenerationStore'
import { isAttachmentAIConfig } from '@/types/aiConfig'

import { AttachmentCell } from './AttachmentCell'

type LinkRefLike = { row_key?: string; display?: string }
type UserRefLike = { id?: string; name?: string; avatar?: string }

function normalizeLinkRefs(value: DataRecordValue): LinkRefLike[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (item && typeof item === 'object' ? (item as LinkRefLike) : null))
    .filter((item): item is LinkRefLike => Boolean(item))
}

function normalizeUserRefs(value: DataRecordValue): UserRefLike[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (item && typeof item === 'object' ? (item as UserRefLike) : null))
    .filter((item): item is UserRefLike => Boolean(item))
}

export function LinkFieldEditor({
  field,
  value,
  documentId,
  tableId,
  onReplace,
}: {
  field: DataField
  value: DataRecordValue
  documentId: number
  tableId: number
  onReplace: (rowKeys: string[]) => Promise<LinkRef[] | null>
}) {
  const { t } = useTranslation('table')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<LinkRef[]>([])
  const [loading, setLoading] = useState(false)
  const allowMultiple = (field.options as Record<string, unknown> | undefined)?.allow_multiple !== false
  const refs = normalizeLinkRefs(value)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    listLinkCandidates(documentId, tableId, field.id, query, 25)
      .then((items) => {
        if (!cancelled) setCandidates(items)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, query, documentId, tableId, field.id])

  async function commit(nextRowKeys: string[]) {
    await onReplace(nextRowKeys)
  }

  function toggleCandidate(rowKey: string) {
    if (refs.some((ref) => ref.row_key === rowKey)) {
      void commit(refs.map((ref) => ref.row_key || '').filter((k) => k && k !== rowKey))
      return
    }
    const nextKeys = allowMultiple
      ? [...refs.map((ref) => ref.row_key || '').filter(Boolean), rowKey]
      : [rowKey]
    void commit(nextKeys)
    if (!allowMultiple) setOpen(false)
  }

  function removeRef(rowKey: string) {
    void commit(refs.map((ref) => ref.row_key || '').filter((k) => k && k !== rowKey))
  }

  return (
    <div className="data-inline-link-editor">
      <div className="data-inline-link-chip-row">
        {refs.length ? refs.map((ref) => (
          <span key={ref.row_key} className="data-inline-link-chip">
            {ref.display || ref.row_key || t('cell.untitled')}
            {!field.readonly ? (
              <button
                type="button"
                className="data-inline-link-chip-remove"
                onClick={() => removeRef(ref.row_key || '')}
                aria-label={t('cell.removeLink')}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        )) : <span className="text-muted-foreground text-xs">{t('cell.noLinks')}</span>}
        {!field.readonly ? (
          <button type="button" className="data-inline-link-add" onClick={() => setOpen((value) => !value)}>
            <Plus className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open && !field.readonly ? (
        <div className="data-inline-link-picker">
          <input
            className="data-inline-cell-input"
            placeholder={t('cell.searchPlaceholder')}
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="data-inline-link-picker-list">
            {loading ? <div className="data-inline-link-picker-empty"><LoaderCircle className="size-3.5 animate-spin" /></div> : null}
            {!loading && !candidates.length ? <div className="data-inline-link-picker-empty">{t('cell.noMatches')}</div> : null}
            {candidates.map((candidate) => {
              const selected = refs.some((ref) => ref.row_key === candidate.row_key)
              return (
                <button
                  key={candidate.row_key}
                  type="button"
                  className={cn('data-inline-link-picker-row', selected && 'is-selected')}
                  onClick={() => toggleCandidate(candidate.row_key)}
                >
                  <span>{candidate.display || candidate.row_key || t('cell.untitled')}</span>
                  {selected ? <Check className="size-3.5" /> : null}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LinkChips({ value, placeholder }: { value: DataRecordValue; placeholder: string }) {
  const { t } = useTranslation('table')
  const refs = normalizeLinkRefs(value)
  if (!refs.length) return <span className="text-muted-foreground text-xs">{placeholder}</span>
  return (
    <span className="data-inline-link-chips">
      {refs.map((ref, index) => (
        <span key={`${ref.row_key}-${index}`} className="data-inline-link-chip" title={ref.display || ref.row_key}>
          {ref.display || ref.row_key || t('cell.untitled')}
        </span>
      ))}
    </span>
  )
}

function UserChips({ value, placeholder }: { value: DataRecordValue; placeholder: string }) {
  const { t } = useTranslation('table')
  const refs = normalizeUserRefs(value)
  if (!refs.length) return <span className="text-muted-foreground text-xs">{placeholder}</span>
  return (
    <span className="data-inline-user-chips">
      {refs.map((ref, index) => (
        <span key={`${ref.id}-${index}`} className="data-inline-user-chip" title={ref.name || ref.id}>
          <UserIcon className="size-3.5" />
          {ref.name || ref.id || t('cell.user')}
        </span>
      ))}
    </span>
  )
}

function ratingMax(field: DataField): number {
  const max = Number((field.options as Record<string, unknown> | undefined)?.max ?? 5)
  return Number.isFinite(max) && max > 0 ? Math.min(max, 10) : 5
}

function ratingIconKind(field: DataField): 'star' | 'heart' | 'thumbs' {
  const icon = (field.options as Record<string, unknown> | undefined)?.icon
  return icon === 'heart' || icon === 'thumbs' ? icon : 'star'
}

function RatingIcon({ kind, filled }: { kind: 'star' | 'heart' | 'thumbs'; filled: boolean }) {
  const className = cn('size-3.5', filled ? 'text-amber-500' : 'text-muted-foreground/40')
  if (kind === 'heart') return <Heart className={className} fill={filled ? 'currentColor' : 'none'} />
  if (kind === 'thumbs') return <ThumbsUp className={className} fill={filled ? 'currentColor' : 'none'} />
  return <Star className={className} fill={filled ? 'currentColor' : 'none'} />
}

function RatingControl({
  field,
  value,
  readonly,
  onCommit,
}: {
  field: DataField
  value: DataRecordValue
  readonly: boolean
  onCommit?: (value: DataRecordValue) => void
}) {
  const { t } = useTranslation('table')
  const max = ratingMax(field)
  const kind = ratingIconKind(field)
  const current = Math.max(0, Math.min(max, Number(value ?? 0)))
  return (
    <span className="data-inline-rating-cell">
      {Array.from({ length: max }, (_, i) => i + 1).map((step) => (
        <button
          key={step}
          type="button"
          className="data-inline-rating-step"
          disabled={readonly}
          aria-label={t('cell.rate', { step })}
          onClick={(event) => {
            if (readonly || !onCommit) return
            event.preventDefault()
            event.stopPropagation()
            onCommit(current === step ? 0 : step)
          }}
        >
          <RatingIcon kind={kind} filled={step <= current} />
        </button>
      ))}
    </span>
  )
}

type ButtonAction = { kind: 'open_url'; url?: string } | { kind: 'run_workflow'; workflow_id?: number }

function buttonConfig(field: DataField, fallbackLabel: string): { label: string; action: ButtonAction } {
  const options = (field.options ?? {}) as Record<string, unknown>
  const label = typeof options.label === 'string' && options.label ? options.label : field.title || fallbackLabel
  const action = (options.action ?? {}) as Record<string, unknown>
  const kind = action.kind === 'run_workflow' ? 'run_workflow' : 'open_url'
  if (kind === 'open_url') {
    return { label, action: { kind: 'open_url', url: typeof action.url === 'string' ? action.url : undefined } }
  }
  return { label, action: { kind: 'run_workflow', workflow_id: typeof action.workflow_id === 'number' ? action.workflow_id : undefined } }
}

function editableDraftValue(field: DataField, value: DataRecordValue): string {
  if (field.type === 'date') return toDateInputValue('date', value)
  if (field.type === 'datetime') return toDateInputValue('datetime-local', value)
  return displayValue(value)
}

export function DataInlineCell({
  field,
  value,
  documentId,
  tableId,
  onPreviewAttachments,
  onOpenDocument,
  onCommit,
}: {
  field: DataField
  value: DataRecordValue
  documentId?: number
  tableId?: number
  onPreviewAttachments?: (items: DataAttachment[], index: number) => void
  onOpenDocument?: (path: string) => void
  onCommit: (value: DataRecordValue) => void
}) {
  const { t } = useTranslation('table')
  const [draft, setDraft] = useState(() => editableDraftValue(field, value))
  const [uploading, setUploading] = useState(false)
  const [localError, setLocalError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setDraft(editableDraftValue(field, value))
  }, [field.type, value])

  async function appendFiles(files: File[]) {
    if (!documentId || !tableId || field.readonly || !files.length) return
    setUploading(true)
    setLocalError('')
    try {
      const uploaded = await Promise.all(files.map((file) => uploadDataAttachment(documentId, tableId, file)))
      onCommit([...normalizeAttachmentValue(value), ...uploaded])
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : t('cell.uploadFailed'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (field.type === 'checkbox') {
    return <input type="checkbox" checked={Boolean(value)} disabled={field.readonly} onChange={(event) => onCommit(event.target.checked)} />
  }

  if (field.type === 'attachment') {
    const attachments = normalizeAttachmentValue(value)
    return (
      <div
        className={cn('data-inline-attachment-cell', uploading && 'is-uploading')}
        onPaste={(event) => {
          const files = extractClipboardFiles(event.clipboardData)
          if (!files.length) return
          event.preventDefault()
          event.stopPropagation()
          void appendFiles(files)
        }}
        onDragOver={(event) => {
          if (field.readonly) return
          event.preventDefault()
        }}
        onDrop={(event) => {
          if (field.readonly) return
          const files = Array.from(event.dataTransfer.files || [])
          if (!files.length) return
          event.preventDefault()
          event.stopPropagation()
          void appendFiles(files)
        }}
      >
        <div className="data-inline-attachment-list">
          {attachments.map((attachment, index) => {
            const imageSrc = findImageLikeString(attachment)
            const previewable = imageSrc && onPreviewAttachments
            return (
              <span
                key={`${attachment.url}-${index}`}
                className={cn('data-inline-attachment-chip', previewable && 'is-previewable')}
                title={previewable ? t('cell.attachmentPreviewHint', { name: attachment.name || t('cell.previewImage') }) : attachment.name}
                role={previewable ? 'button' : undefined}
                tabIndex={previewable ? 0 : undefined}
                onClick={(event) => {
                  if (!previewable) return
                  event.preventDefault()
                  event.stopPropagation()
                  onPreviewAttachments?.(attachments, index)
                }}
                onKeyDown={(event) => {
                  if (!previewable || (event.key !== 'Enter' && event.key !== ' ')) return
                  event.preventDefault()
                  event.stopPropagation()
                  onPreviewAttachments?.(attachments, index)
                }}
              >
                {imageSrc ? (
                  <span className="data-inline-attachment-thumb-button">
                    <img src={resolvePublicFileURL(imageSrc)} alt={attachment.name || t('attachment.imageAlt')} />
                  </span>
                ) : <FileText className="size-3.5" />}
                <span>{attachment.name || attachmentNameFromURL(attachment.url)}</span>
                {!field.readonly ? (
                  <button
                    type="button"
                    className="data-inline-attachment-remove"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onCommit(attachments.filter((_, itemIndex) => itemIndex !== index))
                    }}
                    title={t('cell.removeAttachment')}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            )
          })}
          {!attachments.length ? <span className="data-inline-attachment-empty">{t('cell.pasteOrUpload')}</span> : null}
        </div>
        {!field.readonly ? (
          <>
            <button type="button" className="data-inline-attachment-add" disabled={uploading || !documentId || !tableId} onClick={() => fileInputRef.current?.click()}>
              {uploading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void appendFiles(Array.from(event.target.files || []))} />
          </>
        ) : null}
        {localError ? <span className="data-inline-attachment-error">{localError}</span> : null}
      </div>
    )
  }

  if (field.type === 'single_select') {
    const choices = normalizeChoiceList(field)
    return (
      <Select value={draft} disabled={field.readonly} onChange={(event) => {
        setDraft(event.target.value)
        onCommit(event.target.value)
      }}>
        <option value="">{t('cell.empty')}</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            <span className={cn('data-inline-select-pill', `tone-${getSelectChoiceTone(field, choice)}`)}>{choice}</span>
          </option>
        ))}
      </Select>
    )
  }

  if (field.type === 'multi_select') {
    const values = Array.isArray(value) ? value.map(String) : displayValue(value).split(',').map((item) => item.trim()).filter(Boolean)
    return (
      <input
        className="data-inline-cell-input"
        value={draft}
        readOnly={field.readonly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        placeholder={values.length ? values.join(', ') : ''}
      />
    )
  }

  if (field.type === 'url') {
    const parsed = parseUrlValue(draft)
    return (
      <div className="data-inline-url-cell">
        <input
          className="data-inline-cell-input"
          type="url"
          value={draft}
          readOnly={field.readonly}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
        />
        {parsed ? (
          <a
            className="data-inline-url-link"
            href={parsed.href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            title={t('cell.openUrl', { label: parsed.label })}
            aria-label={t('cell.openLinkNewTab')}
          >
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>
    )
  }

  if (field.type === 'document_link') {
    return (
      <div className="data-inline-url-cell">
        <input
          className="data-inline-cell-input"
          value={draft}
          readOnly={field.readonly}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {draft && onOpenDocument ? (
          <button
            type="button"
            className="data-inline-url-link"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onOpenDocument(draft)
            }}
            title={`Open ${draft}`}
            aria-label={`Open document ${draft}`}
          >
            <FileText className="size-3.5" />
          </button>
        ) : null}
      </div>
    )
  }

  if (field.type === 'rating') {
    return <RatingControl field={field} value={value} readonly={Boolean(field.readonly)} onCommit={onCommit} />
  }

  if (field.type === 'link_to_record') {
    return <LinkChips value={value} placeholder={t('cell.noLinksExpand')} />
  }

  if (field.type === 'user') {
    return <UserChips value={value} placeholder={t('cell.noUsersExpand')} />
  }

  if (field.type === 'button') {
    const { label, action } = buttonConfig(field, t('cell.runButton'))
    return (
      <button
        type="button"
        className="data-inline-button-cell"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (action.kind === 'open_url' && action.url) {
            window.open(action.url, '_blank', 'noopener,noreferrer')
          }
        }}
      >
        {label}
      </button>
    )
  }

  if (
    field.type === 'auto_number' ||
    field.type === 'created_time' ||
    field.type === 'last_modified_time' ||
    field.type === 'created_by' ||
    field.type === 'last_modified_by' ||
    field.type === 'lookup' ||
    field.type === 'rollup'
  ) {
    const text = formatTableFieldValue(field, value)
    return (
      <span className="data-inline-readonly-cell" title={text}>
        {text || <span className="text-muted-foreground">—</span>}
      </span>
    )
  }

  if (field.type === 'long_text') {
    return (
      <textarea
        className="data-inline-longtext-cell"
        value={draft}
        readOnly={field.readonly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(draft)}
        rows={4}
      />
    )
  }

  return (
    <input
      className="data-inline-cell-input"
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      type={field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
      step={field.type === 'datetime' ? 1 : undefined}
      value={draft}
      readOnly={field.readonly}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(
        field.type === 'date'
          ? fromDateInputValue('date', draft)
          : field.type === 'datetime'
            ? fromDateInputValue('datetime-local', draft)
            : draft,
      )}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function DataCellDisplay({
  field,
  value,
  onPreviewAttachments,
  onOpenDocument,
  tableId,
  recordId,
  onRegenerate,
}: {
  field: DataField
  value: DataRecordValue
  onPreviewAttachments?: (items: DataAttachment[], index: number) => void
  onOpenDocument?: (path: string) => void
  tableId?: number
  recordId?: number
  onRegenerate?: (field: DataField) => void
}) {
  const { t } = useTranslation('table')
  if (field.ai_config?.enabled && tableId != null && recordId != null) {
    return (
      <AICellDisplay
        field={field}
        value={value}
        tableId={tableId}
        recordId={recordId}
        onPreviewAttachments={onPreviewAttachments}
        onRegenerate={onRegenerate}
      />
    )
  }
  if (field.type === 'attachment') {
    const attachments = normalizeAttachmentValue(value)
    if (!attachments.length) return <span className="text-muted-foreground">{t('cell.empty')}</span>
    return (
      <AttachmentCell
        attachments={attachments}
        onPreview={(index) => onPreviewAttachments?.(attachments, index)}
      />
    )
  }
  if (field.type === 'document_link') {
    const path = displayValue(value)
    return path && onOpenDocument ? (
      <button
        type="button"
        className="data-inline-url-display"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenDocument(path)
        }}
        title={`Open ${path}`}
      >
        <FileText className="size-3.5" />
        <span>{path}</span>
      </button>
    ) : path ? <span>{path}</span> : <span className="text-muted-foreground">{t('cell.empty')}</span>
  }
  if (
    field.type === 'date'
    || field.type === 'datetime'
    || field.type === 'created_time'
    || field.type === 'last_modified_time'
  ) {
    const text = formatTableFieldValue(field, value)
    return text ? <span>{text}</span> : <span className="text-muted-foreground">{t('cell.empty')}</span>
  }
  if (field.type === 'single_select') {
    const text = displayValue(value)
    return text ? <span className={cn('data-inline-select-pill', `tone-${getSelectChoiceTone(field, text)}`)}>{text}</span> : <span className="text-muted-foreground">{t('cell.empty')}</span>
  }
  if (field.type === 'multi_select') {
    const values = Array.isArray(value) ? value.map(String) : displayValue(value).split(',').map((item) => item.trim()).filter(Boolean)
    return (
      <span className="data-inline-multi-pills">
        {values.length ? values.map((item) => <span key={item} className={cn('data-inline-select-pill', `tone-${getSelectChoiceTone(field, item)}`)}>{item}</span>) : <span className="text-muted-foreground">{t('cell.empty')}</span>}
      </span>
    )
  }
  if (field.type === 'checkbox') {
    return value ? <Check className="size-4" /> : <span className="text-muted-foreground">{t('cell.empty')}</span>
  }
  if (field.type === 'rating') {
    return <RatingControl field={field} value={value} readonly />
  }
  if (field.type === 'link_to_record') {
    return <LinkChips value={value} placeholder={t('cell.empty')} />
  }
  if (field.type === 'user') {
    return <UserChips value={value} placeholder={t('cell.empty')} />
  }
  if (field.type === 'button') {
    const { label } = buttonConfig(field, t('cell.runButton'))
    return <span className="data-inline-readonly-cell">{label}</span>
  }
  if (
    field.type === 'auto_number' ||
    field.type === 'lookup' ||
    field.type === 'rollup'
  ) {
    const text = displayValue(value)
    return text ? <span className="data-inline-readonly-cell">{text}</span> : <span className="text-muted-foreground">{t('cell.empty')}</span>
  }
  if (field.type === 'created_by' || field.type === 'last_modified_by') {
    const text = displayValue(value)
    return (
      <span className="data-inline-user-chip">
        <UserIcon className="size-3.5" />
        {text || <span className="text-muted-foreground">{t('cell.empty')}</span>}
      </span>
    )
  }
  if (field.type === 'url') {
    const parsed = parseUrlValue(value)
    if (!parsed) {
      const text = displayValue(value)
      return text ? <span>{text}</span> : <span className="text-muted-foreground">{t('cell.empty')}</span>
    }
    return (
      <a
        className="data-inline-url-display"
        href={parsed.href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(event) => event.stopPropagation()}
      >
        {parsed.label}
      </a>
    )
  }
  return <span>{displayValue(value) || <span className="text-muted-foreground">{t('cell.empty')}</span>}</span>
}

function AICellDisplay({
  field,
  value,
  tableId,
  recordId,
  onPreviewAttachments,
  onRegenerate,
}: {
  field: DataField
  value: DataRecordValue
  tableId: number
  recordId: number
  onPreviewAttachments?: (items: DataAttachment[], index: number) => void
  onRegenerate?: (field: DataField) => void
}) {
  const { t } = useTranslation('table')
  const status = useAICellStatus(buildCellKey(tableId, recordId, field.id))
  const isImage = isAttachmentAIConfig(field.ai_config)
  const attachments = isImage && Array.isArray(value)
    ? (value as unknown as DataAttachment[]).filter((item): item is DataAttachment => Boolean(item && typeof item === 'object' && 'url' in item))
    : []
  const hasValue = isImage ? attachments.length > 0 : Boolean(displayValue(value))
  const pending = status.status === 'pending'
  const errored = status.status === 'error'

  return (
    <div className="data-inline-ai-cell">
      {hasValue ? (
        isImage ? (
          <AttachmentCell
            attachments={attachments}
            onPreview={(index) => onPreviewAttachments?.(attachments, index)}
          />
        ) : (
          <span>{displayValue(value)}</span>
        )
      ) : !pending && !errored ? (
        <span className="data-inline-ai-cell-empty">{t('cell.notGenerated')}</span>
      ) : null}

      {pending ? (
        <span className="data-inline-ai-cell-pending">
          <LoaderCircle className="size-3.5 animate-spin" />
          <span>{t('cell.generating')}</span>
        </span>
      ) : null}

      {errored && status.status === 'error' ? (
        <span className="data-inline-ai-cell-error" title={status.message}>
          <span>⚠ {status.message}</span>
        </span>
      ) : null}

      {onRegenerate && !pending ? (
        <button
          type="button"
          className="data-inline-ai-cell-regenerate"
          title={t('cell.regenerate')}
          onClick={(event) => {
            event.stopPropagation()
            onRegenerate(field)
          }}
        >
          <RefreshCcw className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
