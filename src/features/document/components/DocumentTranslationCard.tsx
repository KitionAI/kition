import { Check, ChevronDown, Copy, Languages, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ActionMenu, ActionMenuContent, ActionMenuItem, ActionMenuTrigger } from '@/components/ActionMenu'
import { Skeleton } from '@/components/states'
import type { DocumentTranslationState } from '@/features/document/hooks/useDocumentTranslation'
import {
  TRANSLATION_LANGUAGES,
  translationLanguageEndonym,
  type TranslationLanguage,
} from '@/features/document/lib/documentTranslation'
import { notify } from '@/lib/notify'
import { Button } from '@/registry/ui/button'

export type DocumentTranslationCardProps = {
  /** Tooltip element the editor created; the card renders into it. */
  container: HTMLElement | null
  state: DocumentTranslationState
  onClose: () => void
  onRetry: () => void
  onChangeTarget: (target: TranslationLanguage) => void
  onReplace: () => void
  onInsertBelow: () => void
  onCopy: () => Promise<boolean>
  onConfigureModel?: () => void
}

/**
 * The inline translation result under a selection: loading skeleton, the
 * translated text, and Replace / Insert below / Copy / Retry. Enter
 * replaces, Cmd/Ctrl+Enter inserts below, Esc closes.
 */
export function DocumentTranslationCard({
  container,
  state,
  onClose,
  onRetry,
  onChangeTarget,
  onReplace,
  onInsertBelow,
  onCopy,
  onConfigureModel,
}: DocumentTranslationCardProps) {
  const { t } = useTranslation('document')
  const replaceRef = useRef<HTMLButtonElement | null>(null)
  const ready = state.status === 'ready'

  // Move focus into the card once there is something to act on, so Enter replaces.
  useEffect(() => {
    if (ready) replaceRef.current?.focus()
  }, [ready])

  if (!container || state.status === 'closed') return null

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onInsertBelow()
    }
  }

  const handleCopy = () => {
    void onCopy().then((copied) => {
      if (copied) notify.success(t('editor.translate.copied'))
    })
  }

  return createPortal(
    <div
      className="document-translation-card w-[min(560px,calc(100vw-48px))] rounded-xl border bg-card p-3 text-sm shadow-[var(--shadow-toolbar)]"
      style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
      role="dialog"
      aria-label={t('editor.translate.cardLabel')}
      data-testid="document-translation-card"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <Languages className="size-4 text-muted-foreground" aria-hidden="true" />
        <ActionMenu>
          <ActionMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="gap-1 rounded-lg" data-testid="document-translation-target">
              {t('editor.translate.to', { language: translationLanguageEndonym(state.target) })}
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </Button>
          </ActionMenuTrigger>
          <ActionMenuContent align="start">
            {TRANSLATION_LANGUAGES.map((language) => (
              <ActionMenuItem key={language} onSelect={() => onChangeTarget(language)}>
                <span className="flex w-4 justify-center">
                  {language === state.target ? <Check className="size-3.5" aria-hidden="true" /> : null}
                </span>
                {translationLanguageEndonym(language)}
              </ActionMenuItem>
            ))}
          </ActionMenuContent>
        </ActionMenu>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="iconSm"
          className="rounded-lg"
          aria-label={t('editor.translate.close')}
          title={t('editor.translate.close')}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      {state.status === 'loading' ? (
        <div className="space-y-2 py-1" role="status" aria-label={t('editor.translate.loading')}>
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive" role="alert" data-testid="document-translation-error">
          {state.error === 'model'
            ? t('editor.translate.errors.model')
            : state.error === 'account'
              ? t('editor.translate.errors.account')
              : state.error === 'tooLong'
                ? t('editor.translate.errors.tooLong')
                : t('editor.translate.errors.failed')}
        </div>
      ) : null}

      {ready ? (
        <div
          className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 leading-relaxed text-foreground"
          data-testid="document-translation-result"
        >
          {state.result}
        </div>
      ) : null}

      {state.stale ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('editor.translate.stale')}</p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        {state.status === 'loading' ? (
          <Button type="button" variant="outline" size="md" className="rounded-lg" onClick={onClose}>
            {t('editor.translate.cancel')}
          </Button>
        ) : null}
        {state.status === 'error' && state.error === 'model' && onConfigureModel ? (
          <Button type="button" size="md" className="rounded-lg" onClick={onConfigureModel}>
            {t('editor.translate.configureModel')}
          </Button>
        ) : null}
        {ready ? (
          <>
            <Button
              ref={replaceRef}
              type="button"
              size="md"
              className="rounded-lg"
              disabled={state.stale}
              onClick={onReplace}
              data-testid="document-translation-replace"
            >
              {t('editor.translate.replace')}
            </Button>
            <Button type="button" variant="outline" size="md" className="rounded-lg" onClick={onInsertBelow} data-testid="document-translation-insert">
              {t('editor.translate.insertBelow')}
            </Button>
            <Button type="button" variant="ghost" size="md" className="gap-1.5 rounded-lg" onClick={handleCopy}>
              <Copy className="size-3.5" aria-hidden="true" />
              {t('editor.translate.copy')}
            </Button>
          </>
        ) : null}
        <div className="flex-1" />
        {state.status === 'ready' || (state.status === 'error' && state.error === 'failed') || state.stale ? (
          <Button
            type="button"
            variant="ghost"
            size="iconSm"
            className="rounded-lg"
            aria-label={t('editor.translate.retry')}
            title={t('editor.translate.retry')}
            onClick={onRetry}
          >
            <RotateCw className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>,
    container,
  )
}
