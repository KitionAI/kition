import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  getWhiteboardMindMapControlLanes,
  type WhiteboardMindMapQuickControl,
} from '../lib/whiteboardMindMapControls'
import type { WhiteboardMindMapGraph } from '../lib/whiteboardMindMap'
import type {
  WhiteboardMindMapBranchSide,
  WhiteboardRectangleElement,
} from '../lib/whiteboardTypes'
import { getWhiteboardElementStyle, resolveWhiteboardColor } from '../lib/whiteboardStyle'

export function WhiteboardMindMapQuickControls({
  graph,
  node,
  onAddChild,
  onHoverChange,
  onToggleCollapsed,
  zoom,
}: {
  graph: WhiteboardMindMapGraph
  node: WhiteboardRectangleElement
  onAddChild: (side?: WhiteboardMindMapBranchSide) => void
  onHoverChange: (hovered: boolean) => void
  onToggleCollapsed: () => void
  zoom: number
}) {
  const { t } = useTranslation('workspace')
  const lanes = getWhiteboardMindMapControlLanes({ graph, node, zoom })
  const stroke = resolveWhiteboardColor(
    getWhiteboardElementStyle(node).strokeColor,
    'stroke',
  )
  const lineWidth = 2 / Math.max(0.1, zoom)

  return (
    <g
      data-testid="whiteboard-mind-map-quick-controls"
      data-mind-map-node-id={node.id}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      {lanes.map((lane) => {
        const finalControl = lane.controls[lane.controls.length - 1]
        return (
          <g key={lane.direction} data-mind-map-control-direction={lane.direction}>
            <rect
              {...lane.awarenessBounds}
              fill="transparent"
              pointerEvents="all"
              data-testid={`whiteboard-mind-map-awareness-${lane.direction}`}
            />
            <line
              x1={lane.edgePoint.x}
              y1={lane.edgePoint.y}
              x2={finalControl.center.x}
              y2={finalControl.center.y}
              stroke={stroke}
              strokeWidth={lineWidth}
              strokeLinecap="round"
              pointerEvents="none"
            />
            {lane.controls.map((control) => (
              <MindMapControlButton
                key={`${control.kind}:${control.direction}`}
                control={control}
                label={control.kind === 'add'
                  ? t('board.selectionToolbar.mindMap.addChild')
                  : control.kind === 'collapse'
                    ? t('board.selectionToolbar.mindMap.collapse')
                    : t('board.selectionToolbar.mindMap.expand', {
                        count: control.descendantCount,
                      })}
                onActivate={() => {
                  if (control.kind === 'add') {
                    onAddChild(control.direction === 'down' ? undefined : control.direction)
                  } else {
                    onToggleCollapsed()
                  }
                }}
                stroke={stroke}
                zoom={zoom}
              />
            ))}
          </g>
        )
      })}
    </g>
  )
}

function MindMapControlButton({
  control,
  label,
  onActivate,
  stroke,
  zoom,
}: {
  control: WhiteboardMindMapQuickControl
  label: string
  onActivate: () => void
  stroke: string
  zoom: number
}) {
  const scale = 1 / Math.max(0.1, zoom)
  const radius = 11 * scale
  const hitRadius = 17 * scale
  const markSize = 4.5 * scale
  const strokeWidth = 2 * scale

  function activate(event: ReactPointerEvent<SVGGElement>) {
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  }

  function activateFromKeyboard(event: ReactKeyboardEvent<SVGGElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  }

  return (
    <g
      className="group cursor-pointer outline-none"
      role="button"
      tabIndex={0}
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerUp={activate}
      onKeyDown={activateFromKeyboard}
      data-testid={`whiteboard-mind-map-${control.kind}`}
      data-mind-map-control-direction={control.direction}
    >
      <circle
        cx={control.center.x}
        cy={control.center.y}
        r={hitRadius}
        fill="transparent"
        pointerEvents="all"
      />
      <circle
        cx={control.center.x}
        cy={control.center.y}
        r={radius}
        fill={control.kind === 'collapse' ? 'hsl(var(--background))' : 'hsl(var(--muted-foreground) / 0.42)'}
        stroke={control.kind === 'collapse' ? stroke : 'transparent'}
        strokeWidth={strokeWidth}
        className={control.kind === 'collapse'
          ? 'transition-colors group-hover:fill-muted'
          : 'transition-colors group-hover:fill-brand'}
      />
      {control.kind === 'expand' ? (
        <text
          x={control.center.x}
          y={control.center.y}
          fill="white"
          fontSize={9.5 * scale}
          fontWeight="700"
          textAnchor="middle"
          dominantBaseline="central"
          pointerEvents="none"
        >
          {formatDescendantCount(control.descendantCount || 0)}
        </text>
      ) : (
        <g pointerEvents="none">
          <line
            x1={control.center.x - markSize}
            y1={control.center.y}
            x2={control.center.x + markSize}
            y2={control.center.y}
            stroke={control.kind === 'collapse' ? stroke : 'white'}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          {control.kind === 'add' ? (
            <line
              x1={control.center.x}
              y1={control.center.y - markSize}
              x2={control.center.x}
              y2={control.center.y + markSize}
              stroke="white"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
          ) : null}
        </g>
      )}
    </g>
  )
}

function formatDescendantCount(count: number) {
  return count > 99 ? '99+' : String(count)
}
