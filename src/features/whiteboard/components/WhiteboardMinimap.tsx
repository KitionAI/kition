import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardEditorController } from '../hooks/useWhiteboardEditor'
import {
  getWhiteboardContentBounds,
  getWhiteboardElementBounds,
} from '../lib/whiteboardGeometry'
import type { WhiteboardPoint } from '../lib/whiteboardTypes'

const MINIMAP_WIDTH = 180
const MINIMAP_HEIGHT = 120
const MINIMAP_PADDING = 40

export function WhiteboardMinimap({
  canvasSize,
  controller,
}: {
  canvasSize: WhiteboardPoint
  controller: WhiteboardEditorController
}) {
  const { t } = useTranslation('workspace')
  const visibleElements = controller.elements.filter((element) => (
    !controller.mindMapHiddenElementIds.has(element.id)
  ))
  const contentBounds = getWhiteboardContentBounds(visibleElements)
  if (!contentBounds) return null
  const viewBox = {
    x: contentBounds.x - MINIMAP_PADDING,
    y: contentBounds.y - MINIMAP_PADDING,
    width: Math.max(1, contentBounds.width + MINIMAP_PADDING * 2),
    height: Math.max(1, contentBounds.height + MINIMAP_PADDING * 2),
  }
  const viewportBounds = {
    x: controller.viewport.x,
    y: controller.viewport.y,
    width: canvasSize.x / controller.viewport.zoom,
    height: canvasSize.y / controller.viewport.zoom,
  }

  function centerFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const renderedWidth = rect.width
    const renderedHeight = rect.height
    const scale = Math.min(renderedWidth / viewBox.width, renderedHeight / viewBox.height)
    const offsetX = (renderedWidth - viewBox.width * scale) / 2
    const offsetY = (renderedHeight - viewBox.height * scale) / 2
    controller.centerViewportAt({
      x: viewBox.x + (event.clientX - rect.left - offsetX) / scale,
      y: viewBox.y + (event.clientY - rect.top - offsetY) / scale,
    }, canvasSize)
  }

  return (
    <div
      className="absolute bottom-4 left-4 z-20 overflow-hidden rounded-xl border bg-background/95 p-1.5 shadow-[var(--shadow-toolbar)] backdrop-blur"
      data-testid="whiteboard-minimap"
    >
      <svg
        className="block cursor-crosshair rounded-md bg-muted/40"
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        role="navigation"
        aria-label={t('board.minimap.label')}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          centerFromPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) centerFromPointer(event)
        }}
      >
        {visibleElements.map((element) => {
          const bounds = getWhiteboardElementBounds(element)
          const selected = controller.selectedElementIds.includes(element.id)
          const frame = element.kind === 'rectangle'
            && (element.shapeStyle === 'frame' || element.shapeType === 'frame')
          if (element.kind === 'rectangle' && element.shapeStyle === 'group') return null
          return (
            <rect
              key={element.id}
              x={bounds.x}
              y={bounds.y}
              width={Math.max(2, bounds.width)}
              height={Math.max(2, bounds.height)}
              rx={2}
              fill={frame ? 'none' : selected
                ? 'hsl(var(--brand) / 0.38)'
                : 'hsl(var(--muted-foreground) / 0.2)'}
              stroke={frame || selected
                ? 'hsl(var(--brand))'
                : 'hsl(var(--muted-foreground) / 0.34)'}
              strokeWidth={Math.max(1, viewBox.width / MINIMAP_WIDTH)}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )
        })}
        <rect
          {...viewportBounds}
          fill="hsl(var(--brand) / 0.06)"
          stroke="hsl(var(--brand))"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          data-testid="whiteboard-minimap-viewport"
        />
      </svg>
    </div>
  )
}
