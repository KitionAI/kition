import { Check, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardAgentPreviewState } from '../hooks/useWhiteboardAgentPatch'
import {
  getWhiteboardConnectorPath,
  getWhiteboardElementBounds,
  whiteboardPointsToPath,
} from '../lib/whiteboardGeometry'
import type { WhiteboardElement } from '../lib/whiteboardTypes'

export function WhiteboardAgentPreviewLayer({
  preview,
}: {
  preview: NonNullable<WhiteboardAgentPreviewState['preview']>
}) {
  return (
    <g
      aria-label="AI Board preview"
      data-testid="whiteboard-agent-preview-layer"
      pointerEvents="none"
    >
      {preview.deleted.map((element) => (
        <WhiteboardAgentDeletedElement key={`deleted:${element.id}`} element={element} />
      ))}
      {[...preview.updated, ...preview.added].map((element) => (
        <WhiteboardAgentPreviewElement key={`preview:${element.id}`} element={element} />
      ))}
    </g>
  )
}

export function WhiteboardAgentPreviewControls({
  onAccept,
  onCancel,
  onReject,
  state,
}: {
  onAccept: () => void
  onCancel: () => void
  onReject: () => void
  state: WhiteboardAgentPreviewState
}) {
  const { t } = useTranslation('workspace')
  if (state.status === 'idle') return null
  const count = (state.preview?.added.length || 0)
    + (state.preview?.updated.length || 0)
    + (state.preview?.deleted.length || 0)

  return (
    <section
      className="whiteboard-agent-preview-panel absolute right-4 top-4 z-30 rounded-xl border bg-background/95 p-3 backdrop-blur"
      aria-live="polite"
      data-testid="whiteboard-agent-preview-controls"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {state.status === 'streaming'
              ? t('board.agentPreview.generating')
              : state.status === 'error'
                ? t('board.agentPreview.invalid')
                : t('board.agentPreview.ready')}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={state.error || state.patch?.summary}>
            {state.error || state.patch?.summary || t('board.agentPreview.description', { count })}
          </p>
        </div>
      </div>
      {state.patch?.operations.length ? (
        <ol
          className="mt-3 max-h-32 space-y-1 overflow-y-auto border-t pt-2 text-xs text-muted-foreground"
          data-testid="whiteboard-agent-operation-list"
        >
          {state.patch.operations.map((operation, index) => (
            <li key={`${operation.op}:${index}`} className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-brand" />
              <span>{t(`board.agentPreview.operations.${operation.op}`)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        {state.status === 'streaming' ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
            onClick={onCancel}
            data-testid="whiteboard-agent-cancel"
          >
            <X className="size-3.5" />
            {t('board.agentPreview.cancel')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
              onClick={onReject}
              data-testid="whiteboard-agent-reject"
            >
              <X className="size-3.5" />
              {t('board.agentPreview.reject')}
            </button>
            {state.status === 'ready' ? (
              <button
                type="button"
                className="whiteboard-agent-accept inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground"
                onClick={onAccept}
                data-testid="whiteboard-agent-accept"
              >
                <Check className="size-3.5" />
                {t('board.agentPreview.accept')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

function WhiteboardAgentPreviewElement({ element }: { element: WhiteboardElement }) {
  const stroke = 'hsl(var(--brand))'
  switch (element.kind) {
    case 'rectangle':
      return (
        <g data-agent-element-id={element.id}>
          <rect
            x={element.x}
            y={element.y}
            width={element.width}
            height={element.height}
            rx={element.shapeStyle === 'sticky' ? 4 : 12}
            fill="hsl(var(--accent) / 0.72)"
            stroke={stroke}
            strokeWidth="2.5"
            strokeDasharray="7 4"
            vectorEffect="non-scaling-stroke"
          />
          {element.text ? (
            <text
              x={element.x + element.width / 2}
              y={element.y + element.height / 2}
              fill="hsl(var(--accent-foreground))"
              fontSize="15"
              fontWeight="600"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {truncatePreviewText(element.text)}
            </text>
          ) : null}
        </g>
      )
    case 'text':
      return (
        <text
          x={element.x}
          y={element.y}
          fill={stroke}
          fontSize={element.fontSize || 22}
          fontWeight="600"
          data-agent-element-id={element.id}
        >
          {element.text}
        </text>
      )
    case 'stroke':
      return (
        <path
          d={whiteboardPointsToPath(element.points)}
          fill="none"
          stroke={stroke}
          strokeWidth="3"
          strokeDasharray="7 4"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          data-agent-element-id={element.id}
        />
      )
    case 'connector':
      return (
        <path
          d={getWhiteboardConnectorPath(element)}
          fill="none"
          stroke={stroke}
          strokeWidth="2.5"
          strokeDasharray="7 4"
          vectorEffect="non-scaling-stroke"
          data-agent-element-id={element.id}
        />
      )
    case 'image':
      return (
        <rect
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          rx="8"
          fill="hsl(var(--accent) / 0.45)"
          stroke={stroke}
          strokeWidth="2.5"
          strokeDasharray="7 4"
          vectorEffect="non-scaling-stroke"
          data-agent-element-id={element.id}
        />
      )
  }
}

function WhiteboardAgentDeletedElement({ element }: { element: WhiteboardElement }) {
  const bounds = getWhiteboardElementBounds(element)
  return (
    <g data-agent-deleted-id={element.id} opacity="0.72">
      <rect
        {...bounds}
        rx="8"
        fill="hsl(var(--destructive-background) / 0.45)"
        stroke="hsl(var(--destructive))"
        strokeWidth="2"
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={bounds.x}
        y1={bounds.y}
        x2={bounds.x + bounds.width}
        y2={bounds.y + bounds.height}
        stroke="hsl(var(--destructive))"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}

function truncatePreviewText(value: string) {
  return value.length > 40 ? `${value.slice(0, 39)}…` : value
}
