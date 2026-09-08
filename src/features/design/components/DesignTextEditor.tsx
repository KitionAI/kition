import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { DesignDocument } from '../lib/designTypes'
import type { DesignStore } from '../lib/designStore'
import { worldMatrix } from '../lib/designGeometry'
export function DesignTextEditor({
  document: doc,
  id,
  zoom,
  store,
  onClose,
}: {
  document: DesignDocument
  id: string
  zoom: number
  store: DesignStore
  onClose: () => void
}) {
  const { t } = useTranslation('design'),
    ref = useRef<HTMLTextAreaElement>(null),
    n = doc.nodes[id],
    original = useRef(n.text),
    composing = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
    return () => store.endCoalescing()
  }, [store])
  const close = () => {
    store.endCoalescing()
    onClose()
  }
  return (
    <textarea
      ref={ref}
      className="design-text-editor"
      aria-label={t('editText')}
      value={n.text}
      spellCheck={false}
      maxLength={50000}
      style={{
        width: n.width,
        height: n.height,
        transform: `scale(${zoom}) matrix(${worldMatrix(doc, id).join(',')})`,
        fontFamily: n.fontFamily,
        fontSize: n.fontSize,
        fontWeight: n.fontWeight,
        lineHeight: n.lineHeight,
        letterSpacing: n.letterSpacing,
        textAlign: n.textAlign,
        color: n.fill,
      }}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
      }}
      onChange={(event) =>
        store.execute(
          { type: 'patch', ids: [id], patch: { text: event.target.value } },
          `text:${id}`,
        )
      }
      onBlur={close}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (composing.current || event.nativeEvent.isComposing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          store.execute(
            { type: 'patch', ids: [id], patch: { text: original.current } },
            `text:${id}`,
          )
          close()
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          close()
        }
      }}
    />
  )
}
