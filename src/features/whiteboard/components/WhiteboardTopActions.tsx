import {
  ChevronDown,
  Copy,
  Lock,
  Maximize2,
  MoreHorizontal,
  Redo2,
  Rows3,
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
          className="flex h-8 max-w-52 items-center gap-2 rounded-md px-2.5 text-sm font-semibold text-foreground hover:bg-muted"
          onClick={() => setPageOpen((open) => !open)}
          aria-expanded={pageOpen}
          title={title}
        >
          <span className="truncate">{title}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
        {pageOpen ? (
          <div
            className="absolute left-0 top-full mt-2 w-56 rounded-xl border bg-popover p-2 shadow-[var(--shadow-floating)]"
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
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
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
          <div className="absolute right-0 top-full mt-2 w-48 rounded-xl border bg-popover p-1.5 shadow-[var(--shadow-floating)]">
            <MenuButton label={t('board.topActions.selectAll')} onClick={controller.selectAll}>
              <Rows3 className="size-4" />
            </MenuButton>
            <MenuButton
              label={t('board.toolbar.fit')}
              onClick={() => controller.fitToContent(canvasSize)}
            >
              <Maximize2 className="size-4" />
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
  label,
  onClick,
}: {
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-muted')}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  )
}
