import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { WorkflowLauncherAgentCard } from './WorkflowLauncherAgentCard'
import { WorkflowLauncherTemplateCard } from './WorkflowLauncherTemplateCard'
import type { WorkflowTemplate } from '@/features/workflow/templates'

export interface WorkflowLauncherTemplateGridProps {
  templates: WorkflowTemplate[]
  busyTemplateId?: string
  onSelect: (template: WorkflowTemplate) => void
  onExploreMore: () => void
  onAgentClick: () => void
}

export function WorkflowLauncherTemplateGrid(props: WorkflowLauncherTemplateGridProps) {
  const { templates, busyTemplateId, onSelect, onExploreMore, onAgentClick } = props
  const showExplore = templates.length > 3
  const inline = templates.slice(0, 3)

  // Slots per §5.7:
  //   row 1 col 1-3: builtins[0], builtins[1], (Explore OR builtins[2])
  //   row 2 col 1-2 span: builtins[2] (only when Explore is shown), col 3: Agent
  return (
    <div className="mt-12 grid grid-cols-1 gap-4 animate-fade-in-up md:grid-cols-2 lg:grid-cols-3">
      {inline[0] ? (
        <WorkflowLauncherTemplateCard
          template={inline[0]}
          busy={busyTemplateId === inline[0].id}
          onSelect={onSelect}
        />
      ) : null}
      {inline[1] ? (
        <WorkflowLauncherTemplateCard
          template={inline[1]}
          busy={busyTemplateId === inline[1].id}
          onSelect={onSelect}
        />
      ) : null}
      {showExplore ? (
        <ExploreMoreCard onClick={onExploreMore} />
      ) : inline[2] ? (
        <WorkflowLauncherTemplateCard
          template={inline[2]}
          busy={busyTemplateId === inline[2].id}
          onSelect={onSelect}
        />
      ) : null}
      {showExplore && inline[2] ? (
        <div className="lg:col-span-2">
          <WorkflowLauncherTemplateCard
            template={inline[2]}
            busy={busyTemplateId === inline[2].id}
            onSelect={onSelect}
          />
        </div>
      ) : null}
      <WorkflowLauncherAgentCard onClick={onAgentClick} />
    </div>
  )
}

function ExploreMoreCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('workflow')
  return (
    <button
      type="button"
      data-testid="workflow-launcher-explore-more"
      onClick={onClick}
      className="relative flex flex-col items-stretch gap-1 overflow-hidden rounded-2xl border border-border bg-card p-4 text-left card-interactive hover:border-primary/30 hover:shadow-sm"
    >
      <span className="text-base font-semibold text-foreground">{t('launcher.templateGrid.exploreMore')}</span>
      <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
        {t('launcher.templateGrid.viewAll')} <ChevronRight className="size-3.5" />
      </span>
    </button>
  )
}
