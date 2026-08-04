import type { AgentEvent, AgentTablePlanContext } from '@/api/agent'
import { useTranslation } from 'react-i18next'

function readTablePlan(event: AgentEvent): AgentTablePlanContext | null {
  if (!event.data || typeof event.data !== 'object') {
    return null
  }
  return event.data as AgentTablePlanContext
}

export function AgentContextCards({
  events,
  busy,
  onApplyPlan,
}: {
  events: AgentEvent[]
  busy: boolean
  onApplyPlan?: (plan: AgentTablePlanContext) => void
}) {
  let planIndex = -1
  events.forEach((event, index) => {
    if (event.event_type === 'table.plan.generated') {
      planIndex = index
    }
  })

  const plan = planIndex >= 0 ? readTablePlan(events[planIndex]) : null

  const appliedMetrics = plan?.applied === true
    ? [plan.actual_created, plan.actual_updated, plan.actual_skipped]
    : []
  const hasAppliedMetrics = appliedMetrics.some((value) => typeof value === 'number')
  const hasAppliedChanges = appliedMetrics.some((value) => typeof value === 'number' && value !== 0)
  const isEmptyAppliedResult = Boolean(
    plan?.applied === true
    && hasAppliedMetrics
    && !hasAppliedChanges
    && !plan.summary
    && !plan.risks?.length,
  )

  if (!plan || isEmptyAppliedResult) {
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
  const applied = plan.applied === true
  const eyebrow = applied ? t('contextCards.writeComplete') : t('contextCards.writePlan')
  const created = applied ? plan.actual_created : plan.estimated_create
  const updated = applied ? plan.actual_updated : plan.estimated_update
  const skipped = applied ? plan.actual_skipped : plan.estimated_skip
  const hasMetrics =
    typeof created === 'number' || typeof updated === 'number' || typeof skipped === 'number'
  const allZero = (created ?? 0) === 0 && (updated ?? 0) === 0 && (skipped ?? 0) === 0
  const showApply = !applied && plan.requires_apply_confirmation === true && Boolean(onApplyPlan)

  return (
    <div className="data-agent-plan-card">
      <div className="data-agent-card-head">
        <span className="data-agent-card-eyebrow">{eyebrow}</span>
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
        <div className="data-agent-browser-actions">
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
