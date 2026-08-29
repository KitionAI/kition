import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import {
  getWhiteboardConnectorPath,
  getWhiteboardSelectionBounds,
  normalizeWhiteboardBounds,
  screenToWhiteboardPoint,
  whiteboardPointsToPath,
} from '../lib/whiteboardGeometry'
import type {
  WhiteboardPoint,
  WhiteboardResizeHandle,
} from '../lib/whiteboardTypes'
import type { WhiteboardConnectionHandleDirection } from '../lib/whiteboardConnectionHandles'
import {
  getWhiteboardMindMapGraph,
  isWhiteboardMindMapNode,
} from '../lib/whiteboardMindMap'
import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import { WhiteboardAgentPreviewLayer } from './WhiteboardAgentPreview'
import { WhiteboardElementRenderer } from './WhiteboardElementRenderer'
import { WhiteboardMindMapQuickControls } from './WhiteboardMindMapQuickControls'
import {
  WHITEBOARD_RESIZE_HANDLES,
  WhiteboardSelectionOverlay,
} from './WhiteboardSelectionOverlay'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'
import { WhiteboardTextEditor } from './WhiteboardTextEditor'
import type { WhiteboardAgentPreviewState } from '../hooks/useWhiteboardAgentPatch'
import { cn } from '@/lib/utils'
import { ContextActionMenu } from '@/components/ContextActionMenu'

const SELECTION_LONG_PRESS_MS = 220
const SELECTION_DRAG_DISTANCE = 4

type PendingSelectionPress = {
  activated: boolean
  altKey: boolean
  duplicate: boolean
  elementId: string
  latestScreen: WhiteboardPoint
  latestWorld: WhiteboardPoint
  pointerId: number
  shiftKey: boolean
  startScreen: WhiteboardPoint
  startWorld: WhiteboardPoint
  timer?: ReturnType<typeof setTimeout>
}

export function WhiteboardCanvas({
  agentPreview,
  canvasSize,
  controller,
  onSizeChange,
  title,
}: {
  agentPreview?: WhiteboardAgentPreviewState['preview']
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
  onSizeChange: (size: WhiteboardPoint) => void
  title: string
}) {
  const { t } = useTranslation('workspace')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const selectionPressRef = useRef<PendingSelectionPress | null>(null)
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const eraserActiveRef = useRef(false)
  const [hoveredElementId, setHoveredElementId] = useState('')
  const [contextMenu, setContextMenu] = useState<WhiteboardPoint | null>(null)
  const gridId = useId().replace(/:/g, '')
  const arrowId = useId().replace(/:/g, '')
  const dotId = useId().replace(/:/g, '')
  const fillPatternId = useId().replace(/:/g, '')

  useEffect(() => {
    const node = svgRef.current
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      onSizeChange({ x: rect.width, y: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [onSizeChange])

  useEffect(() => () => {
    const pending = selectionPressRef.current
    if (pending) clearTimeout(pending.timer)
    if (hoverClearTimerRef.current) clearTimeout(hoverClearTimerRef.current)
  }, [])

  function updateElementHover(elementId: string, hovered: boolean) {
    if (hoverClearTimerRef.current) {
      clearTimeout(hoverClearTimerRef.current)
      hoverClearTimerRef.current = null
    }
    if (hovered) {
      setHoveredElementId(elementId)
      return
    }
    hoverClearTimerRef.current = setTimeout(() => {
      setHoveredElementId((current) => current === elementId ? '' : current)
      hoverClearTimerRef.current = null
    }, 90)
  }

  function eventPoints(event: { clientX: number; clientY: number }) {
    const rect = svgRef.current?.getBoundingClientRect()
    const screen = {
      x: event.clientX - (rect?.left || 0),
      y: event.clientY - (rect?.top || 0),
    }
    return {
      screen,
      world: screenToWhiteboardPoint(screen, controller.viewport),
    }
  }

  function capturePointer(pointerId: number) {
    svgRef.current?.setPointerCapture(pointerId)
  }

  function pointerTargetElementId(event: { clientX: number; clientY: number }) {
    return document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<SVGElement>('[data-element-id]')
      ?.dataset.elementId
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    setContextMenu(null)
    clearSelectionPress()
    if (controller.tool === 'text') {
      event.preventDefault()
      controller.beginCanvasPointer({
        ...eventPoints(event),
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
      })
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (controller.tool === 'eraser') {
      eraserActiveRef.current = controller.beginErase()
      return
    }
    controller.beginCanvasPointer({
      ...eventPoints(event),
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    })
  }

  function handleContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    event.preventDefault()
    const target = event.target as Element
    const elementId = target
      .closest<SVGElement>('[data-element-id]')
      ?.dataset.elementId
    if (elementId && !controller.selectedElementIds.includes(elementId)) {
      controller.selectElement(elementId)
    } else if (!elementId && !target.closest('[data-testid="whiteboard-selection"]')) {
      controller.clearSelection()
    }
    setContextMenu({ x: event.clientX, y: event.clientY })
  }

  function handleDoubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (controller.tool !== 'select') return
    const target = event.target as Element
    if (
      target.closest('[data-element-id]')
      || target.closest('[data-testid="whiteboard-selection"]')
    ) return
    event.preventDefault()
    const { world } = eventPoints(event)
    const selectedBounds = getWhiteboardSelectionBounds(controller.selectedElements)
    if (
      controller.selectedElements.length === 1
      && selectedBounds
      && world.x >= selectedBounds.x
      && world.x <= selectedBounds.x + selectedBounds.width
      && world.y >= selectedBounds.y
      && world.y <= selectedBounds.y + selectedBounds.height
    ) {
      controller.beginTextEdit(controller.selectedElements[0])
      return
    }
    controller.beginCanvasTextEdit(world)
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const points = eventPoints(event)
    if (eraserActiveRef.current) {
      const hit = document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<SVGElement>('[data-element-id]')
      const elementId = hit?.dataset.elementId
      if (elementId) controller.continueErase(elementId)
      return
    }
    const pending = selectionPressRef.current
    if (pending && !pending.activated) {
      pending.latestScreen = points.screen
      pending.latestWorld = points.world
      pending.altKey = event.altKey
      pending.shiftKey = event.shiftKey
      if (Math.hypot(
        points.screen.x - pending.startScreen.x,
        points.screen.y - pending.startScreen.y,
      ) >= SELECTION_DRAG_DISTANCE) {
        activateSelectionPress(pending)
      }
      return
    }
    controller.movePointer({
      ...points,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      targetElementId: controller.interactionState === 'connecting'
        || controller.interactionState === 'editing-connector'
        ? pointerTargetElementId(event)
        : undefined,
    })
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const pending = selectionPressRef.current
    const { world } = eventPoints(event)
    const targetElementId = controller.tool === 'connector'
      || controller.interactionState === 'connecting'
      || controller.interactionState === 'editing-connector'
      ? pointerTargetElementId(event)
      : undefined
    clearSelectionPress()
    if (eraserActiveRef.current) {
      eraserActiveRef.current = false
      controller.endErase()
    }
    if (pending?.activated) controller.endPointer(world, targetElementId)
    else if (!pending) controller.endPointer(world, targetElementId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    const pending = selectionPressRef.current
    clearSelectionPress()
    if (eraserActiveRef.current) {
      eraserActiveRef.current = false
      controller.endErase()
    }
    if (!pending || pending.activated) controller.cancelInteraction()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleElementPointerDown(
    event: ReactPointerEvent<SVGElement>,
    elementId: string,
  ) {
    if (controller.tool === 'eraser') {
      event.stopPropagation()
      capturePointer(event.pointerId)
      eraserActiveRef.current = controller.beginErase(elementId)
      return
    }
    if (controller.tool === 'connector') {
      event.stopPropagation()
      capturePointer(event.pointerId)
      controller.beginCanvasPointer({
        ...eventPoints(event),
        targetElementId: elementId,
      })
      return
    }
    if (controller.tool !== 'select') return
    event.stopPropagation()
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const selected = controller.selectElement(elementId, { additive })
    if (!selected && additive) return
    beginSelectionPress(event, elementId)
  }

  function handleSelectionPointerDown(event: ReactPointerEvent<SVGRectElement>) {
    if (controller.tool !== 'select' || controller.allSelectedLocked) return
    event.stopPropagation()
    const elementId = controller.selectedElementIds[0]
    if (!elementId) return
    beginSelectionPress(event, elementId)
  }

  function beginSelectionPress(
    event: ReactPointerEvent<SVGElement>,
    elementId: string,
  ) {
    clearSelectionPress()
    const points = eventPoints(event)
    const pending: PendingSelectionPress = {
      activated: false,
      altKey: event.altKey,
      duplicate: event.altKey,
      elementId,
      latestScreen: points.screen,
      latestWorld: points.world,
      pointerId: event.pointerId,
      shiftKey: event.shiftKey,
      startScreen: points.screen,
      startWorld: points.world,
    }
    selectionPressRef.current = pending
    capturePointer(pending.pointerId)
    pending.timer = setTimeout(() => activateSelectionPress(pending), SELECTION_LONG_PRESS_MS)
  }

  function activateSelectionPress(pending: PendingSelectionPress) {
    if (selectionPressRef.current !== pending || pending.activated) return false
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = undefined
    pending.activated = controller.beginElementPointer(
      pending.elementId,
      pending.startWorld,
      {
        duplicate: pending.duplicate,
      },
    )
    if (!pending.activated) {
      clearSelectionPress()
      return false
    }
    controller.movePointer({
      world: pending.latestWorld,
      screen: pending.latestScreen,
      altKey: pending.altKey,
      shiftKey: pending.shiftKey,
    })
    return true
  }

  function clearSelectionPress() {
    const pending = selectionPressRef.current
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    selectionPressRef.current = null
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<SVGCircleElement>,
    handle: WhiteboardResizeHandle,
  ) {
    event.stopPropagation()
    if (controller.beginResizePointer(handle)) capturePointer(event.pointerId)
  }

  function handleRotatePointerDown(event: ReactPointerEvent<SVGCircleElement>) {
    event.stopPropagation()
    const { world } = eventPoints(event)
    if (controller.beginRotatePointer(world)) capturePointer(event.pointerId)
  }

  function handleConnectorTerminalPointerDown(
    event: ReactPointerEvent<SVGCircleElement>,
    connectorId: string,
    terminal: 'start' | 'end',
  ) {
    event.stopPropagation()
    if (controller.beginConnectorTerminalPointer(connectorId, terminal)) {
      capturePointer(event.pointerId)
    }
  }

  function handleConnectionHandlePointerDown(
    event: ReactPointerEvent<SVGCircleElement>,
    elementId: string,
    direction: WhiteboardConnectionHandleDirection,
  ) {
    event.preventDefault()
    event.stopPropagation()
    clearSelectionPress()
    if (controller.beginConnectionHandlePointer(elementId, direction)) {
      capturePointer(event.pointerId)
    }
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      const { screen } = eventPoints(event)
      controller.zoomBy(Math.exp(-event.deltaY * 0.0015), screen)
      return
    }
    controller.panBy({ x: event.deltaX, y: event.deltaY })
  }

  const transform = `translate(${-controller.viewport.x * controller.viewport.zoom} ${-controller.viewport.y * controller.viewport.zoom}) scale(${controller.viewport.zoom})`
  const editingElement = controller.editingText
    ? controller.elements.find((element) => element.id === controller.editingText?.elementId)
    : null
  const visibleElements = controller.getViewportElements(canvasSize)
  const mindMapBindings = useMemo(() => controller.records.filter((record) => (
    record.record_type === 'binding'
  )), [controller.records])
  const hoveredElement = controller.elements.find((element) => element.id === hoveredElementId)
  const hoveredMindMapNode = isWhiteboardMindMapNode(hoveredElement)
    ? hoveredElement
    : null
  const quickControlNode = hoveredMindMapNode || controller.selectedMindMapNode
  const quickControlGraph = useMemo(() => quickControlNode
    ? getWhiteboardMindMapGraph({
        bindings: mindMapBindings,
        elements: controller.elements,
        nodeId: quickControlNode.id,
      })
    : null, [controller.elements, mindMapBindings, quickControlNode])
  const showMindMapQuickControls = Boolean(
    quickControlNode
      && quickControlGraph
      && controller.tool === 'select'
      && controller.interactionState === 'idle'
      && !controller.editingText
      && !quickControlNode.locked,
  )
  const interactionCursor = controller.interactionState === 'rotating'
    ? 'grabbing'
    : controller.interactionState === 'resizing' && controller.activeResizeHandle
      ? WHITEBOARD_RESIZE_HANDLES.find((item) => (
          item.handle === controller.activeResizeHandle
        ))?.cursor
      : controller.interactionState === 'translating'
        ? 'move'
        : undefined

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-background">
      <svg
        ref={svgRef}
        className={cn(
          'whiteboard-canvas-surface h-full w-full bg-background outline-none',
          controller.tool === 'hand' && 'is-hand cursor-grab',
          controller.tool === 'select' && (
            controller.interactionState === 'translating' ? 'cursor-move' : 'cursor-default'
          ),
          controller.tool !== 'hand' && controller.tool !== 'select' && 'is-drawing',
        )}
        role="application"
        aria-label={t('board.canvasTitle', { title })}
        data-testid="whiteboard-svg-scene"
        data-rendered-element-count={visibleElements.length}
        style={{ cursor: interactionCursor }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      >
        <title>{t('board.canvasTitle', { title })}</title>
        <desc>{t('board.canvasDescription')}</desc>
        <defs>
          <pattern id={gridId} width="24" height="24" patternUnits="userSpaceOnUse">
            <circle
              cx="1"
              cy="1"
              r="1"
              fill="hsl(var(--muted-foreground) / 0.3)"
            />
          </pattern>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
          <marker
            id={dotId}
            viewBox="0 0 10 10"
            refX="5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <circle cx="5" cy="5" r="4" fill="context-stroke" />
          </marker>
          <pattern id={fillPatternId} width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="hsl(var(--background))" />
            <path
              d="M -2 8 L 8 -2 M 2 10 L 10 2"
              stroke="hsl(var(--muted-foreground) / 0.4)"
              strokeWidth="1.5"
            />
          </pattern>
        </defs>
        <g transform={transform}>
          {controller.gridVisible ? (
            <rect
              x="-50000"
              y="-50000"
              width="100000"
              height="100000"
              fill={`url(#${gridId})`}
              pointerEvents="none"
              data-testid="whiteboard-grid"
            />
          ) : null}
          {visibleElements.map((element) => (
            <WhiteboardElementRenderer
              key={element.id}
              element={element}
              arrowId={arrowId}
              dotId={dotId}
              patternId={fillPatternId}
              hovered={hoveredElementId === element.id}
              connectionTarget={controller.connectorTargetElementId === element.id}
              selected={controller.selectedElementIds.includes(element.id)}
              onHoverChange={(hovered) => {
                updateElementHover(element.id, hovered)
                if (hovered && eraserActiveRef.current) {
                  controller.continueErase(element.id)
                }
              }}
              onPointerDown={handleElementPointerDown}
              onDoubleClick={() => controller.beginTextEdit(element)}
              interactive={!controller.mindMapManagedConnectorIds.has(element.id)}
              selectable={controller.tool === 'select' && !element.locked}
            />
          ))}
          {controller.draft ? (
            <WhiteboardSvgDraft
              draft={controller.draft}
              arrowId={arrowId}
              patternId={fillPatternId}
            />
          ) : null}
          {controller.snapGuides.length > 0 ? (
            <WhiteboardSnapGuides guides={controller.snapGuides} />
          ) : null}
          {controller.connectorTerminalPreview ? (
            <path
              d={getWhiteboardConnectorPath(controller.connectorTerminalPreview)}
              fill="none"
              stroke="hsl(var(--brand))"
              strokeWidth="2"
              strokeDasharray="5 4"
              markerEnd={`url(#${arrowId})`}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
              data-testid="whiteboard-connector-terminal-preview"
            />
          ) : null}
          {agentPreview ? (
            <WhiteboardAgentPreviewLayer preview={agentPreview} />
          ) : null}
          {controller.tool === 'select' && controller.selectedElements.length > 0 ? (
            <WhiteboardSelectionOverlay
              allLocked={controller.allSelectedLocked}
              elements={controller.selectedElements}
              moving={controller.interactionState === 'translating'}
              onConnectionHandlePointerDown={handleConnectionHandlePointerDown}
              onDoubleClick={() => {
                if (controller.selectedElements.length === 1) {
                  controller.beginTextEdit(controller.selectedElements[0])
                }
              }}
              onMovePointerDown={handleSelectionPointerDown}
              onConnectorTerminalPointerDown={handleConnectorTerminalPointerDown}
              onResizePointerDown={handleResizePointerDown}
              onRotatePointerDown={handleRotatePointerDown}
              showConnectionHandles={controller.interactionState === 'idle'}
              zoom={controller.viewport.zoom}
            />
          ) : null}
          {showMindMapQuickControls && quickControlNode && quickControlGraph ? (
            <WhiteboardMindMapQuickControls
              graph={quickControlGraph}
              node={quickControlNode}
              zoom={controller.viewport.zoom}
              onAddChild={(side) => {
                controller.addMindMapChildAt(quickControlNode.id, '', side)
              }}
              onHoverChange={(hovered) => updateElementHover(quickControlNode.id, hovered)}
              onToggleCollapsed={() => {
                controller.toggleMindMapCollapsed(quickControlNode.id)
              }}
            />
          ) : null}
        </g>
      </svg>
      {controller.editingText ? (
        <WhiteboardTextEditor
          editingText={controller.editingText}
          element={editingElement}
          onCancel={controller.cancelEditingText}
          onChange={controller.updateEditingText}
          onCommit={controller.commitEditingText}
          viewport={controller.viewport}
        />
      ) : null}
      {contextMenu ? (
        <ContextActionMenu
          label={t('board.contextMenu.label')}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          testId="whiteboard-context-menu"
          items={[
            {
              id: 'copy',
              label: t('board.topActions.copy'),
              disabled: !controller.hasSelection,
              onSelect: () => controller.copySelection(),
            },
            {
              id: 'cut',
              label: t('board.topActions.cut'),
              disabled: !controller.hasUnlockedSelection,
              onSelect: () => controller.cutSelection(),
            },
            {
              id: 'paste',
              label: t('board.topActions.paste'),
              onSelect: () => void controller.pasteFromClipboard(),
            },
            {
              id: 'duplicate',
              label: t('board.topActions.duplicate'),
              disabled: !controller.hasUnlockedSelection,
              onSelect: () => controller.duplicateSelection(),
              separatorBefore: true,
            },
            {
              id: 'lock',
              label: t(controller.allSelectedLocked ? 'board.toolbar.unlock' : 'board.toolbar.lock'),
              disabled: !controller.hasSelection,
              onSelect: controller.toggleSelectionLock,
            },
            {
              id: 'front',
              label: t('board.topActions.bringToFront'),
              disabled: !controller.hasUnlockedSelection,
              onSelect: () => controller.reorderSelection('front'),
            },
            {
              id: 'back',
              label: t('board.topActions.sendToBack'),
              disabled: !controller.hasUnlockedSelection,
              onSelect: () => controller.reorderSelection('back'),
            },
            {
              id: 'delete',
              label: t('board.toolbar.delete'),
              disabled: !controller.hasUnlockedSelection,
              onSelect: controller.deleteSelection,
              separatorBefore: true,
            },
          ]}
        />
      ) : null}
    </div>
  )
}

function WhiteboardSnapGuides({
  guides,
}: {
  guides: WhiteboardEditorController['snapGuides']
}) {
  return (
    <g pointerEvents="none" aria-hidden="true">
      {guides.map((guide, index) => (
        <line
          key={`${guide.axis}:${guide.position}:${index}`}
          x1={guide.axis === 'x' ? guide.position : guide.start}
          y1={guide.axis === 'y' ? guide.position : guide.start}
          x2={guide.axis === 'x' ? guide.position : guide.end}
          y2={guide.axis === 'y' ? guide.position : guide.end}
          stroke="hsl(var(--brand))"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          data-testid="whiteboard-snap-guide"
        />
      ))}
    </g>
  )
}

function WhiteboardSvgDraft({
  draft,
  arrowId,
  patternId,
}: {
  draft: WhiteboardEditorController['draft']
  arrowId: string
  patternId: string
}) {
  if (!draft) return null
  if (draft.kind === 'selection') {
    const bounds = normalizeWhiteboardBounds(draft.start, draft.current)
    return (
      <rect
        {...bounds}
        rx={4}
        fill="hsl(var(--brand) / 0.08)"
        stroke="hsl(var(--brand))"
        strokeWidth="1.5"
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
        data-testid="whiteboard-brush-selection"
      />
    )
  }
  if (draft.kind === 'rectangle') {
    const bounds = normalizeWhiteboardBounds(draft.start, draft.current)
    return (
      <g pointerEvents="none" opacity="0.72" data-testid="whiteboard-shape-draft">
        <WhiteboardShapeBody
          element={{
            id: 'draft:shape',
            kind: 'rectangle',
            ...bounds,
            shapeStyle: draft.shapeStyle,
            shapeType: draft.shapeType,
            style: draft.style,
          }}
          highlighted
          patternId={patternId}
        />
      </g>
    )
  }
  if (draft.kind === 'connector') {
    const element = {
      id: 'draft:connector',
      kind: 'connector' as const,
      start: draft.start,
      end: draft.current,
      connectorType: draft.connectorType,
      style: draft.style,
    }
    const style = getWhiteboardElementStyle(element)
    const strokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
    return (
      <path
        d={getWhiteboardConnectorPath(element)}
        fill="none"
        opacity={style.opacity}
        stroke={resolveWhiteboardColor(style.strokeColor, 'stroke')}
        strokeWidth={strokeWidth}
        strokeDasharray={getWhiteboardDashArray(style.dashStyle, strokeWidth)}
        markerEnd={`url(#${arrowId})`}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
    )
  }
  const element = {
    id: 'draft:stroke',
    kind: 'stroke' as const,
    points: draft.points,
    style: draft.style,
  }
  const style = getWhiteboardElementStyle(element)
  const strokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
  return (
    <path
      d={whiteboardPointsToPath(draft.points)}
      fill="none"
      opacity={style.opacity}
      stroke={resolveWhiteboardColor(style.strokeColor, 'stroke')}
      strokeDasharray={getWhiteboardDashArray(style.dashStyle, strokeWidth)}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  )
}
