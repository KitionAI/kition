import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Maximize2 } from 'lucide-react'
import type { DataAttachment } from '@/types/dataDocument'
import { resolvePublicFileURL } from '@/services/desktop'
import { findImageLikeString } from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'

const MAX_VISIBLE_THUMBS = 3

export function AttachmentCell({
  attachments,
  onPreview,
  className,
}: {
  attachments: DataAttachment[]
  onPreview: (index: number) => void
  className?: string
}) {
  const { t } = useTranslation('table')
  const [hover, setHover] = useState(false)
  if (!attachments.length) {
    return null
  }

  const visible = attachments.slice(0, MAX_VISIBLE_THUMBS)
  const overflow = attachments.length - visible.length

  return (
    <span
      className={cn('data-inline-attachment-cell-compact', className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="data-inline-attachment-cell-compact-row">
        {visible.map((attachment, index) => {
          const imageSrc = findImageLikeString(attachment)
          return (
            <button
              key={`${attachment.url}-${index}`}
              type="button"
              className="data-inline-attachment-cell-compact-thumb"
              data-testid="attachment-thumb"
              title={attachment.name || t('attachment.preview')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onPreview(index)
              }}
            >
              {imageSrc ? (
                <img
                  src={resolvePublicFileURL(imageSrc)}
                  alt={attachment.name || t('attachment.imageAlt')}
                  loading="lazy"
                />
              ) : (
                <FileText className="size-3.5" aria-hidden />
              )}
            </button>
          )
        })}
        {overflow > 0 ? (
          <span
            className="data-inline-attachment-cell-compact-overflow"
            data-testid="attachment-overflow"
            aria-label={t('attachment.moreCount', { count: overflow })}
          >
            +{overflow}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className={cn(
          'data-inline-attachment-cell-compact-expand',
          hover && 'is-visible',
        )}
        data-testid="attachment-expand"
        title={t('attachment.expandPreview')}
        aria-label={t('attachment.expandPreview')}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onPreview(0)
        }}
      >
        <Maximize2 className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}
