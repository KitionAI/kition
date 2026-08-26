import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { WHITEBOARD_PALETTE_SHAPE_TYPES } from '../lib/boardElementDefinitions'
import type { WhiteboardShapeType } from '../lib/whiteboardTypes'
import { cn } from '@/lib/utils'

import { WhiteboardShapeBody } from './WhiteboardShapeBody'

export const WHITEBOARD_SHAPE_TYPES = WHITEBOARD_PALETTE_SHAPE_TYPES

export function WhiteboardShapeIcon({
  shapeType,
}: {
  shapeType: WhiteboardShapeType
}) {
  const patternId = useId().replace(/:/g, '')
  return (
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
  )
}

export function WhiteboardShapePalette({
  onSelect,
  selected,
}: {
  onSelect: (shapeType: WhiteboardShapeType) => void
  selected: WhiteboardShapeType
}) {
  const { t } = useTranslation('workspace')
  return (
    <div
      className="whiteboard-shape-palette absolute right-0 mb-2 w-64 rounded-xl border bg-popover p-3 text-popover-foreground"
      role="menu"
      aria-label={t('board.shapePalette.label')}
      data-testid="whiteboard-shape-palette"
    >
      <div className="mb-2 text-xs font-semibold text-foreground">
        {t('board.shapePalette.label')}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {WHITEBOARD_SHAPE_TYPES.map((shapeType) => (
          <button
            key={shapeType}
            type="button"
            className={cn(
              'flex size-10 items-center justify-center justify-self-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
              selected === shapeType && 'bg-accent text-accent-foreground',
              shapeType === 'frame' && 'col-start-4',
            )}
            onClick={() => onSelect(shapeType)}
            role="menuitem"
            aria-label={t(`board.shapes.${shapeType}`)}
            title={t(`board.shapes.${shapeType}`)}
            data-testid={`whiteboard-shape-${shapeType}`}
          >
            <WhiteboardShapeIcon shapeType={shapeType} />
          </button>
        ))}
      </div>
    </div>
  )
}
