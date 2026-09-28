import { AlertCircle, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { useWorkflowSendTest } from '@/features/workflow/hooks/useWorkflowSendTest'
import { phaseLabelKey, type AiBuildPhase } from '@/features/workflow/lib/aiBuildPreview'
import { StatusBannerSlot } from '@/features/workflow/pages/WorkflowHomePageStatusBanner'

type RunTestState = Pick<ReturnType<typeof useWorkflowSendTest>, 'status' | 'result' | 'error'>

export type WorkflowRunTestHeaderProps = {
  lastRunFailed: boolean
  nameError: string | undefined
  runTest: RunTestState
}

/** Above the editor: a failing last run, a name problem, or the outcome of the last test send. Renders nothing when there is nothing to say. */
export function WorkflowRunTestHeader({ lastRunFailed, nameError, runTest }: WorkflowRunTestHeaderProps) {
  const { t } = useTranslation('workflow')
  if (!lastRunFailed && !nameError && runTest.status !== 'done' && runTest.status !== 'error') return null
  return (
    <header className="border-b border-border bg-card px-6 py-3">
      {lastRunFailed ? (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertCircle className="size-3.5" />
          {t('panels.home.failingLastRun')}
        </span>
      ) : null}
      {nameError ? <div className="mt-1 text-[11px] text-destructive" data-testid="workflow-home-field-error">{t(`panels.home.validation.${nameError}`)}</div> : null}
      {runTest.status === 'done' && runTest.result ? (
        <div data-testid="workflow-home-run-test-status" className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success-foreground">
          <div className="font-semibold">{t('panels.home.testEmailDelivered')}</div>
          <div className="mt-2 grid gap-1 text-success-foreground" data-testid="workflow-home-run-test-preview">
            <div><strong>{t('panels.home.detailTo')}</strong>&nbsp;&nbsp;{runTest.result.input.to}</div>
            <div><strong>{t('panels.home.detailSubject')}</strong>&nbsp;&nbsp;{runTest.result.input.subject}</div>
            <div data-testid="workflow-home-run-test-body" className="whitespace-pre-wrap"><strong>{t('panels.home.detailBody')}</strong>&nbsp;&nbsp;{runTest.result.input.body}</div>
          </div>
        </div>
      ) : null}
      {runTest.status === 'error' ? (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="workflow-home-run-test-error">{runTest.error}</div>
      ) : null}
    </header>
  )
}

/** Field names a template could not bind to the table; dismissable. */
export function WorkflowUnresolvedTemplateBanner({ fieldNames, onDismiss }: { fieldNames: string[]; onDismiss: () => void }) {
  const { t } = useTranslation('workflow')
  if (fieldNames.length === 0) return null
  return (
    <div
      data-testid="workflow-home-template-unresolved-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
      role="status"
    >
      <div className="flex-1 leading-snug">
        <strong className="font-semibold">{t('panels.home.unresolvedTitle', { count: fieldNames.length })}</strong>
        <span className="ml-1">{t('panels.home.unresolvedBody', { names: fieldNames.join(', ') })}</span>
      </div>
      <button
        type="button"
        data-testid="workflow-home-template-unresolved-dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-warning-foreground hover:bg-warning/20"
      >
        {t('panels.home.unresolvedDismiss')}
      </button>
    </div>
  )
}

export type WorkflowBuildBannerProps = {
  streamLocked: boolean
  phase: AiBuildPhase | undefined
  buildError: string | null | undefined
  status: React.ComponentProps<typeof StatusBannerSlot>
}

/** The AI build progress or failure while a build is in flight; otherwise the workflow's own status banner. */
export function WorkflowBuildBanner({ streamLocked, phase, buildError, status }: WorkflowBuildBannerProps) {
  const { t } = useTranslation('workflow')
  if (streamLocked && phase) {
    return (
      <div
        data-testid="workflow-home-streaming-banner"
        className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary"
        role="status"
      >
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        <span className="font-medium">{t('panels.home.streamingBanner.title')}</span>
        <span className="text-primary">·</span>
        <span className="text-xs text-primary">{t(phaseLabelKey(phase))}</span>
      </div>
    )
  }
  if (buildError) {
    return (
      <div
        data-testid="workflow-home-streaming-error"
        className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        role="alert"
      >
        <strong>{t('panels.home.streamingBanner.errorTitle')}</strong> {buildError}
      </div>
    )
  }
  return <StatusBannerSlot {...status} />
}
