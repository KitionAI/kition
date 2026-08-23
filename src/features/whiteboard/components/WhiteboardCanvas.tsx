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
  whiteboardToScreenPoint,
} from '../lib/whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardResizeHandle,
} from '../lib/whiteboardTypes'
import { WhiteboardAgentPreviewLayer } from './WhiteboardAgentPreview'
import { WhiteboardElementRenderer } from './WhiteboardElementRenderer'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'
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
  shiftKey: boolean
  startWorld: WhiteboardPoint
  timer?: ReturnType<typeof setTimeout>
}

export function WhiteboardCanvas({
  agentPreview,
  controller,
  onSizeChange,
  title,
}: {
  agentPreview?: WhiteboardAgentPreviewState['preview']
  controller: WhiteboardEditorController
  onSizeChange: (size: WhiteboardPoint) => void
  title: string
}) {
  const { t } = useTranslation('workspace')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)
  const selectionPressRef = useRef<PendingSelectionPress | null>(null)
  const eraserActiveRef = useRef(false)
  const [hoveredElementId, setHoveredElementId] = useState('')
  const [movingSelection, setMovingSelection] = useState(false)
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

  useEffect(() => {
    if (!controller.editingText) return
    textInputRef.current?.focus()
    textInputRef.current?.select()
  }, [controller.editingText?.elementId])

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
    clearSelectionPress()
    if (eraserActiveRef.current) {
      eraserActiveRef.current = false
      controller.endErase()
    }
    if (pending?.activated) controller.endPointer(world)
    else if (!pending) controller.endPointer(world)
    setMovingSelection(false)
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
    setMovingSelection(false)
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
    capturePointer(event.pointerId)
    const pending: PendingSelectionPress = {
      activated: false,
      duplicate: event.altKey,
      elementId,
      latestScreen: points.screen,
      latestWorld: points.world,
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
      setMovingSelection(true)
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
  const editingScreenPoint = controller.editingText
    ? whiteboardToScreenPoint(controller.editingText, controller.viewport)
    : null
  const editingElement = controller.editingText
    ? controller.elements.find((element) => element.id === controller.editingText?.elementId)
    : null

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-background">
      <svg
        ref={svgRef}
        className={cn(
          'h-full w-full touch-none bg-background outline-none',
          controller.tool === 'hand' && 'cursor-grab active:cursor-grabbing',
          controller.tool === 'select' && (movingSelection ? 'cursor-move' : 'cursor-default'),
          controller.tool !== 'hand' && controller.tool !== 'select' && 'cursor-crosshair',
        )}
        role="application"
        aria-label={t('board.canvasTitle', { title })}
        data-testid="whiteboard-svg-scene"
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
          {controller.elements.map((element) => (
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
          {agentPreview ? (
            <WhiteboardAgentPreviewLayer preview={agentPreview} />
          ) : null}
          {controller.tool === 'select' && controller.selectedElements.length > 0 ? (
            <WhiteboardSelection
              allLocked={controller.allSelectedLocked}
              elements={controller.selectedElements}
              moving={movingSelection}
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
      {controller.editingText && editingScreenPoint ? (
        <input
          ref={textInputRef}
          className="absolute z-10 rounded-md border border-input bg-background px-2 py-1 text-foreground shadow-[var(--shadow-toolbar)] outline-none ring-2 ring-ring"
          style={{
            left: editingScreenPoint.x,
            top: editingScreenPoint.y,
            width: Math.min(360, Math.max(180, 220 * controller.viewport.zoom)),
            fontSize: Math.min(
              48,
              Math.max(
                14,
                (editingElement?.kind === 'text' ? editingElement.fontSize ?? 22 : 22)
                  * controller.viewport.zoom,
              ),
            ),
            transform: `translateY(-80%) rotate(${editingElement?.rotation ?? 0}deg)`,
            transformOrigin: 'left bottom',
          }}
          value={controller.editingText.value}
          placeholder={t('board.textPlaceholder')}
          aria-label={t('board.textPlaceholder')}
          onChange={(event) => controller.updateEditingText(event.target.value)}
          onBlur={controller.commitEditingText}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              controller.commitEditingText()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              controller.cancelEditingText()
            }
          }}
          data-testid="whiteboard-text-editor"
        />
      ) : null}
    </div>
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
    return (
      <line
        x1={draft.start.x}
        y1={draft.start.y}
        x2={draft.current.x}
        y2={draft.current.y}
        stroke="hsl(var(--brand))"
        strokeWidth="2"
        strokeDasharray="6 4"
        markerEnd={`url(#${arrowId})`}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
    )
  }
  return (
    <path
      d={whiteboardPointsToPath(draft.points)}
      fill="none"
      stroke="hsl(var(--brand))"
      strokeWidth="3"
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
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
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
