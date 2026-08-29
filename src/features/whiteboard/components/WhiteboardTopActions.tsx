import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Focus,
  Grid3X3,
  FileImage,
  Lock,
  Magnet,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Redo2,
  Ratio,
  Rows3,
  Scissors,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import type { WhiteboardPoint } from '../lib/whiteboardTypes'
import { cn } from '@/lib/utils'
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from '@/components/ActionMenu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/registry/ui/popover'
import { WhiteboardTemplateGallery } from './WhiteboardTemplateGallery'

export function WhiteboardTopActions({
  canvasSize,
  controller,
  title,
}: {
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
  title: string
}) {
  const { t } = useTranslation('workspace')
  const [pageOpen, setPageOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [renamingPageId, setRenamingPageId] = useState('')
  const [pageName, setPageName] = useState('')
  const currentPage = controller.pages.find((page) => page.id === controller.currentPageId)

  useEffect(() => {
    if (!pageOpen) setRenamingPageId('')
  }, [pageOpen])

  function startRename(pageId: string, name: string) {
    setRenamingPageId(pageId)
    setPageName(name)
  }

  function commitRename() {
    if (!renamingPageId) return
    controller.renamePage(renamingPageId, pageName)
    setRenamingPageId('')
  }

  return (
    <div
      className="absolute left-4 top-3 z-30 flex items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      data-testid="whiteboard-top-actions"
    >
      <Popover open={pageOpen} onOpenChange={(open) => {
        setPageOpen(open)
        if (open) {
          setMoreOpen(false)
          setTemplateOpen(false)
        }
      }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="whiteboard-page-trigger flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-semibold text-foreground hover:bg-muted"
            title={currentPage?.name || title}
            data-testid="whiteboard-page-trigger"
          >
            <span className="truncate">{currentPage?.name || title}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="whiteboard-page-menu w-72 rounded-xl border p-2 shadow-[var(--shadow-floating)]"
          data-testid="whiteboard-page-menu"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <div className="text-[11px] font-semibold text-muted-foreground">
              {t('board.topActions.pages')}
            </div>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => controller.createPage()}
              aria-label={t('board.topActions.createPage')}
              data-testid="whiteboard-page-create"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {controller.pages.map((page, index) => (
              <div
                key={page.id}
                className={cn(
                  'group flex min-h-9 items-center gap-1 rounded-md px-1 text-sm',
                  page.id === controller.currentPageId && 'bg-accent text-accent-foreground',
                )}
                data-testid={`whiteboard-page-row-${page.id}`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left">
                  <Rows3 className="size-4 shrink-0" />
                  {renamingPageId === page.id ? (
                    <input
                      className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none ring-ring focus:ring-2"
                      value={pageName}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setPageName(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename()
                        if (event.key === 'Escape') setRenamingPageId('')
                      }}
                      data-testid="whiteboard-page-name-input"
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => {
                        controller.activatePage(page.id)
                        setPageOpen(false)
                      }}
                    >
                      {page.name}
                    </button>
                  )}
                </div>
                {renamingPageId === page.id ? (
                  <PageIconButton label={t('board.topActions.savePageName')} onClick={commitRename}>
                    <Check className="size-3.5" />
                  </PageIconButton>
                ) : (
                  <PageIconButton
                    label={t('board.topActions.renamePage')}
                    onClick={() => startRename(page.id, page.name)}
                    testId={`whiteboard-page-rename-${page.id}`}
                  >
                    <Pencil className="size-3.5" />
                  </PageIconButton>
                )}
                <PageIconButton
                  disabled={index === 0}
                  label={t('board.topActions.movePagePrevious')}
                  onClick={() => controller.reorderPage(page.id, 'previous')}
                >
                  <ArrowUp className="size-3.5" />
                </PageIconButton>
                <PageIconButton
                  disabled={index === controller.pages.length - 1}
                  label={t('board.topActions.movePageNext')}
                  onClick={() => controller.reorderPage(page.id, 'next')}
                >
                  <ArrowDown className="size-3.5" />
                </PageIconButton>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 border-t pt-2">
            <button
              type="button"
              className="flex h-8 items-center justify-center gap-2 rounded-md text-sm text-foreground hover:bg-muted"
              onClick={() => controller.duplicatePage()}
              data-testid="whiteboard-page-duplicate"
            >
              <Copy className="size-4" />
              {t('board.topActions.duplicatePage')}
            </button>
            <button
              type="button"
              className="flex h-8 items-center justify-center gap-2 rounded-md text-sm text-destructive hover:bg-destructive-background disabled:text-muted-foreground"
              disabled={controller.pages.length < 2}
              onClick={() => controller.deletePage()}
              data-testid="whiteboard-page-delete"
            >
              <Trash2 className="size-4" />
              {t('board.topActions.deletePage')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <span className="whiteboard-toolbar-separator" aria-hidden="true" />
      <WhiteboardTemplateGallery
        canvasSize={canvasSize}
        controller={controller}
        open={templateOpen}
        onOpenChange={(open) => {
          setTemplateOpen(open)
          if (open) {
            setMoreOpen(false)
            setPageOpen(false)
          }
        }}
      />
      <span className="whiteboard-toolbar-separator" aria-hidden="true" />
      <ActionButton
        disabled={!controller.canUndo}
        label={t('board.toolbar.undo')}
        onClick={controller.undo}
        testId="whiteboard-undo"
      >
        <Undo2 className="size-4" />
      </ActionButton>
      <ActionButton
        disabled={!controller.canRedo}
        label={t('board.toolbar.redo')}
        onClick={controller.redo}
        testId="whiteboard-redo"
      >
        <Redo2 className="size-4" />
      </ActionButton>
      <ActionButton
        disabled={!controller.hasUnlockedSelection}
        label={t('board.topActions.duplicate')}
        onClick={controller.duplicateSelection}
        testId="whiteboard-duplicate"
      >
        <Copy className="size-4" />
      </ActionButton>
      <ActionButton
        disabled={!controller.hasSelection}
        label={t(controller.allSelectedLocked ? 'board.toolbar.unlock' : 'board.toolbar.lock')}
        onClick={controller.toggleSelectionLock}
        testId="whiteboard-toggle-lock"
      >
        {controller.allSelectedLocked ? <Unlock className="size-4" /> : <Lock className="size-4" />}
      </ActionButton>
      <ActionButton
        disabled={!controller.hasUnlockedSelection}
        label={t('board.toolbar.delete')}
        onClick={controller.deleteSelection}
        testId="whiteboard-delete"
      >
        <Trash2 className="size-4" />
      </ActionButton>
      <ActionMenu open={moreOpen} onOpenChange={(open) => {
        setMoreOpen(open)
        if (open) {
          setPageOpen(false)
          setTemplateOpen(false)
        }
      }}>
        <ActionMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('board.topActions.more')}
            title={t('board.topActions.more')}
            data-testid="whiteboard-more-actions"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </ActionMenuTrigger>
        <ActionMenuContent className="whiteboard-more-menu w-52" data-testid="whiteboard-more-menu">
            <ActionMenuItem onSelect={controller.selectAll}>
              <Rows3 className="size-4" />
              {t('board.topActions.selectAll')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasSelection}
              onSelect={() => controller.copySelection()}
              data-testid="whiteboard-copy"
            >
              <ClipboardCopy className="size-4" />
              {t('board.topActions.copy')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasUnlockedSelection}
              onSelect={() => controller.cutSelection()}
              data-testid="whiteboard-cut"
            >
              <Scissors className="size-4" />
              {t('board.topActions.cut')}
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => void controller.pasteFromClipboard()}
              data-testid="whiteboard-paste"
            >
              <ClipboardPaste className="size-4" />
              {t('board.topActions.paste')}
            </ActionMenuItem>
            <ActionMenuSeparator />
            <ActionMenuItem
              disabled={!controller.hasUnlockedSelection}
              onSelect={() => controller.reorderSelection('front')}
              data-testid="whiteboard-bring-to-front"
            >
              <ChevronsUp className="size-4" />
              {t('board.topActions.bringToFront')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasUnlockedSelection}
              onSelect={() => controller.reorderSelection('forward')}
              data-testid="whiteboard-bring-forward"
            >
              <ArrowUp className="size-4" />
              {t('board.topActions.bringForward')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasUnlockedSelection}
              onSelect={() => controller.reorderSelection('backward')}
              data-testid="whiteboard-send-backward"
            >
              <ArrowDown className="size-4" />
              {t('board.topActions.sendBackward')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasUnlockedSelection}
              onSelect={() => controller.reorderSelection('back')}
              data-testid="whiteboard-send-to-back"
            >
              <ChevronsDown className="size-4" />
              {t('board.topActions.sendToBack')}
            </ActionMenuItem>
            <ActionMenuSeparator />
            <ActionMenuItem
              onSelect={() => controller.fitToContent(canvasSize)}
            >
              <Maximize2 className="size-4" />
              {t('board.toolbar.fit')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.canCameraBack}
              onSelect={controller.cameraBack}
              data-testid="whiteboard-camera-back"
            >
              <ArrowLeft className="size-4" />
              {t('board.topActions.cameraBack')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.canCameraForward}
              onSelect={controller.cameraForward}
              data-testid="whiteboard-camera-forward"
            >
              <ArrowRight className="size-4" />
              {t('board.topActions.cameraForward')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={!controller.hasSelection}
              onSelect={() => controller.zoomToSelection(canvasSize)}
              data-testid="whiteboard-zoom-to-selection"
            >
              <Focus className="size-4" />
              {t('board.topActions.zoomToSelection')}
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => controller.actualSize(canvasSize)}
              data-testid="whiteboard-actual-size"
            >
              <Ratio className="size-4" />
              {t('board.topActions.actualSize')}
            </ActionMenuItem>
            <ActionMenuSeparator />
            <ActionMenuItem onSelect={controller.toggleGrid} data-testid="whiteboard-toggle-grid">
              {controller.gridVisible ? <Check className="size-4" /> : <Grid3X3 className="size-4" />}
              {t('board.topActions.grid')}
            </ActionMenuItem>
            <ActionMenuItem onSelect={controller.toggleSnap} data-testid="whiteboard-toggle-snap">
              {controller.snapEnabled ? <Check className="size-4" /> : <Magnet className="size-4" />}
              {t('board.topActions.snap')}
            </ActionMenuItem>
            <ActionMenuItem onSelect={controller.toggleToolLock} data-testid="whiteboard-toggle-tool-lock">
              {controller.toolLocked ? <Check className="size-4" /> : <Pin className="size-4" />}
              {t('board.topActions.toolLock')}
            </ActionMenuItem>
            <ActionMenuSeparator />
            <ActionMenuItem
              disabled={controller.elements.length === 0}
              onSelect={() => void controller.exportSvg(title)}
              data-testid="whiteboard-export-svg"
            >
              <Download className="size-4" />
              {t('board.topActions.exportSvg')}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={controller.elements.length === 0}
              onSelect={() => void controller.exportPng(title)}
              data-testid="whiteboard-export-png"
            >
              <FileImage className="size-4" />
              {t('board.topActions.exportPng')}
            </ActionMenuItem>
        </ActionMenuContent>
      </ActionMenu>
    </div>
  )
}

function ActionButton({
  children,
  disabled = false,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => unknown
  testId: string
}) {
  return (
    <button
      type="button"
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:bg-muted disabled:text-muted-foreground"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

function PageIconButton({
  children,
  disabled = false,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground disabled:text-muted-foreground group-hover:opacity-100 focus:opacity-100')}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  )
}
