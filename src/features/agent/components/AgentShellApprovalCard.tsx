import { GlobeIcon as Globe, ShieldAlertIcon as ShieldAlert, SquareTerminalIcon as SquareTerminal } from '@kition/tessera-icons/react'
import { useTranslation } from 'react-i18next'
import type {
  AgentShellApprovalDecision,
  AgentShellApprovalRequest,
} from '@/api/agent'
import './AgentShellApprovalCard.css'

export function AgentShellApprovalCard({
  request,
  busy,
  onDecision,
}: {
  request: AgentShellApprovalRequest
  busy: boolean
  onDecision?: (
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => void
}) {
  const { t } = useTranslation('agent')
  const isFetch = request.action === 'web_fetch'
  const rememberedPrefix = isFetch ? '' : request.suggested?.prefix.join(' ') || ''
  const target = isFetch ? request.command.replace(/^web_fetch /, '') : request.command
  const TargetIcon = isFetch ? Globe : SquareTerminal

  return (
    <section className="agent-shell-approval" data-testid="agent-shell-approval">
      <div className="agent-shell-approval__header">
        <span className="agent-shell-approval__icon" aria-hidden="true">
          <ShieldAlert className="size-4" />
        </span>
        <span>{t(isFetch ? 'shellApproval.fetchEyebrow' : 'shellApproval.eyebrow')}</span>
      </div>
      <div className="agent-shell-approval__command">
        <TargetIcon className="size-4 shrink-0" aria-hidden="true" />
        <code>{target}</code>
      </div>
      {request.reason ? (
        <p className="agent-shell-approval__reason">{request.reason}</p>
      ) : null}
      <div className="agent-shell-approval__actions">
        <button
          type="button"
          className="agent-shell-approval__allow"
          disabled={busy || !onDecision}
          onClick={() => onDecision?.(request, 'allow_once')}
        >
          {t('shellApproval.allowOnce')}
        </button>
        {rememberedPrefix ? (
          <button
            type="button"
            className="agent-shell-approval__remember"
            disabled={busy || !onDecision}
            title={t('shellApproval.rememberTitle', { prefix: rememberedPrefix })}
            onClick={() => onDecision?.(request, 'allow_always')}
          >
            {t('shellApproval.alwaysAllow', { target: rememberedPrefix })}
          </button>
        ) : null}
        <button
          type="button"
          className="agent-shell-approval__deny"
          disabled={busy || !onDecision}
          onClick={() => onDecision?.(request, 'deny')}
        >
          {t('shellApproval.deny')}
        </button>
      </div>
    </section>
  )
}
