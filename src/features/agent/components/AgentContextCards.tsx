import type { AgentEvent, AgentTablePlanContext } from '@/api/agent'
import { useTranslation } from 'react-i18next'

export type AgentBrowserOpenRequest = {
  action: string
  provider?: string
  host?: string
  url?: string
  query?: string
  message?: string
}

export function readBrowserOpenRequest(event: AgentEvent): AgentBrowserOpenRequest {
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>
  return {
    action: String(data.action || '').trim() || 'open_embedded_browser',
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    host: typeof data.host === 'string' ? data.host : undefined,
    url: typeof data.url === 'string' ? data.url : undefined,
    query: typeof data.query === 'string' ? data.query : undefined,
    message:
      typeof event.message === 'string' && event.message
        ? event.message
        : 'The agent needs you to open the page in the browser before continuing.',
  }
}

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

  if (!plan) {
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
        {hasMetrics ? (
          allZero ? (
            <span className="data-agent-result-empty">{t('contextCards.noChanges')}</span>
          ) : (
            <span className="data-agent-result-inline" aria-label={t('contextCards.writeResult')}>
              <span className="data-agent-result-tag data-agent-result-tag--new">+{created ?? 0}</span>
              <span className="data-agent-result-tag data-agent-result-tag--updated">~{updated ?? 0}</span>
              <span className="data-agent-result-tag data-agent-result-tag--skipped">−{skipped ?? 0}</span>
            </span>
          )
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
