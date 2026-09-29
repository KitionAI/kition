import { Check, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import type { DesignAgentPreviewState } from '../hooks/useDesignAgentPatch'

export function DesignAgentPreviewControls({
  state,
  onAccept,
  onReject,
  onCancel,
}: {
  state: DesignAgentPreviewState
  onAccept: () => void
  onReject: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('design')
  if (state.status === 'idle') return null
  const streaming = state.status === 'streaming'
  return (
    <section
      className="design-agent-preview"
      aria-live="polite"
      data-testid="design-agent-preview-controls"
    >
      <div className="design-agent-preview-head">
        <span className="design-agent-preview-icon">
          <Sparkles />
        </span>
        <div>
          <strong>
            {streaming
              ? t('agentPreview.generating')
              : state.status === 'error'
                ? t('agentPreview.invalid')
                : t('agentPreview.ready')}
          </strong>
          <p title={state.error || state.patch?.summary}>
            {state.error || state.patch?.summary}
          </p>
        </div>
      </div>
      {state.patch?.operations.length ? (
        <ol
          className="design-agent-operations"
          data-testid="design-agent-operation-list"
        >
          {state.patch.operations.map((operation, index) => (
            <li key={`${operation.op}:${index}`}>
              {t(`agentPreview.operations.${operation.op}`)}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="design-agent-preview-actions">
        {streaming ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={onCancel}
            data-testid="design-agent-cancel"
          >
            <X />
            {t('agentPreview.cancel')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={onReject}
              data-testid="design-agent-reject"
            >
              <X />
              {t('agentPreview.reject')}
            </Button>
            {state.status === 'ready' ? (
              <Button size="sm" onClick={onAccept} data-testid="design-agent-accept">
                <Check />
                {t('agentPreview.accept')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
