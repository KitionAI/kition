import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  Frame,
  Group,
  Sparkles,
  Ungroup,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'

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
  if (controller.tool !== 'select' || unlockedCount < 1) return null

  return (
    <div
      className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      aria-label={t('board.selectionToolbar.label')}
      data-testid="whiteboard-selection-toolbar"
    >
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
      <SelectionAction
        disabled={unlockedCount < 3}
        label={t('board.selectionToolbar.distributeHorizontal')}
        onClick={() => controller.distributeSelection('horizontal')}
        testId="whiteboard-distribute-horizontal"
      >
        <AlignHorizontalSpaceBetween className="size-4" />
      </SelectionAction>
      <SelectionAction
        disabled={unlockedCount < 3}
        label={t('board.selectionToolbar.distributeVertical')}
        onClick={() => controller.distributeSelection('vertical')}
        testId="whiteboard-distribute-vertical"
      >
        <AlignVerticalSpaceBetween className="size-4" />
      </SelectionAction>
      <span className="whiteboard-toolbar-separator" aria-hidden="true" />
      <SelectionAction
        disabled={unlockedCount < 2}
        label={t('board.selectionToolbar.group')}
        onClick={() => controller.groupSelection('group')}
        testId="whiteboard-group-selection"
      >
        <Group className="size-4" />
      </SelectionAction>
      <SelectionAction
        label={t('board.selectionToolbar.frame')}
        onClick={() => controller.groupSelection('frame')}
        testId="whiteboard-frame-selection"
      >
        <Frame className="size-4" />
      </SelectionAction>
      <SelectionAction
        disabled={!hasContainer}
        label={t('board.selectionToolbar.ungroup')}
        onClick={controller.ungroupSelection}
        testId="whiteboard-ungroup-selection"
      >
        <Ungroup className="size-4" />
      </SelectionAction>
    </div>
  )
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
