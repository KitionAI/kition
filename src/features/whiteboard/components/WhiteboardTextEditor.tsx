import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { whiteboardToScreenPoint } from '../lib/whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardTextEditingState,
  WhiteboardViewport,
} from '../lib/whiteboardTypes'

export function WhiteboardTextEditor({
  editingText,
  element,
  onCancel,
  onChange,
  onCommit,
  viewport,
}: {
  editingText: WhiteboardTextEditingState
  element?: WhiteboardElement
  onCancel: () => void
  onChange: (value: string) => void
  onCommit: () => void
  viewport: WhiteboardViewport
}) {
  const { t } = useTranslation('workspace')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const skipBlurRef = useRef(false)
  const screenPoint = whiteboardToScreenPoint(editingText, viewport)
  const isShapeEditor = editingText.elementKind === 'rectangle' && element?.kind === 'rectangle'
  const fontSize = Math.min(
    48,
    Math.max(
      14,
      (element?.kind === 'text' ? element.fontSize ?? 22 : 22) * viewport.zoom,
    ),
  )
  const width = isShapeEditor
    ? Math.max(72, Math.min(480, Math.max(0, element.width - 24) * viewport.zoom))
    : Math.min(360, Math.max(180, 220 * viewport.zoom))
  const rotation = element?.rotation ?? 0

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    skipBlurRef.current = false
  }, [editingText.elementId])

  return (
    <textarea
      ref={inputRef}
      className="absolute z-10 resize-none overflow-hidden rounded-md border border-input bg-background/95 px-2 py-1 text-foreground shadow-[var(--shadow-toolbar)] outline-none ring-2 ring-ring"
      style={{
        left: screenPoint.x,
        top: screenPoint.y,
        width,
        minHeight: Math.max(34, fontSize * 1.55),
        fontSize,
        textAlign: isShapeEditor ? 'center' : 'left',
        transform: isShapeEditor
          ? `translate(-50%, -50%) rotate(${rotation}deg)`
          : `translateY(-80%) rotate(${rotation}deg)`,
        transformOrigin: isShapeEditor ? 'center' : 'left bottom',
      }}
      value={editingText.value}
      placeholder={t('board.textPlaceholder')}
      aria-label={t('board.textPlaceholder')}
      onChange={(event) => onChange(event.target.value)}
      rows={1}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => {
        if (skipBlurRef.current) {
          skipBlurRef.current = false
          return
        }
        onCommit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          skipBlurRef.current = true
          onCommit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          skipBlurRef.current = true
          onCancel()
        }
      }}
      data-anchor={isShapeEditor ? 'shape-center' : 'text-origin'}
      data-testid="whiteboard-text-editor"
    />
  )
}
