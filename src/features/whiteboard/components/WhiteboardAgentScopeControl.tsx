import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WhiteboardAgentScope } from '../lib/whiteboardAgentContext'

export function WhiteboardAgentScopeControl({
  available,
  hasSelection,
  onChange,
  value,
}: {
  available: boolean
  hasSelection: boolean
  onChange: (scope: WhiteboardAgentScope) => void
  value: WhiteboardAgentScope
}) {
  const { t } = useTranslation('workspace')
  return (
    <div
      className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-lg border bg-background/95 px-2 py-1.5 shadow-[var(--shadow-toolbar)] backdrop-blur"
      data-testid="whiteboard-agent-scope"
      title={available ? t('board.agentScope.description') : t('board.agentScope.unavailable')}
    >
      <Sparkles className="size-4 text-brand" aria-hidden="true" />
      <label className="sr-only" htmlFor="whiteboard-agent-scope-select">
        {t('board.agentScope.label')}
      </label>
      <select
        id="whiteboard-agent-scope-select"
        className="h-7 rounded-md border-0 bg-transparent px-1 text-xs font-medium text-foreground outline-none disabled:text-muted-foreground"
        value={value}
        disabled={!available}
        onChange={(event) => onChange(event.target.value as WhiteboardAgentScope)}
      >
        <option value="selection" disabled={!hasSelection}>
          {t('board.agentScope.selection')}
        </option>
        <option value="viewport">{t('board.agentScope.viewport')}</option>
        <option value="board">{t('board.agentScope.board')}</option>
      </select>
    </div>
  )
}
