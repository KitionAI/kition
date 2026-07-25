import {
  BookOpen,
  Check,
  ChevronRight,
  Code2,
  Download,
  Edit3,
  FileDown,
  FileText,
  FileUp,
  FolderOpen,
  History,
  Link2,
  PencilLine,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { getCurrentLocale } from '@/i18n'
import type {
  EditorMode,
  EditorTextStyle,
  EditorViewPreferences,
} from '@/features/workspace/hooks/useWorkspaceChrome'
import type { TableAction } from '@/features/table/lib/tableActions'

type EditorPreferenceKey = 'smallText' | 'fullWidth' | 'toc' | 'locked'

type WorkspaceDocumentItemMenuProps = {
  activeItemFormat: string
  activeItemUpdatedAt?: string | null
  canImportSource: boolean
  editorTextStyleOptions: Array<{ value: EditorTextStyle; label: string; sample: string }>
  editorView: EditorViewPreferences
  formatTime: (value?: string | null) => string
  hasActiveItem: boolean
  hasUnsavedChanges: boolean
  itemWordCount: number
  onOpenExportDialog: () => void
  onOpenWorkspaceFolder: () => void
  onRestoreSavedDraft: () => void
  onSetEditorMode: (mode: EditorMode) => void
  onSetTextStyle: (style: EditorTextStyle) => void
  onToggleEditorPreference: (key: EditorPreferenceKey) => void
  onTriggerImport: () => void
}

type WorkspaceTableItemMenuProps = {
  onOpenWorkspaceFolder: () => void
  onRunActiveDataTableAction: (action: TableAction) => void
}

const workspaceEditorModeOptions = [
  { value: 'rich' as const, labelKey: 'itemMenu.mode.rich' },
  { value: 'split' as const, labelKey: 'itemMenu.mode.split' },
  { value: 'source' as const, labelKey: 'itemMenu.mode.source' },
  { value: 'preview' as const, labelKey: 'itemMenu.mode.preview' },
]

const workspaceEditorPreferenceOptions: Array<{ key: EditorPreferenceKey; labelKey: string }> = [
  { key: 'smallText', labelKey: 'itemMenu.preference.smallText' },
  { key: 'fullWidth', labelKey: 'itemMenu.preference.fullWidth' },
  { key: 'toc', labelKey: 'itemMenu.preference.toc' },
  { key: 'locked', labelKey: 'itemMenu.preference.locked' },
]

const workspaceTablePrimaryActions: Array<{ action: TableAction; labelKey: string; icon: typeof Edit3 }> = [
  { action: 'rename', labelKey: 'itemMenu.tableAction.rename', icon: Edit3 },
  { action: 'duplicate', labelKey: 'itemMenu.tableAction.duplicate', icon: FileText },
]

const workspaceTableSecondaryActions: Array<{
  action: TableAction
  labelKey: string
  icon: typeof Download
  trailingChevron?: boolean
}> = [
  { action: 'download_csv', labelKey: 'itemMenu.tableAction.downloadCsv', icon: Download },
  { action: 'import_csv', labelKey: 'itemMenu.tableAction.importData', icon: FileUp, trailingChevron: true },
  { action: 'copy_api', labelKey: 'itemMenu.tableAction.api', icon: Terminal },
  { action: 'history', labelKey: 'itemMenu.tableAction.history', icon: History, trailingChevron: true },
  { action: 'share', labelKey: 'itemMenu.tableAction.share', icon: Link2 },
  { action: 'delete', labelKey: 'itemMenu.tableAction.delete', icon: Trash2 },
]

export function WorkspaceDocumentItemMenu({
  activeItemFormat,
  activeItemUpdatedAt,
  canImportSource,
  editorTextStyleOptions,
  editorView,
  formatTime,
  hasActiveItem,
  hasUnsavedChanges,
  itemWordCount,
  onOpenExportDialog,
  onOpenWorkspaceFolder,
  onRestoreSavedDraft,
  onSetEditorMode,
  onSetTextStyle,
  onToggleEditorPreference,
  onTriggerImport,
}: WorkspaceDocumentItemMenuProps) {
  const { t } = useTranslation('workspace')
  return (
    <div className="document-topbar-menu" data-window-drag-exclude="true">
      <div className="document-view-mode-grid">
        {workspaceEditorModeOptions.map((item) => (
          <button
            key={item.value}
            type="button"
            className={cn('document-view-mode-option', editorView.editorMode === item.value && 'is-active')}
            onClick={() => onSetEditorMode(item.value)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="document-menu-separator" />
      <div className="grid grid-cols-3 gap-1 px-2 py-2">
        {editorTextStyleOptions.map((item) => (
          <button
            key={item.value}
            type="button"
            className={cn('document-style-option', editorView.textStyle === item.value && 'is-active')}
            onClick={() => onSetTextStyle(item.value)}
          >
            <strong className={cn(item.value === 'serif' && 'font-serif', item.value === 'mono' && 'font-mono')}>{item.sample}</strong>
            <span>{t('itemMenu.textStyle.' + item.value)}</span>
          </button>
        ))}
      </div>
      <div className="document-menu-separator" />
      <div className="py-1">
        {workspaceEditorPreferenceOptions.map((item) => (
          <button
            key={item.key}
            type="button"
            className="document-menu-row"
            onClick={() => onToggleEditorPreference(item.key)}
          >
            <span>{t(item.labelKey)}</span>
            <span className={cn('document-menu-switch', editorView[item.key] && 'is-on')} />
          </button>
        ))}
      </div>
      <div className="document-menu-separator" />
      <div className="py-1">
        <button type="button" className="document-menu-command" onClick={onRestoreSavedDraft} disabled={!hasActiveItem || !hasUnsavedChanges}>
          <RotateCcw className="size-4" />
          {t('itemMenu.revertToSaved')}
        </button>
        <button type="button" className="document-menu-command" onClick={onTriggerImport} disabled={!canImportSource}>
          <FileDown className="size-4" />
          {t('itemMenu.importMarkdown')}
        </button>
        <button type="button" className="document-menu-command" onClick={onOpenExportDialog} disabled={!hasActiveItem}>
          <FileUp className="size-4" />
          {t('itemMenu.exportFile')}
        </button>
        <button
          type="button"
          className="document-menu-command"
          onClick={onOpenWorkspaceFolder}
          disabled={!hasActiveItem}
        >
          <FolderOpen className="size-4" />
          {t('itemMenu.openContainingFolder')}
        </button>
      </div>
      <div className="document-menu-separator" />
      <div className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
        <div>{t('itemMenu.words', { formattedCount: new Intl.NumberFormat(getCurrentLocale()).format(itemWordCount) })}</div>
        <div>{t('itemMenu.updated', { time: formatTime(activeItemUpdatedAt) })}</div>
      </div>
    </div>
  )
}

type WorkspaceMarkdownItemMenuProps = {
  editorMode: EditorMode
  hasActiveItem: boolean
  onOpenExportDialog: () => void
  onOpenWorkspaceFolder: () => void
  onSetEditorMode: (mode: EditorMode) => void
}

export function WorkspaceMarkdownItemMenu({
  editorMode,
  hasActiveItem,
  onOpenExportDialog,
  onOpenWorkspaceFolder,
  onSetEditorMode,
}: WorkspaceMarkdownItemMenuProps) {
  const { t } = useTranslation('workspace')
  const modeRows: Array<{ value: EditorMode; labelKey: string; icon: typeof BookOpen }> = [
    { value: 'rich', labelKey: 'itemMenu.markdownMode.rich', icon: PencilLine },
    { value: 'preview', labelKey: 'itemMenu.markdownMode.preview', icon: BookOpen },
    { value: 'source', labelKey: 'itemMenu.markdownMode.source', icon: Code2 },
  ]

  return (
    <div className="document-topbar-menu" data-window-drag-exclude="true">
      <div className="py-1">
        {modeRows.map((row) => {
          const Icon = row.icon
          const active = editorMode === row.value
          return (
            <button
              key={row.value}
              type="button"
              className={cn('document-menu-command', active && 'is-active')}
              onClick={() => onSetEditorMode(row.value)}
            >
              <Icon className="size-4" />
              <span className="min-w-0 flex-1">{t(row.labelKey)}</span>
              {active ? <Check className="size-4 text-muted-foreground" /> : null}
            </button>
          )
        })}
      </div>
      <div className="document-menu-separator" />
      <div className="py-1">
        <button
          type="button"
          className="document-menu-command"
          onClick={onOpenExportDialog}
          disabled={!hasActiveItem}
        >
          <FileUp className="size-4" />
          {t('itemMenu.exportFile')}
        </button>
        <button
          type="button"
          className="document-menu-command"
          onClick={onOpenWorkspaceFolder}
          disabled={!hasActiveItem}
        >
          <FolderOpen className="size-4" />
          {t('itemMenu.openContainingFolder')}
        </button>
      </div>
    </div>
  )
}

export function WorkspaceTableItemMenu({
  onOpenWorkspaceFolder,
  onRunActiveDataTableAction,
}: WorkspaceTableItemMenuProps) {
  const { t } = useTranslation('workspace')
  return (
    <div className="document-topbar-menu document-table-topbar-menu" data-window-drag-exclude="true">
      <div className="py-1">
        {workspaceTablePrimaryActions.map((item) => {
          const Icon = item.icon
          return (
            <button key={item.action} type="button" className="document-menu-command" onClick={() => onRunActiveDataTableAction(item.action)}>
              <Icon className="size-4" />
              {t(item.labelKey)}
            </button>
          )
        })}
        <button
          type="button"
          className="document-menu-command"
          onClick={onOpenWorkspaceFolder}
        >
          <FolderOpen className="size-4" />
          {t('itemMenu.openContainingFolder')}
        </button>
      </div>
      <div className="document-menu-separator" />
      <div className="py-1">
        {workspaceTableSecondaryActions.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.action}
              type="button"
              className={cn('document-menu-command', item.action === 'delete' && 'is-danger')}
              onClick={() => onRunActiveDataTableAction(item.action)}
            >
              <Icon className="size-4" />
              <span className="min-w-0 flex-1">{t(item.labelKey)}</span>
              {item.trailingChevron ? <ChevronRight className="ml-auto size-4 text-muted-foreground" /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
