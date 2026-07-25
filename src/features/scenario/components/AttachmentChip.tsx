import { FileText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { ScenarioDraftAttachment } from '@/features/scenario/types'

export interface AttachmentChipProps {
  attachment: ScenarioDraftAttachment
  onRemove: () => void
  className?: string
}

/**
 * Single attachment chip shown in the landing-page input. Renders the file
 * name plus a small thumbnail (image preview when `previewUrl` is set,
 * otherwise a generic file icon) and an `×` button that triggers removal.
 *
 * The chip is purely presentational — lifecycle (URL.revokeObjectURL,
 * list state) is the parent's responsibility.
 */
export function AttachmentChip({
  attachment,
  onRemove,
  className,
}: AttachmentChipProps) {
  const { t } = useTranslation('settings')
  const { file, previewUrl } = attachment
  return (
    <span
      data-scenario-chip=""
      data-testid="scenario-chip"
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-2 text-sm text-foreground shadow-soft',
        className,
      )}
    >
      <span
        data-scenario-chip-preview=""
        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted"
      >
        {previewUrl ? (
          <img
            data-testid="scenario-chip-thumb"
            src={previewUrl}
            alt={file.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <FileText
            data-testid="scenario-chip-fallback-icon"
            aria-hidden
            className="h-3.5 w-3.5 text-muted-foreground"
          />
        )}
      </span>
      <span
        data-scenario-chip-name=""
        className="max-w-[160px] truncate"
        title={file.name}
      >
        {file.name}
      </span>
      <button
        type="button"
        data-testid="scenario-chip-remove"
        aria-label={t('scenario.removeAttachment', { name: file.name })}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onRemove()
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}
