import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Focus,
  FileImage,
  Lock,
  Maximize2,
  MoreHorizontal,
  Redo2,
  Ratio,
  Rows3,
  Scissors,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import type { WhiteboardPoint } from '../lib/whiteboardTypes'
import { cn } from '@/lib/utils'

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
  const [moreOpen, setMoreOpen] = useState(false)
  return (
    <div
      className="absolute left-4 top-3 z-30 flex items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      data-testid="whiteboard-top-actions"
    >
      <div className="relative">
        <button
          type="button"
          className="whiteboard-page-trigger flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-semibold text-foreground hover:bg-muted"
          onClick={() => setPageOpen((open) => !open)}
          aria-expanded={pageOpen}
          title={title}
        >
          <span className="truncate">{title}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
        {pageOpen ? (
          <div
            className="whiteboard-page-menu absolute left-0 mt-2 rounded-xl border bg-popover p-2"
            data-testid="whiteboard-page-menu"
          >
            <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              {t('board.topActions.pages')}
            </div>
            <div className="flex items-center gap-2 rounded-md bg-accent px-2 py-2 text-sm text-accent-foreground">
              <Rows3 className="size-4" />
              <span className="truncate">{title}</span>
            </div>
          </div>
        ) : null}
      </div>
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
      <div className="relative">
        <ActionButton
          label={t('board.topActions.more')}
          onClick={() => setMoreOpen((open) => !open)}
          testId="whiteboard-more-actions"
        >
          <MoreHorizontal className="size-4" />
        </ActionButton>
        {moreOpen ? (
          <div className="whiteboard-more-menu absolute right-0 mt-2 w-48 rounded-xl border bg-popover p-1.5">
            <MenuButton label={t('board.topActions.selectAll')} onClick={controller.selectAll}>
              <Rows3 className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasSelection}
              label={t('board.topActions.copy')}
              onClick={() => controller.copySelection()}
              testId="whiteboard-copy"
            >
              <ClipboardCopy className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasUnlockedSelection}
              label={t('board.topActions.cut')}
              onClick={() => controller.cutSelection()}
              testId="whiteboard-cut"
            >
              <Scissors className="size-4" />
            </MenuButton>
            <MenuButton
              label={t('board.topActions.paste')}
              onClick={() => void controller.pasteFromClipboard()}
              testId="whiteboard-paste"
            >
              <ClipboardPaste className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasUnlockedSelection}
              label={t('board.topActions.bringToFront')}
              onClick={() => controller.reorderSelection('front')}
              testId="whiteboard-bring-to-front"
            >
              <ChevronsUp className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasUnlockedSelection}
              label={t('board.topActions.bringForward')}
              onClick={() => controller.reorderSelection('forward')}
              testId="whiteboard-bring-forward"
            >
              <ArrowUp className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasUnlockedSelection}
              label={t('board.topActions.sendBackward')}
              onClick={() => controller.reorderSelection('backward')}
              testId="whiteboard-send-backward"
            >
              <ArrowDown className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasUnlockedSelection}
              label={t('board.topActions.sendToBack')}
              onClick={() => controller.reorderSelection('back')}
              testId="whiteboard-send-to-back"
            >
              <ChevronsDown className="size-4" />
            </MenuButton>
            <MenuButton
              label={t('board.toolbar.fit')}
              onClick={() => controller.fitToContent(canvasSize)}
            >
              <Maximize2 className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.canCameraBack}
              label={t('board.topActions.cameraBack')}
              onClick={controller.cameraBack}
              testId="whiteboard-camera-back"
            >
              <ArrowLeft className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.canCameraForward}
              label={t('board.topActions.cameraForward')}
              onClick={controller.cameraForward}
              testId="whiteboard-camera-forward"
            >
              <ArrowRight className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={!controller.hasSelection}
              label={t('board.topActions.zoomToSelection')}
              onClick={() => controller.zoomToSelection(canvasSize)}
              testId="whiteboard-zoom-to-selection"
            >
              <Focus className="size-4" />
            </MenuButton>
            <MenuButton
              label={t('board.topActions.actualSize')}
              onClick={() => controller.actualSize(canvasSize)}
              testId="whiteboard-actual-size"
            >
              <Ratio className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={controller.elements.length === 0}
              label={t('board.topActions.exportSvg')}
              onClick={() => void controller.exportSvg(title)}
              testId="whiteboard-export-svg"
            >
              <Download className="size-4" />
            </MenuButton>
            <MenuButton
              disabled={controller.elements.length === 0}
              label={t('board.topActions.exportPng')}
              onClick={() => void controller.exportPng(title)}
              testId="whiteboard-export-png"
            >
              <FileImage className="size-4" />
            </MenuButton>
          </div>
        ) : null}
      </div>
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

function MenuButton({
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
      className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-muted disabled:text-muted-foreground')}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
      {label}
    </button>
  )
}
