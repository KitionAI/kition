/**
 * Email inbox sync workflows. Contract: contracts/runtime/email-sync.schema.json.
 * Shapes come from the generated contract types; this module only adds the
 * HTTP calls and the window events other surfaces listen to.
 */
import request from '@/api/request'
import type {
  EmailSyncConnection,
  EmailSyncSaveInput,
  EmailSyncSchedule,
  EmailSyncSyncResult,
  EmailSyncSyncRun,
  EmailSyncTarget,
  EmailSyncTlsMode,
  EmailSyncWorkflow,
} from '@/api/generated'

export type { EmailSyncConnection, EmailSyncSchedule, EmailSyncTarget, EmailSyncTlsMode, EmailSyncWorkflow }
export type EmailSyncStatus = EmailSyncWorkflow['status']
export type SaveEmailSyncWorkflowInput = EmailSyncSaveInput
export type EmailSyncRunResult = EmailSyncSyncResult
export type EmailSyncRun = EmailSyncSyncRun
export type EmailSyncRunMode = EmailSyncRun['mode']
export type EmailSyncRunStatus = EmailSyncRun['status']

/** Response of the connection test endpoint. Not yet part of the public contract. */
export type EmailSyncTestResult = {
  ok: boolean
  mailbox?: string
  message?: string
  error_code?: string
}

export const EMAIL_SYNC_CHANGED_EVENT = 'kition:email-sync:changed'

function notifyEmailSyncChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EMAIL_SYNC_CHANGED_EVENT))
  }
}

function notifyWorkspaceReload(preferredPath: string) {
  if (typeof window !== 'undefined' && preferredPath) {
    window.dispatchEvent(new CustomEvent('kition:workspace-reload', {
      detail: { preferredPath, treeOnly: true },
    }))
  }
}

export function listEmailSyncWorkflows() {
  return request.get<{ items?: EmailSyncWorkflow[] }>('/v1/email-sync/workflows').then((response) => (
    Array.isArray(response?.items) ? response.items : []
  ))
}

export function createEmailSyncWorkflow(input: SaveEmailSyncWorkflowInput) {
  return request.post<EmailSyncWorkflow>('/v1/email-sync/workflows', input).then((workflow) => {
    notifyEmailSyncChanged()
    return workflow
  })
}

export function updateEmailSyncWorkflow(id: string, input: Partial<SaveEmailSyncWorkflowInput>) {
  return request.patch<EmailSyncWorkflow>(`/v1/email-sync/workflows/${id}`, input).then((workflow) => {
    notifyEmailSyncChanged()
    return workflow
  })
}

export function deleteEmailSyncWorkflow(id: string) {
  return request.delete<void>(`/v1/email-sync/workflows/${id}`).then((result) => {
    notifyEmailSyncChanged()
    return result
  })
}

export function testEmailSyncWorkflow(id: string) {
  return request.post<EmailSyncTestResult>(`/v1/email-sync/workflows/${id}/test`, {})
}

export function runEmailSyncWorkflow(id: string) {
  return request.post<EmailSyncRunResult>(`/v1/email-sync/workflows/${id}/sync`, {}).then((result) => {
    notifyEmailSyncChanged()
    notifyWorkspaceReload(result.table_path)
    return result
  })
}

export function runAllEmailSyncWorkflow(id: string) {
  return request.post<EmailSyncRunResult>(`/v1/email-sync/workflows/${id}/sync-all`, {}).then((result) => {
    notifyEmailSyncChanged()
    notifyWorkspaceReload(result.table_path)
    return result
  })
}

export function startEmailSyncRun(id: string, mode: Exclude<EmailSyncRunMode, 'scheduled'>) {
  return request.post<EmailSyncRun>(`/v1/email-sync/workflows/${id}/runs`, { mode }).then((run) => {
    notifyEmailSyncChanged()
    return run
  })
}

export function listEmailSyncRuns(workflowId?: string, limit = 20) {
  const params = new URLSearchParams()
  if (workflowId) params.set('workflow_id', workflowId)
  params.set('limit', String(limit))
  return request.get<{ items?: EmailSyncRun[] }>(`/v1/email-sync/runs?${params.toString()}`).then((response) => (
    Array.isArray(response?.items) ? response.items : []
  ))
}

export function getEmailSyncRun(id: string) {
  return request.get<EmailSyncRun>(`/v1/email-sync/runs/${id}`)
}

export function cancelEmailSyncRun(id: string) {
  return request.post<EmailSyncRun>(`/v1/email-sync/runs/${id}/cancel`, {}).then((run) => {
    notifyEmailSyncChanged()
    return run
  })
}

export function retryEmailSyncRun(id: string) {
  return request.post<EmailSyncRun>(`/v1/email-sync/runs/${id}/retry`, {}).then((run) => {
    notifyEmailSyncChanged()
    return run
  })
}
