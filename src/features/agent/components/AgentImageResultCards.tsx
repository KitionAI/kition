import { requestUseImageInDesign } from '@/services/workspaceDesignActions'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { resolveAgentImageURL } from '@/services/workspaceFiles'
import type { AgentImageArtifact } from '@/types/imageGeneration'
import { buildAgentImageJobs, type AgentImageSessionEvent } from '../lib/agentImageJobs'

export type AgentImageResultActions = {
  onEdit?: (artifact: AgentImageArtifact) => void
  onRetry?: (requestId: string) => void
  canRetry?: (requestId: string) => boolean
}
export function AgentImageResultCards({ events, busy, onOpen, onEdit, onRetry, canRetry }: AgentImageResultActions & {
  events: AgentImageSessionEvent[]
  busy: boolean
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation('imageGeneration')
  return buildAgentImageJobs(events).map((job) => {
    const active = !['completed', 'failed', 'canceled'].includes(job.latest.status)
    return <section key={job.requestId} className="my-3 space-y-3 rounded-xl border border-border bg-card p-3"
      data-testid="agent-image-result" data-request-id={job.requestId} aria-label={t('sections.results')}>
      <p role="status" className="text-xs text-muted-foreground">
        {active && !busy ? t('chat.interrupted') : t(`chat.status.${job.latest.status}`)}
      </p>
      {active && busy && job.latest.progress !== undefined ? <progress className="w-full accent-primary" max={1} value={job.latest.progress} aria-label={t('chat.progress')} /> : null}
      {job.latest.error ? <p role="alert" className="text-xs text-destructive">{job.latest.error.message}</p> : null}
      {job.latest.status === 'completed' && !job.artifacts.length ? <p className="text-xs text-muted-foreground">{t('chat.noArtifacts')}</p> : null}
      <div className="grid gap-3">
        {job.artifacts.map((artifact) => <figure key={artifact.id} className="min-w-0 space-y-2">
          <button type="button" className="block w-full overflow-hidden rounded-lg border border-border" onClick={() => onOpen(artifact.path)} aria-label={t('chat.openImage')}>
            <img src={resolveAgentImageURL(artifact.path)} alt={artifact.title || t('chat.generatedImage')}
              loading="lazy" className="h-48 w-full object-contain" />
          </button>
          <figcaption className="break-words text-xs text-muted-foreground">
            {artifact.title || artifact.path.split('/').pop()}
            {artifact.provenance.template_id ? <span className="block">{t('chat.templateVersion', {
              id: artifact.provenance.template_id, version: artifact.provenance.template_version,
            })}</span> : null}
            {artifact.provenance.model_id ? <span className="block">{artifact.provenance.model_id}</span> : null}
          </figcaption>
          <Button variant="secondary" size="sm" onClick={() => requestUseImageInDesign(artifact.path)}>{t('design:useImage')}</Button>
          {onEdit ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => onEdit(artifact)}>{t('chat.edit')}</Button> : null}
        </figure>)}
      </div>
      {onRetry && canRetry?.(job.requestId) && !active && job.latest.error?.retryable !== false ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRetry(job.requestId)}>{t('chat.reuseSettings')}</Button>
      ) : null}
    </section>
  })
}
