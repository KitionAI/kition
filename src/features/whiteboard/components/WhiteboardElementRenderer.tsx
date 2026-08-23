import type { PointerEvent as ReactPointerEvent } from 'react'

import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

import {
  getWhiteboardElementCenter,
  whiteboardPointsToPath,
} from '../lib/whiteboardGeometry'
import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import type { WhiteboardElement } from '../lib/whiteboardTypes'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'

export function WhiteboardElementRenderer({
  arrowId,
  element,
  hovered,
  onDoubleClick,
  onHoverChange,
  onPointerDown,
  patternId,
  selected,
}: {
  arrowId: string
  element: WhiteboardElement
  hovered: boolean
  onDoubleClick: () => void
  onHoverChange: (hovered: boolean) => void
  onPointerDown: (event: ReactPointerEvent<SVGElement>, elementId: string) => void
  patternId: string
  selected: boolean
}) {
  const highlighted = selected || hovered
  const center = getWhiteboardElementCenter(element)
  const transform = element.rotation
    ? `rotate(${element.rotation} ${center.x} ${center.y})`
    : undefined
  return (
    <g
      transform={transform}
      opacity={element.locked ? 0.82 : getWhiteboardElementStyle(element).opacity}
      onPointerDown={(event) => onPointerDown(event, element.id)}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      data-element-id={element.id}
      data-element-kind={element.kind}
      data-hovered={hovered ? 'true' : 'false'}
      data-locked={element.locked ? 'true' : 'false'}
      style={{ cursor: 'default' }}
    >
      <WhiteboardElementBody
        arrowId={arrowId}
        element={element}
        highlighted={highlighted}
        onDoubleClick={onDoubleClick}
        patternId={patternId}
      />
    </g>
  )
}

function WhiteboardElementBody({
  arrowId,
  element,
  highlighted,
  onDoubleClick,
  patternId,
}: {
  arrowId: string
  element: WhiteboardElement
  highlighted: boolean
  onDoubleClick: () => void
  patternId: string
}) {
  const style = getWhiteboardElementStyle(element)
  const strokeWidth = getWhiteboardStrokeWidth(style.strokeSize)
  const stroke = highlighted
    ? 'hsl(var(--brand))'
    : resolveWhiteboardColor(style.strokeColor, 'stroke')
  const dashArray = getWhiteboardDashArray(style.dashStyle, strokeWidth)

  switch (element.kind) {
    case 'rectangle':
      return (
        <WhiteboardShapeBody
          element={element}
          highlighted={highlighted}
          onDoubleClick={onDoubleClick}
          patternId={patternId}
        />
      )
    case 'text':
      return (
        <text
          x={element.x}
          y={element.y}
          fill={stroke}
          fontSize={element.fontSize ?? 22}
          fontWeight="500"
          onDoubleClick={onDoubleClick}
        >
          {element.text}
        </text>
      )
    case 'stroke': {
      const path = whiteboardPointsToPath(element.points)
      return (
        <>
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth="14"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path}
            fill="none"
            stroke={stroke}
            strokeDasharray={dashArray}
            strokeWidth={highlighted ? Math.max(4, strokeWidth) : strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        </>
      )
    }
    case 'connector':
      return (
        <>
          <line
            x1={element.start.x}
            y1={element.start.y}
            x2={element.end.x}
            y2={element.end.y}
            stroke="transparent"
            strokeWidth="14"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={element.start.x}
            y1={element.start.y}
            x2={element.end.x}
            y2={element.end.y}
            stroke={stroke}
            strokeDasharray={dashArray}
            strokeWidth={highlighted ? Math.max(3, strokeWidth) : strokeWidth}
            markerEnd={`url(#${arrowId})`}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        </>
      )
    case 'image':
      return (
        <>
          <rect
            x={element.x}
            y={element.y}
            width={element.width}
            height={element.height}
            rx="8"
            fill="hsl(var(--surface-soft))"
            stroke={stroke}
            strokeDasharray={dashArray}
            strokeWidth={highlighted ? Math.max(3, strokeWidth) : strokeWidth}
            vectorEffect="non-scaling-stroke"
          />
          <image
            href={resolveWorkspaceFileURL(element.workspacePath)}
            x={element.x + 1}
            y={element.y + 1}
            width={Math.max(0, element.width - 2)}
            height={Math.max(0, element.height - 2)}
            preserveAspectRatio="xMidYMid meet"
            pointerEvents="none"
            aria-label={element.alt}
          />
        </>
      )
  }
}
