import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { DocumentImagePreviewRequest } from '@/features/document/editor/editor/extensions/image-widget-actions'

export function DocumentImagePreviewDialog({
  image,
  onClose,
}: {
  image: DocumentImagePreviewRequest | null
  onClose: () => void
}) {
  const { t } = useTranslation('document')

  useEffect(() => {
    if (!image) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [image, onClose])

  if (!image || typeof document === 'undefined') return null
  const name = image.alt.trim() || image.src.split('/').pop() || t('editor.image.fallbackName')

  return createPortal(
    <div
      className="document-image-preview-overlay"
      data-testid="document-image-preview-overlay"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="document-image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('editor.image.previewLabel', { name })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span title={name}>{name}</span>
          <button
            type="button"
            aria-label={t('editor.image.closePreview')}
            title={t('editor.image.closePreview')}
            data-testid="document-image-preview-close"
            onClick={onClose}
          >
            <X aria-hidden />
          </button>
        </header>
        <div className="document-image-preview-stage">
          <img src={image.src} alt={image.alt || name} draggable={false} />
        </div>
      </section>
    </div>,
    document.body,
  )
}
