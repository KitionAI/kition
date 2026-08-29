import { useCallback, useEffect, useMemo, useState } from 'react'

import { WhiteboardAgentPreviewControls } from '@/features/whiteboard/components/WhiteboardAgentPreview'
import { WhiteboardAgentScopeControl } from '@/features/whiteboard/components/WhiteboardAgentScopeControl'
import { WhiteboardCanvas } from '@/features/whiteboard/components/WhiteboardCanvas'
import { WhiteboardSelectionToolbar } from '@/features/whiteboard/components/WhiteboardSelectionToolbar'
import { WhiteboardMinimap } from '@/features/whiteboard/components/WhiteboardMinimap'
import { WhiteboardToolbar } from '@/features/whiteboard/components/WhiteboardToolbar'
import { WhiteboardStylePanel } from '@/features/whiteboard/components/WhiteboardStylePanel'
import { WhiteboardTopActions } from '@/features/whiteboard/components/WhiteboardTopActions'
import { useWhiteboardAgentPatch } from '@/features/whiteboard/hooks/useWhiteboardAgentPatch'
import { useBoardDocument } from '@/features/whiteboard/hooks/useBoardDocument'
import { useWhiteboardEditor } from '@/features/whiteboard/hooks/useWhiteboardEditor'
import { buildWhiteboardAgentContext, type WhiteboardAgentScope } from '@/features/whiteboard/lib/whiteboardAgentContext'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import type { WhiteboardPoint } from '@/features/whiteboard/lib/whiteboardTypes'
import {
  cloneWhiteboardTestRecords,
  installWhiteboardTestBridge,
} from '@/features/whiteboard/testing/whiteboardTestBridge'
import { useTranslation } from 'react-i18next'

import './whiteboard.css'

export function WhiteboardEditorPane({
  agentAvailable = false,
  agentBusy = false,
  onAgentBridgeChange,
  onCancelAgent,
  onOpenAgent,
  path,
  title,
}: {
  agentAvailable?: boolean
  agentBusy?: boolean
  onAgentBridgeChange?: (path: string, bridge: WhiteboardAgentBridge | null) => void
  onCancelAgent?: () => void
  onOpenAgent?: () => void
  path: string
  title: string
}) {
  const { t } = useTranslation('workspace')
  const controller = useWhiteboardEditor()
  const agentPatch = useWhiteboardAgentPatch({
    commands: controller.commands,
    store: controller.store,
  })
  const documentState = useBoardDocument({
    path,
    title,
    isTransacting: controller.isTransacting,
    records: controller.records,
    viewport: controller.viewport,
    replaceDocument: controller.replaceDocument,
  })
  const [canvasSize, setCanvasSize] = useState<WhiteboardPoint>({ x: 1200, y: 760 })
  const [agentScope, setAgentScope] = useState<WhiteboardAgentScope>('viewport')
  const handleSizeChange = useCallback((size: WhiteboardPoint) => {
    setCanvasSize((current) => (
      current.x === size.x && current.y === size.y ? current : size
    ))
  }, [])

  useEffect(() => {
    if (agentScope === 'selection' && !controller.hasSelection) {
      setAgentScope('viewport')
    }
  }, [agentScope, controller.hasSelection])

  const agentBridge = useMemo<WhiteboardAgentBridge>(() => ({
    available: agentAvailable,
    buildContext: () => agentAvailable
      ? buildWhiteboardAgentContext({
          activeStyle: controller.activeStyle,
          canvasSize,
          path,
          scope: agentScope,
          selectedElementIds: controller.selectedElementIds,
          store: controller.store,
          title,
          tool: controller.tool,
          viewport: controller.viewport,
        }) || undefined
      : undefined,
    cancelPreview: agentPatch.cancel,
    receivePatch: (patch, provisional) => {
      if (agentAvailable) agentPatch.receivePatch(patch, provisional)
    },
  }), [
    agentAvailable,
    agentPatch.cancel,
    agentPatch.receivePatch,
    agentScope,
    controller.activeStyle,
    canvasSize,
    controller.selectedElementIds,
    controller.store,
    controller.tool,
    controller.viewport,
    path,
    title,
  ])

  useEffect(() => {
    onAgentBridgeChange?.(path, agentBridge)
    return () => onAgentBridgeChange?.(path, null)
  }, [agentBridge, onAgentBridgeChange, path])

  useEffect(() => installWhiteboardTestBridge(() => ({
    activeStyle: { ...controller.activeStyle },
    canRedo: controller.canRedo,
    canUndo: controller.canUndo,
    currentPageId: controller.currentPageId,
    interactionState: controller.interactionState,
    path,
    records: cloneWhiteboardTestRecords(controller.records),
    selectedElementIds: [...controller.selectedElementIds],
    shapeType: controller.shapeType,
    tool: controller.tool,
    viewport: { ...controller.viewport },
  })), [
    controller.activeStyle,
    controller.canRedo,
    controller.canUndo,
    controller.currentPageId,
    controller.interactionState,
    controller.records,
    controller.selectedElementIds,
    controller.shapeType,
    controller.tool,
    controller.viewport,
    path,
  ])

  const cancelAgentPreview = useCallback(() => {
    agentPatch.cancel()
    if (agentBusy) onCancelAgent?.()
  }, [agentBusy, agentPatch, onCancelAgent])
  const askAgentAboutSelection = useCallback(() => {
    setAgentScope('selection')
    onOpenAgent?.()
  }, [onOpenAgent])

  return (
    <div
      className="relative h-full min-h-0 w-full bg-background"
      data-testid="whiteboard-editor-pane"
      data-board-path={path}
    >
      <WhiteboardCanvas
        agentPreview={agentPatch.state.preview}
        canvasSize={canvasSize}
        controller={controller}
        onSizeChange={handleSizeChange}
        title={title}
      />
      <WhiteboardTopActions
        canvasSize={canvasSize}
        controller={controller}
        title={title}
      />
      <WhiteboardToolbar controller={controller} canvasSize={canvasSize} />
      <WhiteboardSelectionToolbar
        agentAvailable={agentAvailable}
        controller={controller}
        onAskAgent={askAgentAboutSelection}
      />
      <WhiteboardMinimap canvasSize={canvasSize} controller={controller} />
      <WhiteboardStylePanel controller={controller} />
      <WhiteboardAgentScopeControl
        available={agentAvailable}
        hasSelection={controller.hasSelection}
        onChange={setAgentScope}
        value={agentScope}
      />
      <WhiteboardAgentPreviewControls
        state={agentPatch.state}
        onAccept={() => void agentPatch.accept()}
        onCancel={cancelAgentPreview}
        onReject={agentPatch.reject}
      />
      <div
        className="absolute bottom-4 right-4 z-20 rounded-md border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-[var(--shadow-toolbar)] backdrop-blur"
        role={documentState.status === 'error' ? 'alert' : 'status'}
        title={documentState.error || undefined}
        data-testid="board-save-status"
      >
        {t(`board.status.${documentState.status}`)}
      </div>
    </div>
  )
}
