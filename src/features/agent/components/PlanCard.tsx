import { CheckIcon as Check, CircleIcon as Circle, LoaderCircleIcon as LoaderCircle } from '@kition/tessera-icons/react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@kition/app-ui/utils'

type PlanStep = {
  step: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

type AgentPlanSnapshot = {
  explanation?: string
  plan: PlanStep[]
}

export function PlanCard({ snapshot }: { snapshot: AgentPlanSnapshot }) {
  const { t } = useTranslation('agent')
  const { explanation, plan } = snapshot
  const summary = useMemo(() => {
    const pending = plan.filter((step) => step.status === 'pending').length
    const inProgress = plan.filter((step) => step.status === 'in_progress').length
    const completed = plan.filter((step) => step.status === 'completed').length
    return t('planCard.summary', { total: plan.length, completed, inProgress, pending })
  }, [plan, t])

  return (
    <div className="plan-card">
      <div className="plan-card-header">
        <span className="plan-card-title">{t('planCard.title')}</span>
        <span className="plan-card-summary">{summary}</span>
      </div>
      {explanation ? <p className="plan-card-explanation">{explanation}</p> : null}
      <ol className="plan-card-steps">
        {plan.map((step, index) => (
          <li
            key={`${index}-${step.step}`}
            className={cn(
              'plan-card-step',
              step.status === 'completed' && 'is-completed',
              step.status === 'in_progress' && 'is-in-progress',
              step.status === 'pending' && 'is-pending',
            )}
          >
            <PlanStepIcon status={step.status} />
            <span className="plan-card-step-text">{step.step}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function PlanStepIcon({ status }: { status: PlanStep['status'] }) {
  if (status === 'completed') {
    return <Check className="size-3.5" aria-hidden />
  }
  if (status === 'in_progress') {
    return <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
  }
  return <Circle className="size-3.5" aria-hidden />
}
