import { Check, ChevronDown, Expand, Languages, Minimize2, Sparkles, WandSparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuLabel,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from '@/components/ActionMenu'
import { Button } from '@/registry/ui/button'
import type { DocumentAgentAction } from '@/features/document/lib/documentAgentActions'
import {
  TRANSLATION_LANGUAGES,
  translationLanguageEndonym,
  type TranslationLanguage,
} from '@/features/document/lib/documentTranslation'
import { cn } from '@/lib/utils'

type DocumentAgentSelectionToolbarProps = {
  onAction: (action: DocumentAgentAction) => void
  /** Present when translation is available; the toolbar hides Translate otherwise. */
  translation?: {
    /** Where the main Translate button goes for the current selection. */
    target: TranslationLanguage
    /** The user's saved default, or null when it follows the app language. */
    defaultTarget: TranslationLanguage | null
    onTranslate: (target: TranslationLanguage) => void
    onSetDefault: (target: TranslationLanguage) => void
  }
}

export function DocumentAgentSelectionToolbar({
  onAction,
  translation,
}: DocumentAgentSelectionToolbarProps) {
  const { t } = useTranslation('document')

  return (
    <div
      className="document-ai-selection-toolbar absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-card/95 p-1 shadow-[var(--shadow-toolbar)] backdrop-blur"
      role="toolbar"
      aria-label={t('editor.askAi.selectionToolbar')}
      style={{ borderColor: 'var(--document-border, hsl(var(--border)))' }}
    >
      <SelectionAgentButton
        label={t('editor.askAi.custom')}
        icon={<Sparkles />}
        onClick={() => onAction('custom')}
        primary
      />
      <SelectionAgentButton
        label={t('editor.askAi.improve')}
        icon={<WandSparkles />}
        onClick={() => onAction('improve')}
      />
      <SelectionAgentButton
        label={t('editor.askAi.shorten')}
        icon={<Minimize2 />}
        onClick={() => onAction('shorten')}
      />
      <SelectionAgentButton
        label={t('editor.askAi.expand')}
        icon={<Expand />}
        onClick={() => onAction('expand')}
      />
      {translation ? (
        <>
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
          <TranslateSplitButton {...translation} />
        </>
      ) : null}
    </div>
  )
}

function TranslateSplitButton({
  target,
  defaultTarget,
  onTranslate,
  onSetDefault,
}: NonNullable<DocumentAgentSelectionToolbarProps['translation']>) {
  const { t } = useTranslation('document')
  const [makeDefault, setMakeDefault] = useState(false)
  const label = t('editor.translate.button')
  const tooltip = t('editor.translate.to', { language: translationLanguageEndonym(target) })
  return (
    <div className="flex items-center">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        title={tooltip}
        aria-label={tooltip}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onTranslate(target)}
        className="h-8 gap-1.5 rounded-md rounded-r-none px-2.5 text-xs"
        data-testid="document-translate-button"
      >
        <span className="[&_svg]:size-3.5"><Languages /></span>
        <span>{label}</span>
      </Button>
      <ActionMenu onOpenChange={(open) => { if (open) setMakeDefault(false) }}>
        <ActionMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t('editor.translate.chooseLanguage')}
            title={t('editor.translate.chooseLanguage')}
            onMouseDown={(event) => event.preventDefault()}
            className="h-8 rounded-md rounded-l-none px-1"
            data-testid="document-translate-menu"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </ActionMenuTrigger>
        <ActionMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
          <ActionMenuLabel>{t('editor.translate.translateTo')}</ActionMenuLabel>
          {TRANSLATION_LANGUAGES.map((language) => (
            <ActionMenuItem
              key={language}
              onSelect={() => {
                if (makeDefault) onSetDefault(language)
                onTranslate(language)
              }}
            >
              <span className="flex w-4 justify-center">
                {language === (defaultTarget ?? target) ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
              <span className="flex-1">{translationLanguageEndonym(language)}</span>
              {language === defaultTarget ? (
                <span className="text-xs text-muted-foreground">{t('editor.translate.defaultBadge')}</span>
              ) : null}
            </ActionMenuItem>
          ))}
          <ActionMenuSeparator />
          <ActionMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setMakeDefault((value) => !value)
            }}
            data-testid="document-translate-make-default"
          >
            <span className="flex w-4 justify-center">
              {makeDefault ? <Check className="size-3.5" aria-hidden="true" /> : null}
            </span>
            {t('editor.translate.alwaysUse')}
          </ActionMenuItem>
        </ActionMenuContent>
      </ActionMenu>
    </div>
  )
}

function SelectionAgentButton({
  label,
  icon,
  onClick,
  primary = false,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  primary?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'h-8 gap-1.5 rounded-md px-2.5 text-xs',
        primary && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      <span>{label}</span>
    </Button>
  )
}
