import { ChevronRight, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface WorkflowLauncherAgentCardProps {
  onClick: () => void
}

export function WorkflowLauncherAgentCard({ onClick }: WorkflowLauncherAgentCardProps) {
  const { t } = useTranslation('workflow')
  return (
    <button
      type="button"
      data-testid="workflow-launcher-agent-card"
      onClick={onClick}
      title={t('launcher.agentCard.openAskAi')}
      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left card-interactive hover:border-primary/30 hover:shadow-sm"
    >
      <span className="grid size-9 place-items-center rounded-md bg-primary/15 text-primary">
        <FileText className="size-4" />
      </span>
      <span className="flex flex-1 items-center gap-1 text-sm font-medium text-primary">
        {t('launcher.agentCard.title')}
      </span>
      <ChevronRight className="size-4 text-primary" />
    </button>
  )
}
