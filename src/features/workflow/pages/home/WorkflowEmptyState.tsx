import { FileText, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { WorkflowDefinition } from '@/api/workflows'
import { Button } from '@/components/ui'
import { WorkflowHomeLauncher } from '@/features/workflow/components/launcher/WorkflowHomeLauncher'
import type { useWorkflowLauncherState } from '@/features/workflow/hooks/useWorkflowLauncherState'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { openWorkflowRoute } from '@/features/workflow/lib/openWorkflowRoute'
import { triggerLabel, workflowStatus, type TableLabel } from '@/features/workflow/lib/workflowDraft'
import { FlowLine, StatusPill } from '@/features/workflow/pages/WorkflowHomePagePrimitives'

export type WorkflowEmptyStateProps = {
  scopedKitablePath?: string
  scopedKitableLabel: string
  scopedWorkflows: WorkflowDefinition[]
  latestRuns: Record<string, WorkflowRunRecord | null>
  tableLabels: Record<string, TableLabel>
  launcher: ReturnType<typeof useWorkflowLauncherState>
  onOpenModeDialog: () => void
  onSelect: (workflowId: string) => void
}

/**
 * What the page shows with no workflow open. Inside a .kitable with no
 * workflows: one create button, so templates bind under this kitable
 * through the mode dialog. Outside any scope: the launcher hero. Inside a
 * scope that has workflows: an inline picker.
 */
export function WorkflowEmptyState(props: WorkflowEmptyStateProps) {
  const { t } = useTranslation('workflow')
  const { launcher, scopedWorkflows } = props
  if (scopedWorkflows.length === 0 && props.scopedKitablePath) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center" data-testid="kitable-workflows-empty">
        <div className="max-w-md">
          <FileText className="mx-auto mb-4 size-8 text-primary" />
          <h1 className="text-xl font-semibold">{t('panels.home.emptyCreateTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('panels.home.emptyCreateHint')}</p>
          <div className="mt-5 flex justify-center">
            <Button className="bg-primary hover:bg-primary/90" onClick={props.onOpenModeDialog} data-testid="kitable-workflows-create-cta">
              <Plus className="mr-1 size-4" />
              {t('panels.home.emptyCreateButton')}
            </Button>
          </div>
          {launcher.error ? <p className="mt-3 text-xs text-destructive" data-testid="kitable-workflows-error">{launcher.error}</p> : null}
        </div>
      </div>
    )
  }
  if (scopedWorkflows.length === 0) {
    return (
      <WorkflowHomeLauncher
        // The AI flow lives on /workflow/new?mode=ai, which lands on the prompt page even without a bound table.
        onGenerateWithAi={() => openWorkflowRoute(null, { mode: 'ai' })}
        onStartFromScratch={() => void launcher.runScratch()}
        onTemplateSelect={(template) => void launcher.runTemplate(template)}
        onAgentClick={launcher.handleAgent}
        busyAction={launcher.busyAction}
        busyTemplateId={launcher.busyTemplateId}
        errorMessage={launcher.error}
        scopeLabel={props.scopedKitableLabel || undefined}
      />
    )
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6" data-testid="kitable-workflows-picker">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {scopedWorkflows.map((workflow) => (
          <div key={workflow.id} data-testid="kitable-workflows-picker-item" className="border-b border-border/60 last:border-b-0 bg-card hover:bg-muted/40">
            <div
              role="button"
              tabIndex={0}
              className="w-full px-4 py-3 text-left"
              onClick={() => props.onSelect(workflow.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onSelect(workflow.id)
                }
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{workflow.name || 'Untitled workflow'}</span>
                <StatusPill status={workflowStatus(workflow, props.latestRuns[workflow.id] || null)} />
              </div>
              <div className="mt-1.5 grid gap-0.5 text-[11px] text-muted-foreground">
                <FlowLine label={t('panels.home.list.flowWhen')} value={triggerLabel(workflow, props.tableLabels, t)} />
                <FlowLine label={t('panels.home.list.flowThen')} value={t('panels.home.nodeCard.actionSendEmail')} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
