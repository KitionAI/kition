import type { AgentTablePlanContext } from '@/api/agent'
import { useTranslation } from 'react-i18next'
import { deriveTablePlan } from '../lib/agentTablePlan'
import type { AgentSessionView } from '../lib/agentSessionView'

/** The table plan of the latest turn that planned or wrote table data. */
function latestTablePlan(view: AgentSessionView): AgentTablePlanContext | null {
  for (let index = view.turns.length - 1; index >= 0; index -= 1) {
    const plan = deriveTablePlan(view.turns[index])
    if (plan) return plan
  }
  return null
}

export function AgentContextCards({
  view,
  busy,
  onApplyPlan,
}: {
  view: AgentSessionView
  busy: boolean
  onApplyPlan?: (plan: AgentTablePlanContext) => void
}) {
  const plan = latestTablePlan(view)

  if (!plan || plan.applied === true) {
    return null
  }

  return (
    <div className="agent-context-cards">
      <TablePlanCard plan={plan} busy={busy} onApplyPlan={onApplyPlan} />
    </div>
  )
}

function TablePlanCard({
  plan,
  busy,
  onApplyPlan,
}: {
  plan: AgentTablePlanContext
  busy: boolean
  onApplyPlan?: (plan: AgentTablePlanContext) => void
}) {
  const { t } = useTranslation('agent')
  const created = plan.estimated_create
  const updated = plan.estimated_update
  const skipped = plan.estimated_skip
  const hasMetrics =
    typeof created === 'number' || typeof updated === 'number' || typeof skipped === 'number'
  const allZero = (created ?? 0) === 0 && (updated ?? 0) === 0 && (skipped ?? 0) === 0
  const showApply = plan.requires_apply_confirmation === true && Boolean(onApplyPlan)

  return (
    <div className="data-agent-plan-card">
      <div className="data-agent-card-head">
        <span className="data-agent-card-eyebrow">{t('contextCards.writePlan')}</span>
        {hasMetrics && !allZero ? (
            <span className="data-agent-result-inline" aria-label={t('contextCards.writeResult')}>
              <span className="data-agent-result-tag data-agent-result-tag--new">+{created ?? 0}</span>
              <span className="data-agent-result-tag data-agent-result-tag--updated">~{updated ?? 0}</span>
              <span className="data-agent-result-tag data-agent-result-tag--skipped">−{skipped ?? 0}</span>
            </span>
        ) : null}
        {plan.summary ? <strong className="data-agent-card-title">{plan.summary}</strong> : null}
      </div>
      {plan.risks?.length ? (
        <ul className="data-agent-plan-risk">
          {plan.risks.map((risk, index) => (
            <li key={`${risk}:${index}`}>{risk}</li>
          ))}
        </ul>
      ) : null}
      {showApply ? (
        <div className="data-agent-actions">
          <button
            type="button"
            className="data-agent-action-primary"
            disabled={busy}
            onClick={() => onApplyPlan?.(plan)}
          >
            {t('contextCards.writeToTable')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
