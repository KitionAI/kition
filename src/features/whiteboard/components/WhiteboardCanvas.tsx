import { useEffect, useId, useRef, useState } from 'react'
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import {
  getWhiteboardSelectionBounds,
  normalizeWhiteboardBounds,
  screenToWhiteboardPoint,
  whiteboardPointsToPath,
} from '../lib/whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardResizeHandle,
} from '../lib/whiteboardTypes'
import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import { WhiteboardAgentPreviewLayer } from './WhiteboardAgentPreview'
import { WhiteboardElementRenderer } from './WhiteboardElementRenderer'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'
import { WhiteboardTextEditor } from './WhiteboardTextEditor'
import type { WhiteboardAgentPreviewState } from '../hooks/useWhiteboardAgentPatch'
import { cn } from '@/lib/utils'

const RESIZE_HANDLES: Array<{
  handle: WhiteboardResizeHandle
  x: 0 | 0.5 | 1
  y: 0 | 0.5 | 1
  cursor: string
}> = [
  { handle: 'north-west', x: 0, y: 0, cursor: 'nwse-resize' },
  { handle: 'north', x: 0.5, y: 0, cursor: 'ns-resize' },
  { handle: 'north-east', x: 1, y: 0, cursor: 'nesw-resize' },
  { handle: 'east', x: 1, y: 0.5, cursor: 'ew-resize' },
  { handle: 'south-east', x: 1, y: 1, cursor: 'nwse-resize' },
  { handle: 'south', x: 0.5, y: 1, cursor: 'ns-resize' },
  { handle: 'south-west', x: 0, y: 1, cursor: 'nesw-resize' },
  { handle: 'west', x: 0, y: 0.5, cursor: 'ew-resize' },
]

const SELECTION_LONG_PRESS_MS = 220

type PendingSelectionPress = {
  activated: boolean
  duplicate: boolean
  elementId: string
  latestScreen: WhiteboardPoint
  latestWorld: WhiteboardPoint
  pointerId: number
  shiftKey: boolean
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
  const eraserActiveRef = useRef(false)
  const [hoveredElementId, setHoveredElementId] = useState('')
  const gridId = useId().replace(/:/g, '')
  const arrowId = useId().replace(/:/g, '')
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
  }, [])

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

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    clearSelectionPress()
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
      pending.shiftKey = event.shiftKey
      return
    }
    controller.movePointer({
      ...points,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    })
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const pending = selectionPressRef.current
    const { world } = eventPoints(event)
    const targetElementId = controller.tool === 'connector'
      ? document.elementFromPoint(event.clientX, event.clientY)
          ?.closest<SVGElement>('[data-element-id]')
          ?.dataset.elementId
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
    controller.selectElement(elementId, {
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    })
  }

  function handleSelectionPointerDown(event: ReactPointerEvent<SVGRectElement>) {
    if (controller.tool !== 'select' || controller.allSelectedLocked) return
    event.stopPropagation()
    const elementId = controller.selectedElementIds[0]
    if (!elementId) return
    const points = eventPoints(event)
    const pending: PendingSelectionPress = {
      activated: false,
      duplicate: event.altKey,
      elementId,
      latestScreen: points.screen,
      latestWorld: points.world,
      pointerId: event.pointerId,
      shiftKey: event.shiftKey,
      startWorld: points.world,
    }
    pending.timer = setTimeout(() => {
      if (selectionPressRef.current !== pending) return
      pending.activated = controller.beginElementPointer(
        pending.elementId,
        pending.startWorld,
        { duplicate: pending.duplicate },
      )
      if (!pending.activated) {
        clearSelectionPress()
        return
      }
      capturePointer(pending.pointerId)
      controller.movePointer({
        world: pending.latestWorld,
        screen: pending.latestScreen,
        shiftKey: pending.shiftKey,
      })
    }, SELECTION_LONG_PRESS_MS)
    selectionPressRef.current = pending
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

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault()
    const { screen } = eventPoints(event)
    controller.zoomBy(Math.exp(-event.deltaY * 0.0015), screen)
  }

  const transform = `translate(${-controller.viewport.x * controller.viewport.zoom} ${-controller.viewport.y * controller.viewport.zoom}) scale(${controller.viewport.zoom})`
  const editingElement = controller.editingText
    ? controller.elements.find((element) => element.id === controller.editingText?.elementId)
    : null
  const visibleElements = controller.getViewportElements(canvasSize)
  const interactionCursor = controller.interactionState === 'rotating'
    ? 'grabbing'
    : controller.interactionState === 'resizing' && controller.activeResizeHandle
      ? RESIZE_HANDLES.find((item) => item.handle === controller.activeResizeHandle)?.cursor
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
          <rect
            x="-50000"
            y="-50000"
            width="100000"
            height="100000"
            fill={`url(#${gridId})`}
          />
          {visibleElements.map((element) => (
            <WhiteboardElementRenderer
              key={element.id}
              element={element}
              arrowId={arrowId}
              patternId={fillPatternId}
              hovered={hoveredElementId === element.id}
              selected={controller.selectedElementIds.includes(element.id)}
              onHoverChange={(hovered) => {
                setHoveredElementId(hovered ? element.id : '')
                if (hovered && eraserActiveRef.current) {
                  controller.continueErase(element.id)
                }
              }}
              onPointerDown={handleElementPointerDown}
              onDoubleClick={() => controller.beginTextEdit(element)}
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
          {agentPreview ? (
            <WhiteboardAgentPreviewLayer preview={agentPreview} />
          ) : null}
          {controller.tool === 'select' && controller.selectedElements.length > 0 ? (
            <WhiteboardSelection
              allLocked={controller.allSelectedLocked}
              elements={controller.selectedElements}
              moving={controller.interactionState === 'translating'}
              onDoubleClick={() => {
                if (controller.selectedElements.length === 1) {
                  controller.beginTextEdit(controller.selectedElements[0])
                }
              }}
              onMovePointerDown={handleSelectionPointerDown}
              onResizePointerDown={handleResizePointerDown}
              onRotatePointerDown={handleRotatePointerDown}
              zoom={controller.viewport.zoom}
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
      style: draft.style,
    }
    const style = getWhiteboardElementStyle(element)
    const strokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
    return (
      <line
        x1={draft.start.x}
        y1={draft.start.y}
        x2={draft.current.x}
        y2={draft.current.y}
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

function WhiteboardSelection({
  allLocked,
  elements,
  moving,
  onDoubleClick,
  onMovePointerDown,
  onResizePointerDown,
  onRotatePointerDown,
  zoom,
}: {
  allLocked: boolean
  elements: readonly WhiteboardElement[]
  moving: boolean
  onDoubleClick: () => void
  onMovePointerDown: (event: ReactPointerEvent<SVGRectElement>) => void
  onResizePointerDown: (
    event: ReactPointerEvent<SVGCircleElement>,
    handle: WhiteboardResizeHandle,
  ) => void
  onRotatePointerDown: (event: ReactPointerEvent<SVGCircleElement>) => void
  zoom: number
}) {
  const bounds = getWhiteboardSelectionBounds(elements)
  if (!bounds) return null
  const padding = 6 / zoom
  const x = bounds.x - padding
  const y = bounds.y - padding
  const width = Math.max(1, bounds.width) + padding * 2
  const height = Math.max(1, bounds.height) + padding * 2
  const handleRadius = 5 / zoom
  const rotationOffset = 28 / zoom
  const centerX = x + width / 2

  return (
    <g data-testid="whiteboard-selection">
      {!allLocked ? (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={6 / zoom}
          fill="transparent"
          pointerEvents="all"
          style={{ cursor: moving ? 'move' : 'default' }}
          onDoubleClick={onDoubleClick}
          onPointerDown={onMovePointerDown}
          data-testid="whiteboard-selection-move-area"
        />
      ) : null}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6 / zoom}
        fill="none"
        stroke="hsl(var(--brand))"
        strokeWidth="1.5"
        strokeDasharray={allLocked ? '3 3' : undefined}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {!allLocked ? (
        <>
          <line
            x1={centerX}
            y1={y}
            x2={centerX}
            y2={y - rotationOffset}
            stroke="hsl(var(--brand))"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.72"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            data-testid="whiteboard-rotation-guide"
          />
          <circle
            cx={centerX}
            cy={y - rotationOffset}
            r={handleRadius}
            fill="hsl(var(--background))"
            stroke="hsl(var(--brand))"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: 'grab' }}
            onPointerDown={onRotatePointerDown}
            data-testid="whiteboard-rotate-handle"
          />
          {RESIZE_HANDLES.map((item) => (
            <circle
              key={item.handle}
              cx={x + width * item.x}
              cy={y + height * item.y}
              r={handleRadius}
              fill="hsl(var(--background))"
              stroke="hsl(var(--brand))"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: item.cursor }}
              onPointerDown={(event) => onResizePointerDown(event, item.handle)}
              data-testid={`whiteboard-resize-${item.handle}`}
            />
          ))}
        </>
      ) : null}
    </g>
  )
}
