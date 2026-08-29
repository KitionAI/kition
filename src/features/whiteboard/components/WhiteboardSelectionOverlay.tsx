import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import {
  getWhiteboardConnectionHandles,
  type WhiteboardConnectionHandleDirection,
} from '../lib/whiteboardConnectionHandles'
import { getWhiteboardSelectionBounds } from '../lib/whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardResizeHandle,
} from '../lib/whiteboardTypes'

export const WHITEBOARD_RESIZE_HANDLES: Array<{
  cursor: string
  handle: WhiteboardResizeHandle
  x: 0 | 0.5 | 1
  y: 0 | 0.5 | 1
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

const CONNECTION_HANDLE_GAP = 24
const CONNECTION_HANDLE_RADIUS = 3
const CONNECTION_HANDLE_HOVER_RADIUS = 6
const CONNECTION_HANDLE_HIT_RADIUS = 12

export function WhiteboardSelectionOverlay({
  allLocked,
  elements,
  moving,
  onConnectionHandlePointerDown,
  onConnectorTerminalPointerDown,
  onDoubleClick,
  onMovePointerDown,
  onResizePointerDown,
  onRotatePointerDown,
  showConnectionHandles,
  zoom,
}: {
  allLocked: boolean
  elements: readonly WhiteboardElement[]
  moving: boolean
  onConnectionHandlePointerDown: (
    event: ReactPointerEvent<SVGCircleElement>,
    elementId: string,
    direction: WhiteboardConnectionHandleDirection,
  ) => void
  onConnectorTerminalPointerDown: (
    event: ReactPointerEvent<SVGCircleElement>,
    connectorId: string,
    terminal: 'start' | 'end',
  ) => void
  onDoubleClick: () => void
  onMovePointerDown: (event: ReactPointerEvent<SVGRectElement>) => void
  onResizePointerDown: (
    event: ReactPointerEvent<SVGCircleElement>,
    handle: WhiteboardResizeHandle,
  ) => void
  onRotatePointerDown: (event: ReactPointerEvent<SVGCircleElement>) => void
  showConnectionHandles: boolean
  zoom: number
}) {
  const [hoveredConnectionHandle, setHoveredConnectionHandle] = useState<
    WhiteboardConnectionHandleDirection | null
  >(null)
  const bounds = getWhiteboardSelectionBounds(elements)
  if (!bounds) return null
  const padding = 6 / zoom
  const x = bounds.x - padding
  const y = bounds.y - padding
  const width = Math.max(1, bounds.width) + padding * 2
  const height = Math.max(1, bounds.height) + padding * 2
  const handleRadius = 5 / zoom
  const rotationOffset = 28 / zoom
  const rotationDelta = rotationOffset / Math.sqrt(2)
  const rotationStart = { x, y: y + height }
  const rotationHandle = {
    x: rotationStart.x - rotationDelta,
    y: rotationStart.y + rotationDelta,
  }
  const connector = elements.length === 1 && elements[0].kind === 'connector'
    ? elements[0]
    : null
  const connectionElement = showConnectionHandles && elements.length === 1
    ? elements[0]
    : null
  const connectionHandles = connectionElement
    ? getWhiteboardConnectionHandles({
        element: connectionElement,
        gap: CONNECTION_HANDLE_GAP / zoom,
      })
    : []

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
          onDoubleClick={(event) => {
            event.stopPropagation()
            onDoubleClick()
          }}
          onPointerDown={onMovePointerDown}
          data-testid="whiteboard-selection-move-area"
        />
      ) : null}
      {!allLocked && connector ? (
        <>
          {(['start', 'end'] as const).map((terminal) => (
            <circle
              key={terminal}
              cx={connector[terminal].x}
              cy={connector[terminal].y}
              r={handleRadius + 1 / zoom}
              fill="hsl(var(--background))"
              stroke="hsl(var(--brand))"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: 'crosshair' }}
              onPointerDown={(event) => onConnectorTerminalPointerDown(
                event,
                connector.id,
                terminal,
              )}
              data-testid={`whiteboard-connector-${terminal}-handle`}
            />
          ))}
        </>
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
      {!allLocked && !connector ? (
        <>
          <line
            x1={rotationStart.x}
            y1={rotationStart.y}
            x2={rotationHandle.x}
            y2={rotationHandle.y}
            stroke="hsl(var(--brand))"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.72"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            data-testid="whiteboard-rotation-guide"
          />
          <circle
            cx={rotationHandle.x}
            cy={rotationHandle.y}
            r={handleRadius}
            fill="hsl(var(--background))"
            stroke="hsl(var(--brand))"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: 'grab' }}
            onPointerDown={onRotatePointerDown}
            data-testid="whiteboard-rotate-handle"
          />
          {WHITEBOARD_RESIZE_HANDLES.map((item) => (
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
      {!allLocked ? connectionHandles.map((handle) => {
        const hovered = hoveredConnectionHandle === handle.direction
        return (
          <g
            key={handle.direction}
            onPointerEnter={() => setHoveredConnectionHandle(handle.direction)}
            onPointerLeave={() => setHoveredConnectionHandle((current) => (
              current === handle.direction ? null : current
            ))}
            style={{ cursor: 'crosshair' }}
          >
            <circle
              cx={handle.handlePoint.x}
              cy={handle.handlePoint.y}
              r={CONNECTION_HANDLE_HIT_RADIUS / zoom}
              fill="transparent"
              pointerEvents="all"
              onPointerDown={(event) => onConnectionHandlePointerDown(
                event,
                handle.anchor.targetElementId,
                handle.direction,
              )}
              data-testid={`whiteboard-connection-handle-${handle.direction}`}
            />
            <circle
              cx={handle.handlePoint.x}
              cy={handle.handlePoint.y}
              r={(hovered
                ? CONNECTION_HANDLE_HOVER_RADIUS
                : CONNECTION_HANDLE_RADIUS) / zoom}
              fill="hsl(var(--brand))"
              pointerEvents="none"
              data-testid={`whiteboard-connection-handle-${handle.direction}-dot`}
            />
          </g>
        )
      }) : null}
    </g>
  )
}
