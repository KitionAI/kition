import { useTranslation } from 'react-i18next'
import type { WorkflowDefinition } from '@/features/workflow/api'
import { StatusBanner, deriveBannerState } from '@/features/workflow/banner/StatusBanner'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import type {
  ValidationErrors,
  WorkflowDraft,
} from '@/features/workflow/lib/workflowDraft'

/**
 * StatusBannerSlot — split out of WorkflowHomePage (WF-C1d).
 *
 * Translates the page-level state machine (enabled flag + draft
 * validation + latest-run status) into the StatusBanner's three
 * configured/disabled/failing variants. We keep the issue-list synthesis
 * here rather than in workflowDraft.ts because it's purely
 * presentational — the underlying validation flags already live on
 * ValidationErrors; this layer just adapts them into the issue shape the
 * banner consumes.
 *
 * Returns an empty enabled banner when nothing's wrong, so the parent JSX
 * can render this slot unconditionally without branching on banner state.
 */
export function StatusBannerSlot({
  selected,
  draft,
  validation,
  latestRun,
  onFix,
  onEnable,
}: {
  selected: WorkflowDefinition
  draft: WorkflowDraft
  validation: ValidationErrors
  latestRun: WorkflowRunRecord | null
  onFix: () => void
  onEnable: () => void
}) {
  const { t } = useTranslation('workflow')
  const issues: { nodeId: string; code: string; message: string }[] = []
  const validationMsg = (code: string | undefined) => code ? t(`panels.home.validation.${code}`) : ''
  if (draft.actionType === 'add_record') {
    if (validation.addRecordTarget) {
      issues.push({ nodeId: selected.action.nodeId || 'action_1', code: 'add_record_target_missing', message: validationMsg(validation.addRecordTarget) })
    }
  } else if (['update_record', 'lookup_record', 'transform_record'].includes(draft.actionType)) {
    if (validation.recordAction) {
      issues.push({ nodeId: selected.action.nodeId || 'action_1', code: validation.recordAction, message: validationMsg(validation.recordAction) })
    }
  } else {
    if (validation.to) issues.push({ nodeId: selected.action.nodeId || 'action_1', code: 'to_empty', message: validationMsg(validation.to) })
    if (validation.subject) issues.push({ nodeId: selected.action.nodeId || 'action_1', code: 'subject_empty', message: validationMsg(validation.subject) })
    if (validation.body) issues.push({ nodeId: selected.action.nodeId || 'action_1', code: 'body_empty', message: validationMsg(validation.body) })
    if (!draft.connectionId) {
      issues.push({ nodeId: selected.action.nodeId || 'action_1', code: 'connection_missing', message: t('panels.home.validation.connectionRequired') })
    }
  }
  const state = deriveBannerState({
    enabled: selected.enabled,
    issues,
    lastRunStatus: latestRun?.status === 'error' ? 'error' : latestRun?.status === 'ok' ? 'ok' : null,
    lastRunMessage: latestRun?.error || null,
    failingNodeId: selected.action.nodeId || 'action_1',
  }, t)
  if (state.kind === 'enabled') return <StatusBanner kind="enabled" body="" />
  return (
    <StatusBanner
      kind={state.kind}
      leading={state.leading}
      body={state.body}
      primaryAction={
        state.kind === 'configured_disabled'
          ? { label: t('panels.home.statusBanner.enableNow'), onClick: onEnable, testId: 'workflow-status-banner-enable' }
          : state.kind === 'failing'
            ? {
                label: issues[0]?.code === 'connection_missing'
                  ? t('panels.home.statusBanner.fixConnection')
                  : t('panels.home.statusBanner.fixAction'),
                onClick: onFix,
                testId: 'workflow-status-banner-fix',
              }
            : { label: t('panels.home.statusBanner.finishConfiguration'), onClick: onFix, testId: 'workflow-status-banner-finish' }
      }
    />
  )
}
