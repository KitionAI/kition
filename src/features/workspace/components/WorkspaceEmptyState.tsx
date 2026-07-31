import { ArrowRight, FileSpreadsheet, FileText, Sparkles, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { KitionLogoMark } from '@/components/KitionLogoMark'

type WorkspaceEmptyStateProps = {
  onCreateDocument: () => void
  onCreateTable: () => void
  onOpenAgent: () => void
  onOpenWorkflows: () => void
}

export function WorkspaceEmptyState({
  onCreateDocument,
  onCreateTable,
  onOpenAgent,
  onOpenWorkflows,
}: WorkspaceEmptyStateProps) {
  const { t } = useTranslation('workspace')

  const quickActions = [
    {
      key: 'document',
      icon: FileText,
      title: t('emptyState.actions.document.title'),
      description: t('emptyState.actions.document.description'),
      onClick: onCreateDocument,
    },
    {
      key: 'table',
      icon: FileSpreadsheet,
      title: t('emptyState.actions.table.title'),
      description: t('emptyState.actions.table.description'),
      onClick: onCreateTable,
    },
    {
      key: 'workflow',
      icon: Workflow,
      title: t('emptyState.actions.workflow.title'),
      description: t('emptyState.actions.workflow.description'),
      onClick: onOpenWorkflows,
    },
  ]

  return (
    <section className="workspace-empty-state" data-testid="workspace-empty-state">
      <div className="workspace-empty-state__content">
        <div className="workspace-empty-state__brand" aria-hidden="true">
          <span className="workspace-empty-state__brand-glow" />
          <KitionLogoMark alt="" className="workspace-empty-state__logo" />
          <Sparkles className="workspace-empty-state__sparkle" />
        </div>

        <h1>{t('emptyState.title')}</h1>
        <p className="workspace-empty-state__description">
          {t('emptyState.description')}
        </p>

        <button
          type="button"
          className="workspace-empty-state__prompt"
          onClick={onOpenAgent}
        >
          <span className="workspace-empty-state__prompt-icon" aria-hidden="true">
            <Sparkles />
          </span>
          <span className="workspace-empty-state__prompt-copy">
            <strong>{t('emptyState.prompt.title')}</strong>
            <span>{t('emptyState.prompt.description')}</span>
          </span>
          <span className="workspace-empty-state__prompt-action">
            {t('emptyState.prompt.action')}
            <ArrowRight aria-hidden="true" />
          </span>
        </button>

        <div className="workspace-empty-state__divider">
          <span>{t('emptyState.quickStart')}</span>
        </div>

        <div className="workspace-empty-state__actions">
          {quickActions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.key}
                type="button"
                className="workspace-empty-state__action-card"
                onClick={action.onClick}
              >
                <span className="workspace-empty-state__action-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="workspace-empty-state__action-copy">
                  <strong>{action.title}</strong>
                  <span>{action.description}</span>
                </span>
                <ArrowRight className="workspace-empty-state__action-arrow" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
