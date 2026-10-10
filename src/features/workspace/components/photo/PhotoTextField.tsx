import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Where new text goes: a document point and where it shows on the canvas. */
export type PhotoTextDraft = { x: number; y: number; left: number; top: number }

type PhotoTextFieldProps = {
  draft: PhotoTextDraft
  /** Font size in document pixels, and the zoom it shows at. */
  size: number
  zoom: number
  color: string
  onCommit: (text: string) => void
  onCancel: () => void
}

/** The Type tool's inline field, at the clicked baseline; Enter places the text, Escape drops it. */
export function PhotoTextField({ draft, size, zoom, color, onCommit, onCancel }: PhotoTextFieldProps) {
  const { t } = useTranslation('workspace')
  const [text, setText] = useState('')
  const shown = Math.max(10, size * zoom)
  const finish = () => {
    if (text.trim()) onCommit(text)
    else onCancel()
  }
  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus -- the person just clicked here to type
      autoFocus
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish()
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={finish}
      placeholder={t('photoKit.typePlaceholder')}
      aria-label={t('photoKit.tools.type')}
      className="absolute min-w-40 rounded-sm border border-dashed border-primary bg-transparent px-0.5 leading-none outline-none placeholder:text-muted-foreground/70"
      style={{ left: draft.left, top: draft.top - shown, fontSize: shown, color }}
      data-testid="photo-text-field"
    />
  )
}
