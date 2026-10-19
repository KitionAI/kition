import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { setAgentKitEditMode, useAgentKitEditMode } from '@/features/agent/lib/agentKitEditMode'
import { cn } from '@kition/app-ui/utils'

/** The composer's choice of how the agent edits kit documents: live, or as a draft to review. */
export function AgentKitEditModeToggle({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation('agent')
  const mode = useAgentKitEditMode()
  const draft = mode === 'draft'
  const hint = draft ? t('kitEditMode.draftHint') : t('kitEditMode.liveHint')
  return (
    <button
      type="button"
      className={cn('agent-ai-kit-edit-mode', draft && 'is-draft')}
      aria-pressed={draft}
      aria-label={`${t('kitEditMode.label')}: ${draft ? t('kitEditMode.draft') : t('kitEditMode.live')}`}
      title={hint}
      disabled={disabled}
      onClick={() => setAgentKitEditMode(draft ? 'live' : 'draft')}
      data-testid="agent-kit-edit-mode"
    >
      <GitBranch className="size-3.5" aria-hidden="true" />
      {draft ? t('kitEditMode.draft') : t('kitEditMode.live')}
    </button>
  )
}
