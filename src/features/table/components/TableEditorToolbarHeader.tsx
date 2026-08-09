import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { DataView } from '@/types/dataDocument'
import {
  getViewIcon,
  getViewTypeLabelKey,
  normalizeLegacyViewTitle,
  type DataInlineViewMode,
  viewTypeOptions,
} from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/registry/ui/popover'
import { useDismissableLayer } from '@/registry/hooks/use-on-click-outside'

export function TableEditorToolbarHeader({
  tableViews,
  activeViewId,
  onSelectView,
  viewCreateOpen,
  onToggleViewCreate,
  onCloseViewCreate,
  onCreateView,
  onRenameView,
  onDuplicateView,
  onDeleteView,
  busy,
}: {
  tableViews: DataView[]
  activeViewId: number | null
  onSelectView: (viewId: number) => void
  viewCreateOpen: boolean
  onToggleViewCreate: () => void
  onCloseViewCreate: () => void
  onCreateView: (type: DataInlineViewMode) => void
  onRenameView: (viewId: number, nextTitle: string) => void
  onDuplicateView: (viewId: number) => void
  onDeleteView: (viewId: number) => void
  busy: boolean
}) {
  const { t } = useTranslation('table')
  const viewCreateRef = useRef<HTMLDivElement | null>(null)
  useDismissableLayer(viewCreateRef, viewCreateOpen, onCloseViewCreate)

  return (
    <div className="data-inline-topbar">
      <div className="data-inline-header-left">
        <div className="data-inline-view-tabs">
          {tableViews.map((view) => (
            <ViewTab
              key={view.id}
              view={view}
              active={activeViewId === view.id}
              label={normalizeLegacyViewTitle(view) || t(getViewTypeLabelKey(view.type))}
              onSelect={() => onSelectView(view.id)}
              onRename={onRenameView}
              onDuplicate={onDuplicateView}
              onDelete={onDeleteView}
              canDelete={tableViews.length > 1}
              busy={busy}
            />
          ))}
        </div>
        <div ref={viewCreateRef} className="data-inline-add-view">
          <button
            type="button"
            className="data-inline-add-view-trigger"
            title={t('header.addView')}
            onClick={onToggleViewCreate}
            disabled={busy}
          >
            <Plus className="size-4" />
          </button>
          {viewCreateOpen ? (
            <div className="data-inline-add-view-menu">
              {viewTypeOptions.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => onCreateView(item.type)}
                >
                  {getViewIcon(item.type)}
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ViewTab({
  view,
  active,
  label,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  canDelete,
  busy,
}: {
  view: DataView
  active: boolean
  label: string
  onSelect: () => void
  onRename: (viewId: number, nextTitle: string) => void
  onDuplicate: (viewId: number) => void
  onDelete: (viewId: number) => void
  canDelete: boolean
  busy: boolean
}) {
  const { t } = useTranslation('table')
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(label)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!renaming) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renaming])

  function commitRename() {
    const nextTitle = draftTitle.trim()
    setRenaming(false)
    if (nextTitle) onRename(view.id, nextTitle)
  }

  return (
    <div className={cn('data-inline-view-tab', active && 'is-active')}>
      {renaming ? (
        <div className="data-inline-view-tab-rename">
          {getViewIcon(view.type)}
          <input
            ref={renameInputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
            aria-label="View name"
            data-testid={`data-view-rename-${view.id}`}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn('data-inline-view-tab-select', active && 'is-active')}
          onClick={onSelect}
          aria-label={label}
        >
          {getViewIcon(view.type)}
          <span>{label}</span>
        </button>
      )}
      {active && !renaming ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="data-inline-view-tab-menu-trigger"
              aria-label={t('viewMenu.open')}
              title={t('viewMenu.optionsFor', { title: label })}
              aria-expanded={menuOpen}
              disabled={busy}
              data-testid={`data-view-menu-${view.id}`}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="data-inline-view-tab-menu"
            role="menu"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              disabled={busy || view.locked}
              onClick={() => {
                setMenuOpen(false)
                setDraftTitle(label)
                setRenaming(true)
              }}
            >
              <Pencil className="size-4" />
              <span>{t('viewMenu.rename')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false)
                onDuplicate(view.id)
              }}
            >
              <Copy className="size-4" />
              <span>{t('viewMenu.duplicate')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-destructive"
              disabled={busy || view.locked || !canDelete}
              title={!canDelete ? t('viewMenu.keepOne') : undefined}
              onClick={() => {
                setMenuOpen(false)
                onDelete(view.id)
              }}
            >
              <Trash2 className="size-4" />
              <span>{t('viewMenu.delete')}</span>
            </button>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
