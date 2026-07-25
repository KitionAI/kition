import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Copy, History, Link2, MessageSquare, Send, Sparkles, Trash2 } from 'lucide-react'
import type { DataRecord } from '@/types/dataDocument'
import { cn } from '@/lib/utils'

export function ToolbarPopover({
  open,
  onOpenChange,
  buttonClassName,
  menuClassName,
  active,
  icon,
  label,
  children,
  align = 'left',
  testId,
  menuTestId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  buttonClassName: string
  menuClassName?: string
  active: boolean
  icon: ReactNode
  label: string
  children: ReactNode
  align?: 'left' | 'right'
  testId?: string
  menuTestId?: string
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onOpenChange(false)
    }

    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onOpenChange, open])

  return (
    <div ref={rootRef} className="data-inline-toolbar-popover">
      <button
        type="button"
        className={cn('data-inline-toolbar-group', buttonClassName, active && 'is-active', open && 'is-open')}
        onClick={() => onOpenChange(!open)}
        data-testid={testId}
      >
        {icon}
        {label ? <span>{label}</span> : null}
      </button>
      {open ? <div className={cn('data-inline-toolbar-menu', align === 'right' && 'is-right', menuClassName)} data-testid={menuTestId}>{children}</div> : null}
    </div>
  )
}

export function DataRecordContextMenu({
  record,
  position,
  busy,
  canInsert,
  canRegenerateAI,
  onClose,
  onInsertAbove,
  onInsertBelow,
  onDuplicate,
  onCopyURL,
  onHistory,
  onComment,
  onAddToChat,
  onRegenerateAI,
  onDelete,
}: {
  record: DataRecord
  position: { x: number; y: number }
  busy: boolean
  canInsert: boolean
  canRegenerateAI: boolean
  onClose: () => void
  onInsertAbove: (count: number) => void
  onInsertBelow: (count: number) => void
  onDuplicate: () => void
  onCopyURL: () => void
  onHistory: () => void
  onComment: () => void
  onAddToChat: () => void
  onRegenerateAI: () => void
  onDelete: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation('table')
  const [aboveCount, setAboveCount] = useState(1)
  const [belowCount, setBelowCount] = useState(1)
  const left = typeof window === 'undefined' ? position.x : Math.min(position.x, Math.max(12, window.innerWidth - 270))
  const top = typeof window === 'undefined' ? position.y : Math.min(position.y, Math.max(12, window.innerHeight - 330))

  useEffect(() => {
    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose()
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  function cleanCount(value: number) {
    return Math.max(1, Math.min(50, Math.floor(value) || 1))
  }

  return (
    <div
      ref={rootRef}
      className="data-inline-record-menu"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      data-record-id={record.id}
    >
      <div className="data-inline-record-menu-section">
        <div className={cn('data-inline-record-menu-insert', !canInsert && 'is-disabled')}>
          <button type="button" onClick={() => onInsertAbove(cleanCount(aboveCount))} disabled={busy || !canInsert}>
            <ArrowUp className="size-4" />
          </button>
          <span>{t('recordMenu.insert')}</span>
          <input
            type="number"
            min={1}
            max={50}
            value={aboveCount}
            disabled={busy || !canInsert}
            onChange={(event) => setAboveCount(cleanCount(Number(event.target.value)))}
            aria-label={t('recordMenu.insertAboveCount')}
          />
          <span>{t('recordMenu.recordAbove')}</span>
        </div>
        <div className={cn('data-inline-record-menu-insert', !canInsert && 'is-disabled')}>
          <button type="button" onClick={() => onInsertBelow(cleanCount(belowCount))} disabled={busy || !canInsert}>
            <ArrowDown className="size-4" />
          </button>
          <span>{t('recordMenu.insert')}</span>
          <input
            type="number"
            min={1}
            max={50}
            value={belowCount}
            disabled={busy || !canInsert}
            onChange={(event) => setBelowCount(cleanCount(Number(event.target.value)))}
            aria-label={t('recordMenu.insertBelowCount')}
          />
          <span>{t('recordMenu.recordBelow')}</span>
        </div>
      </div>
      <div className="data-inline-record-menu-section">
        <button type="button" className="data-inline-record-menu-item" onClick={onDuplicate} disabled={busy}>
          <Copy className="size-4" />
          {t('recordMenu.duplicateRecord')}
        </button>
        <button type="button" className="data-inline-record-menu-item" onClick={onCopyURL} disabled={busy}>
          <Link2 className="size-4" />
          {t('recordMenu.copyRecordUrl')}
        </button>
      </div>
      <div className="data-inline-record-menu-section">
        <button type="button" className="data-inline-record-menu-item" onClick={onHistory} disabled={busy}>
          <History className="size-4" />
          {t('recordMenu.showHistory')}
        </button>
        <button type="button" className="data-inline-record-menu-item" onClick={onComment} disabled={busy}>
          <MessageSquare className="size-4" />
          {t('recordMenu.addComment')}
        </button>
        <button type="button" className="data-inline-record-menu-item" onClick={onAddToChat} disabled={busy}>
          <Send className="size-4" />
          {t('recordMenu.addToChat')}
        </button>
        {canRegenerateAI ? (
          <button type="button" className="data-inline-record-menu-item" onClick={onRegenerateAI} disabled={busy}>
            <Sparkles className="size-4" />
            {t('recordMenu.regenerateAiFields')}
          </button>
        ) : null}
      </div>
      <div className="data-inline-record-menu-section">
        <button type="button" className="data-inline-record-menu-item is-danger" onClick={onDelete} disabled={busy}>
          <Trash2 className="size-4" />
          {t('recordMenu.deleteRecord')}
        </button>
      </div>
    </div>
  )
}
