import type { PointerEvent as ReactPointerEvent } from 'react'

import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'

import {
  getWhiteboardConnectorPath,
  getWhiteboardElementCenter,
  whiteboardPointsToPath,
} from '../lib/whiteboardGeometry'
import {
  getWhiteboardDashArray,
  getWhiteboardElementStyle,
  getWhiteboardStrokeWidth,
  resolveWhiteboardColor,
} from '../lib/whiteboardStyle'
import type {
  WhiteboardConnectorTerminals,
  WhiteboardElement,
  WhiteboardMindMapBranchAxis,
} from '../lib/whiteboardTypes'
import { WhiteboardShapeBody } from './WhiteboardShapeBody'

export function WhiteboardElementRenderer({
  arrowId,
  connectionTarget,
  dotId,
  element,
  hovered,
  interactive,
  mindMapBranchAxis,
  mindMapBranchTerminals,
  onDoubleClick,
  onHoverChange,
  onPointerDown,
  patternId,
  selectable,
  selected,
}: {
  arrowId: string
  connectionTarget: boolean
  dotId: string
  element: WhiteboardElement
  hovered: boolean
  interactive: boolean
  mindMapBranchAxis?: WhiteboardMindMapBranchAxis
  mindMapBranchTerminals?: WhiteboardConnectorTerminals
  onDoubleClick: () => void
  onHoverChange: (hovered: boolean) => void
  onPointerDown: (event: ReactPointerEvent<SVGElement>, elementId: string) => void
  patternId: string
  selectable: boolean
  selected: boolean
}) {
  const highlighted = selected || hovered || connectionTarget
  const center = getWhiteboardElementCenter(element)
  const transform = element.rotation
    ? `rotate(${element.rotation} ${center.x} ${center.y})`
    : undefined
  return (
    <g
      transform={transform}
      opacity={element.locked ? 0.82 : getWhiteboardElementStyle(element).opacity}
      onPointerDown={(event) => onPointerDown(event, element.id)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick()
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      data-element-id={element.id}
      data-element-kind={element.kind}
      data-connection-target={connectionTarget ? 'true' : 'false'}
      data-hovered={hovered ? 'true' : 'false'}
      data-locked={element.locked ? 'true' : 'false'}
      pointerEvents={interactive ? undefined : 'none'}
      style={{ cursor: selectable ? 'move' : element.locked ? 'not-allowed' : 'default' }}
    >
      <WhiteboardElementBody
        arrowId={arrowId}
        dotId={dotId}
        element={element}
        highlighted={highlighted}
        mindMapBranchAxis={mindMapBranchAxis}
        mindMapBranchTerminals={mindMapBranchTerminals}
        patternId={patternId}
      />
    </g>
  )
}

function WhiteboardElementBody({
  arrowId,
  dotId,
  element,
  highlighted,
  mindMapBranchAxis,
  mindMapBranchTerminals,
  patternId,
}: {
  arrowId: string
  dotId: string
  element: WhiteboardElement
  highlighted: boolean
  mindMapBranchAxis?: WhiteboardMindMapBranchAxis
  mindMapBranchTerminals?: WhiteboardConnectorTerminals
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
        >
          {element.text.split('\n').map((line, index) => (
            <tspan
              key={`${index}:${line}`}
              x={element.x}
              dy={index === 0 ? 0 : (element.fontSize ?? 22) * 1.25}
            >
              {line || ' '}
            </tspan>
          ))}
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
          <path
            d={getWhiteboardConnectorPath(element, mindMapBranchAxis, mindMapBranchTerminals)}
            fill="none"
            stroke="transparent"
            strokeWidth="14"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={getWhiteboardConnectorPath(element, mindMapBranchAxis, mindMapBranchTerminals)}
            fill="none"
            stroke={stroke}
            strokeDasharray={dashArray}
            strokeWidth={highlighted ? Math.max(3, strokeWidth) : strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            markerStart={resolveArrowheadMarker(element.startArrowhead || 'none', arrowId, dotId)}
            markerEnd={resolveArrowheadMarker(element.endArrowhead || 'arrow', arrowId, dotId)}
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

function resolveArrowheadMarker(
  arrowhead: 'none' | 'arrow' | 'dot',
  arrowId: string,
  dotId: string,
) {
  if (arrowhead === 'arrow') return `url(#${arrowId})`
  if (arrowhead === 'dot') return `url(#${dotId})`
  return undefined
}
