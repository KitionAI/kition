import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardShapeType } from '../lib/whiteboardTypes'
import { cn } from '@/lib/utils'

import { WhiteboardShapeBody } from './WhiteboardShapeBody'

export const WHITEBOARD_SHAPE_TYPES: readonly WhiteboardShapeType[] = [
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'pill',
  'parallelogram',
  'star',
  'cloud',
  'heart',
  'check',
  'arrow-left',
  'arrow-right',
  'arrow-up',
  'arrow-down',
  'line',
  'frame',
]

export function WhiteboardShapePalette({
  onSelect,
  selected,
}: {
  onSelect: (shapeType: WhiteboardShapeType) => void
  selected: WhiteboardShapeType
}) {
  const { t } = useTranslation('workspace')
  const patternId = useId().replace(/:/g, '')
  return (
    <div
      className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-floating)]"
      role="menu"
      aria-label={t('board.shapePalette.label')}
      data-testid="whiteboard-shape-palette"
    >
      <div className="mb-2 text-xs font-semibold text-foreground">
        {t('board.shapePalette.label')}
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {WHITEBOARD_SHAPE_TYPES.map((shapeType) => (
          <button
            key={shapeType}
            type="button"
            className={cn(
              'flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
              selected === shapeType && 'bg-accent text-accent-foreground',
            )}
            onClick={() => onSelect(shapeType)}
            role="menuitem"
            aria-label={t(`board.shapes.${shapeType}`)}
            title={t(`board.shapes.${shapeType}`)}
            data-testid={`whiteboard-shape-${shapeType}`}
          >
            <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
              <WhiteboardShapeBody
                element={{
                  id: `palette:${shapeType}`,
                  kind: 'rectangle',
                  x: 4,
                  y: 5,
                  width: 24,
                  height: 22,
                  shapeType,
                  style: {
                    fillStyle: shapeType === 'frame' ? 'none' : 'solid',
                    fillColor: 'white',
                    strokeColor: 'gray',
                    strokeSize: 's',
                  },
                }}
                patternId={patternId}
              />
            </svg>
          </button>
        ))}
      </div>
    </div>
  )
}
