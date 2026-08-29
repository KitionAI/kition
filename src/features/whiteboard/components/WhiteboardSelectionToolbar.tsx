import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  Check,
  Columns3,
  FlipHorizontal2,
  FlipVertical2,
  Frame,
  GitBranch,
  Group,
  Maximize2,
  MoreHorizontal,
  RotateCcw,
  RotateCw,
  Rows3,
  Sparkles,
  Ungroup,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import type { WhiteboardMindMapDirection } from '../lib/whiteboardTypes'
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from '@/components/ActionMenu'

export function WhiteboardSelectionToolbar({
  agentAvailable = false,
  controller,
  onAskAgent,
}: {
  agentAvailable?: boolean
  controller: WhiteboardEditorController
  onAskAgent?: () => void
}) {
  const { t } = useTranslation('workspace')
  const unlockedCount = controller.selectedElements.filter((element) => !element.locked).length
  const hasContainer = controller.selectedElements.some((element) => (
    element.kind === 'rectangle'
    && (element.shapeStyle === 'group'
      || element.shapeStyle === 'frame'
      || element.shapeType === 'frame')
  ))
  const hasFrame = controller.selectedElements.some((element) => (
    element.kind === 'rectangle' && element.shapeStyle === 'frame'
  ))
  const mindMapSelected = Boolean(controller.selectedMindMapNode)
  if (controller.tool !== 'select' || unlockedCount < 1) return null

  return (
    <div
      className="absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      aria-label={t('board.selectionToolbar.label')}
      data-testid="whiteboard-selection-toolbar"
    >
      {mindMapSelected ? (
        <>
          <ActionMenu>
            <ActionMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-foreground hover:bg-muted disabled:opacity-40"
                disabled={!controller.canEditMindMap}
                aria-label={t('board.selectionToolbar.mindMap.direction')}
                title={t('board.selectionToolbar.mindMap.direction')}
                data-testid="whiteboard-mind-map-direction"
              >
                <GitBranch className="size-4 text-brand" />
                <span className="max-w-24 truncate">
                  {t('board.selectionToolbar.mindMap.label')}
                </span>
                <MindMapDirectionIcon direction={controller.mindMapDirection || 'right'} />
              </button>
            </ActionMenuTrigger>
            <ActionMenuContent align="center" className="w-48" data-testid="whiteboard-mind-map-direction-menu">
              <ActionMenuLabel>{t('board.selectionToolbar.mindMap.direction')}</ActionMenuLabel>
              {(['both', 'right', 'left', 'down'] as const).map((direction) => (
                <ActionMenuItem
                  key={direction}
                  onSelect={() => controller.setMindMapDirection(direction)}
                  data-testid={`whiteboard-mind-map-direction-${direction}`}
                >
                  <MindMapDirectionIcon direction={direction} />
                  <span className="flex-1">
                    {t(`board.selectionToolbar.mindMap.directions.${direction}`)}
                  </span>
                  {controller.mindMapDirection === direction ? (
                    <Check className="size-4 text-brand" />
                  ) : null}
                </ActionMenuItem>
              ))}
            </ActionMenuContent>
          </ActionMenu>
          <span className="whiteboard-toolbar-separator" aria-hidden="true" />
        </>
      ) : null}
      <SelectionAction
        disabled={!agentAvailable || !onAskAgent}
        label={agentAvailable
          ? t('board.selectionToolbar.askAI')
          : t('board.agentScope.unavailable')}
        onClick={() => onAskAgent?.()}
        testId="whiteboard-ask-ai"
      >
        <Sparkles className="size-4 text-brand" />
      </SelectionAction>
      {!mindMapSelected ? (
        <>
          <span className="whiteboard-toolbar-separator" aria-hidden="true" />
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignLeft')}
            onClick={() => controller.alignSelection('left')}
            testId="whiteboard-align-left"
          >
            <AlignHorizontalJustifyStart className="size-4" />
          </SelectionAction>
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignCenterHorizontal')}
            onClick={() => controller.alignSelection('center-horizontal')}
            testId="whiteboard-align-center-horizontal"
          >
            <AlignHorizontalJustifyCenter className="size-4" />
          </SelectionAction>
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignRight')}
            onClick={() => controller.alignSelection('right')}
            testId="whiteboard-align-right"
          >
            <AlignHorizontalJustifyEnd className="size-4" />
          </SelectionAction>
          <span className="whiteboard-toolbar-separator" aria-hidden="true" />
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignTop')}
            onClick={() => controller.alignSelection('top')}
            testId="whiteboard-align-top"
          >
            <AlignVerticalJustifyStart className="size-4" />
          </SelectionAction>
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignCenterVertical')}
            onClick={() => controller.alignSelection('center-vertical')}
            testId="whiteboard-align-center-vertical"
          >
            <AlignVerticalJustifyCenter className="size-4" />
          </SelectionAction>
          <SelectionAction
            disabled={unlockedCount < 2}
            label={t('board.selectionToolbar.alignBottom')}
            onClick={() => controller.alignSelection('bottom')}
            testId="whiteboard-align-bottom"
          >
            <AlignVerticalJustifyEnd className="size-4" />
          </SelectionAction>
          <span className="whiteboard-toolbar-separator" aria-hidden="true" />
        </>
      ) : null}
      <ActionMenu>
        <ActionMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('board.selectionToolbar.more')}
            title={t('board.selectionToolbar.more')}
            data-testid="whiteboard-selection-more"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </ActionMenuTrigger>
        <ActionMenuContent align="center" className="w-60" data-testid="whiteboard-selection-menu">
          <ActionMenuLabel>{t('board.selectionToolbar.spacing')}</ActionMenuLabel>
          <ActionMenuItem
            disabled={unlockedCount < 3}
            onSelect={() => controller.distributeSelection('horizontal')}
            data-testid="whiteboard-distribute-horizontal"
          >
            <AlignHorizontalSpaceBetween className="size-4" />
            {t('board.selectionToolbar.distributeHorizontal')}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={unlockedCount < 3}
            onSelect={() => controller.distributeSelection('vertical')}
            data-testid="whiteboard-distribute-vertical"
          >
            <AlignVerticalSpaceBetween className="size-4" />
            {t('board.selectionToolbar.distributeVertical')}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={unlockedCount < 2}
            onSelect={() => controller.stackSelection('horizontal')}
            data-testid="whiteboard-stack-horizontal"
          >
            <Columns3 className="size-4" />
            {t('board.selectionToolbar.stackHorizontal')}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={unlockedCount < 2}
            onSelect={() => controller.stackSelection('vertical')}
            data-testid="whiteboard-stack-vertical"
          >
            <Rows3 className="size-4" />
            {t('board.selectionToolbar.stackVertical')}
          </ActionMenuItem>
          <ActionMenuSeparator />
          <ActionMenuLabel>{t('board.selectionToolbar.transform')}</ActionMenuLabel>
          <ActionMenuItem onSelect={() => controller.rotateSelection(-90)} data-testid="whiteboard-rotate-counterclockwise">
            <RotateCcw className="size-4" />
            {t('board.selectionToolbar.rotateCounterclockwise')}
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => controller.rotateSelection(90)} data-testid="whiteboard-rotate-clockwise">
            <RotateCw className="size-4" />
            {t('board.selectionToolbar.rotateClockwise')}
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => controller.flipSelection('horizontal')} data-testid="whiteboard-flip-horizontal">
            <FlipHorizontal2 className="size-4" />
            {t('board.selectionToolbar.flipHorizontal')}
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => controller.flipSelection('vertical')} data-testid="whiteboard-flip-vertical">
            <FlipVertical2 className="size-4" />
            {t('board.selectionToolbar.flipVertical')}
          </ActionMenuItem>
          <ActionMenuSeparator />
          <ActionMenuLabel>{t('board.selectionToolbar.containers')}</ActionMenuLabel>
          <ActionMenuItem
            disabled={unlockedCount < 2}
            onSelect={() => controller.groupSelection('group')}
            data-testid="whiteboard-group-selection"
          >
            <Group className="size-4" />
            {t('board.selectionToolbar.group')}
          </ActionMenuItem>
          <ActionMenuItem onSelect={() => controller.groupSelection('frame')} data-testid="whiteboard-frame-selection">
            <Frame className="size-4" />
            {t('board.selectionToolbar.frame')}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={!hasFrame}
            onSelect={controller.fitFramesToContent}
            data-testid="whiteboard-fit-frame"
          >
            <Maximize2 className="size-4" />
            {t('board.selectionToolbar.fitFrame')}
          </ActionMenuItem>
          <ActionMenuItem
            disabled={!hasContainer}
            onSelect={controller.ungroupSelection}
            data-testid="whiteboard-ungroup-selection"
          >
            <Ungroup className="size-4" />
            {t('board.selectionToolbar.ungroup')}
          </ActionMenuItem>
        </ActionMenuContent>
      </ActionMenu>
    </div>
  )
}

function MindMapDirectionIcon({
  direction,
}: {
  direction: WhiteboardMindMapDirection
}) {
  switch (direction) {
    case 'right': return <ArrowRight className="size-4" />
    case 'left': return <ArrowLeft className="size-4" />
    case 'down': return <ArrowDown className="size-4" />
    case 'both': return <ArrowLeftRight className="size-4" />
  }
}

function SelectionAction({
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
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:text-muted-foreground disabled:opacity-40"
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
