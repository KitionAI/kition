import { MoreHorizontal } from 'lucide-react'
import { type ComponentProps, type RefObject, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import {
  WorkspaceDocumentItemMenu,
  WorkspaceMarkdownItemMenu,
  WorkspaceTableItemMenu,
} from '@/features/workspace/components/WorkspaceItemMenu'
import { WorkspaceTabStrip } from '@/features/workspace/components/WorkspaceTabStrip'
import type {
  EditorMode,
  EditorTextStyle,
  EditorViewPreferences,
} from '@/features/workspace/hooks/useWorkspaceChrome'
import type { TableAction } from '@/features/table/lib/tableActions'
import { useDismissableLayer } from '@/registry/hooks/use-on-click-outside'

export function WorkspaceTopbar({
  tabsPortal,
  documentToolbarPortal,
  tabStripProps,
  importInputRef,
  itemMenuOpen,
  activeItemFormat,
  editorView,
  editorTextStyleOptions,
  hasActiveItem,
  hasUnsavedChanges,
  itemWordCount,
  activeItemUpdatedAt,
  canImportSource,
  onFileChange,
  onToggleItemMenu,
  onCloseItemMenu,
  onSetEditorMode,
  onSetTextStyle,
  onToggleEditorPreference,
  onRestoreSavedDraft,
  onTriggerImport,
  onOpenExportDialog,
  onOpenWorkspaceFolder,
  onRunActiveDataTableAction,
  formatTime,
}: {
  tabsPortal: HTMLElement | null
  documentToolbarPortal: HTMLElement | null
  tabStripProps: ComponentProps<typeof WorkspaceTabStrip>
  importInputRef: RefObject<HTMLInputElement | null>
  itemMenuOpen: boolean
  activeItemFormat: string
  editorView: EditorViewPreferences
  editorTextStyleOptions: Array<{ value: EditorTextStyle; label: string; sample: string }>
  hasActiveItem: boolean
  hasUnsavedChanges: boolean
  itemWordCount: number
  activeItemUpdatedAt?: string | null
  canImportSource: boolean
  onFileChange: (file?: File) => void
  onToggleItemMenu: () => void
  onCloseItemMenu: () => void
  onSetEditorMode: (mode: EditorMode) => void
  onSetTextStyle: (style: EditorTextStyle) => void
  onToggleEditorPreference: (key: 'smallText' | 'fullWidth' | 'toc' | 'locked') => void
  onRestoreSavedDraft: () => void
  onTriggerImport: () => void
  onOpenExportDialog: () => void
  onOpenWorkspaceFolder: () => void
  onRunActiveDataTableAction: (action: TableAction) => void
  formatTime: (value?: string | null) => string
}) {
  const itemMenuRef = useRef<HTMLSpanElement | null>(null)
  const { t } = useTranslation('workspace')
  useDismissableLayer(itemMenuRef, itemMenuOpen, onCloseItemMenu)

  return (
    <>
      {tabsPortal && (tabStripProps.tabs.length > 0 || tabStripProps.sidebarCollapsed)
        ? createPortal(<WorkspaceTabStrip {...tabStripProps} />, tabsPortal)
        : null}
      {documentToolbarPortal ? createPortal(
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            className="hidden"
            onChange={(event) => onFileChange(event.target.files?.[0])}
          />
          <span ref={itemMenuRef} className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleItemMenu}
              title={t('topbar.more')}
              aria-label={t('topbar.more')}
              className="document-title-row-menu-trigger !h-auto !w-auto !min-w-0 !rounded !p-1 !bg-transparent !text-muted-foreground !opacity-60 hover:!bg-accent/60 hover:!text-foreground hover:!opacity-100 focus-visible:!opacity-100 data-[state=open]:!opacity-100 [&_svg]:!size-[14px]"
            >
              <MoreHorizontal className="size-4" />
            </Button>
            {itemMenuOpen ? (
              activeItemFormat === 'data' ? (
                <WorkspaceTableItemMenu
                  onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                  onRunActiveDataTableAction={onRunActiveDataTableAction}
                />
              ) : activeItemFormat === 'markdown' ? (
                <WorkspaceMarkdownItemMenu
                  editorMode={editorView.editorMode}
                  hasActiveItem={hasActiveItem}
                  onOpenExportDialog={onOpenExportDialog}
                  onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                  onSetEditorMode={onSetEditorMode}
                />
              ) : (
                <WorkspaceDocumentItemMenu
                  activeItemFormat={activeItemFormat}
                  activeItemUpdatedAt={activeItemUpdatedAt}
                  canImportSource={canImportSource}
                  editorTextStyleOptions={editorTextStyleOptions}
                  editorView={editorView}
                  formatTime={formatTime}
                  hasActiveItem={hasActiveItem}
                  hasUnsavedChanges={hasUnsavedChanges}
                  itemWordCount={itemWordCount}
                  onOpenExportDialog={onOpenExportDialog}
                  onOpenWorkspaceFolder={onOpenWorkspaceFolder}
                  onRestoreSavedDraft={onRestoreSavedDraft}
                  onSetEditorMode={onSetEditorMode}
                  onSetTextStyle={onSetTextStyle}
                  onToggleEditorPreference={onToggleEditorPreference}
                  onTriggerImport={onTriggerImport}
                />
              )
            ) : null}
          </span>
        </>,
        documentToolbarPortal,
      ) : null}
    </>
  )
}
