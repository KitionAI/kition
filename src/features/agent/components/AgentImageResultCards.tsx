import { requestUseImageInDesign } from '@/services/workspaceDesignActions'
import { useTranslation } from 'react-i18next'
import { Button } from '@kition/app-ui'
import { resolveAgentImageURL } from '@/services/workspaceFiles'
import type { AgentImageArtifact } from '@/types/imageGeneration'
import type { imageJobOf } from '../lib/agentImageJob'

type AgentImageJob = NonNullable<ReturnType<typeof imageJobOf>>

export type AgentImageResultActions = {
  onEdit?: (artifact: AgentImageArtifact) => void
  onRetry?: (requestId: string) => void
  canRetry?: (requestId: string) => boolean
  headlineFor?: (requestId: string) => string | undefined
}
/** The result card of one image composer request. */
export function AgentImageResultCards({ job, busy, onOpen, onEdit, onRetry, canRetry, headlineFor }: AgentImageResultActions & {
  job: AgentImageJob
  busy: boolean
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation('imageGeneration')
  const active = !['completed', 'failed', 'canceled'].includes(job.status)
  return <section key={job.requestId} className="my-3 space-y-3 rounded-xl border border-border bg-card p-3"
      data-testid="agent-image-result" data-request-id={job.requestId} aria-label={t('sections.results')}>
      <p role="status" className="text-xs text-muted-foreground">
        {active && !busy ? t('chat.interrupted') : t(`chat.status.${job.status}`)}
      </p>
      {active && busy ? <progress className="w-full accent-primary" max={1} value={job.progress} aria-label={t('chat.progress')} /> : null}
      {job.error ? <p role="alert" className="text-xs text-destructive">{job.error.message}</p> : null}
      {job.status === 'completed' && !job.artifacts.length ? <p className="text-xs text-muted-foreground">{t('chat.noArtifacts')}</p> : null}
      <div className="grid gap-3">
        {job.artifacts.map((artifact) => <figure key={artifact.call_id} className="min-w-0 space-y-2">
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
          <Button variant="secondary" size="sm" onClick={() => requestUseImageInDesign(artifact.path, false, headlineFor?.(job.requestId))}>{t('design:useImage')}</Button>
          {onEdit ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => onEdit(artifact)}>{t('chat.edit')}</Button> : null}
        </figure>)}
      </div>
      {onRetry && canRetry?.(job.requestId) && !active && job.error?.retryable !== false ? (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRetry(job.requestId)}>{t('chat.reuseSettings')}</Button>
      ) : null}
    </section>
}
