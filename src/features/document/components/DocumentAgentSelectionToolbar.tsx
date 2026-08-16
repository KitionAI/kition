import { Expand, Minimize2, Sparkles, WandSparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/registry/ui/button'
import type { DocumentAgentAction } from '@/features/document/lib/documentAgentActions'
import { cn } from '@/lib/utils'

type DocumentAgentSelectionToolbarProps = {
  onAction: (action: DocumentAgentAction) => void
}

export function DocumentAgentSelectionToolbar({
  onAction,
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
