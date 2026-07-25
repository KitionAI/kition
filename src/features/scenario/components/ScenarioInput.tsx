import { ArrowUp, Paperclip, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { ScenarioDraftAttachment } from '@/features/scenario/types'

import { AttachmentChip } from './AttachmentChip'

export interface ScenarioInputProps {
  prompt: string
  onPromptChange: (value: string) => void
  attachments: ScenarioDraftAttachment[]
  onRemoveAttachment: (id: string) => void
  onPickAttachments: () => void
  onOpenSetup?: () => void
  onSubmit: () => void
  submitting?: boolean
  className?: string
}

/**
 * Landing-page composer. A 640px-wide rounded container that holds:
 *   - the chip row (only when there are attachments)
 *   - a textarea
 *   - a bottom toolbar with [📎 attachment, ⚙ setup] on the left and the
 *     "Start it" submit button on the right.
 *
 * Plain Enter is left as-is (textarea inserts a newline). ⌘/Ctrl+Enter
 * submits if and only if the form has content.
 */
export function ScenarioInput({
  prompt,
  onPromptChange,
  attachments,
  onRemoveAttachment,
  onPickAttachments,
  onOpenSetup,
  onSubmit,
  submitting,
  className,
}: ScenarioInputProps) {
  const { t } = useTranslation('settings')
  const hasContent = prompt.trim().length > 0 || attachments.length > 0
  const disabled = !hasContent || submitting === true

  function handleSubmit() {
    if (disabled) return
    onSubmit()
  }

  return (
    <div
      data-scenario-input=""
      className={cn(
        'flex w-[640px] max-w-full flex-col rounded-xl border border-border bg-card shadow-soft transition focus-within:border-foreground/40',
        className,
      )}
      style={{ minHeight: 130 }}
    >
      {attachments.length > 0 ? (
        <div
          data-scenario-input-chips=""
          className="flex flex-wrap gap-2 px-3 pt-3"
        >
          {attachments.map((att) => (
            <AttachmentChip
              key={att.id}
              attachment={att}
              onRemove={() => onRemoveAttachment(att.id)}
            />
          ))}
        </div>
      ) : null}

      <textarea
        data-testid="scenario-prompt-input"
        data-scenario-input-textarea=""
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            handleSubmit()
          }
        }}
        placeholder={t('scenario.promptPlaceholder')}
        rows={3}
        className="flex-1 resize-none bg-transparent px-3 py-3 text-base text-foreground outline-none placeholder:text-muted-foreground"
      />

      <div
        data-scenario-input-toolbar=""
        className="flex items-center justify-between px-3 pb-3 pt-1"
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="scenario-pick-attachments"
            aria-label={t('scenario.attachFiles')}
            onClick={onPickAttachments}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="scenario-open-setup"
            aria-label={t('scenario.buildSetup')}
            onClick={onOpenSetup}
            disabled={!onOpenSetup}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Settings className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button
          type="button"
          data-testid="scenario-start-button"
          aria-label={t('scenario.startIt')}
          disabled={disabled}
          onClick={handleSubmit}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium transition',
            disabled
              ? 'cursor-not-allowed bg-muted text-muted-foreground'
              : 'bg-foreground text-background hover:bg-foreground/90',
          )}
        >
          <span>{t('scenario.startIt')}</span>
          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
