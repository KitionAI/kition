import request from '@/api/request'

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

export type EmailSyncTlsMode = 'tls' | 'starttls' | 'plain'
export type EmailSyncStatus = 'active' | 'paused' | 'syncing' | 'error'

export type EmailSyncConnection = {
  host: string
  port: number
  tls_mode: EmailSyncTlsMode
  username: string
  mailbox: string
}

export type EmailSyncTarget = {
  table_path: string
  table_id?: number
  content_folder: string
  attachment_folder: string
}

export type EmailSyncSchedule = {
  enabled: boolean
  interval_minutes: number
}

export type EmailSyncWorkflow = {
  id: string
  name: string
  connection: EmailSyncConnection
  target: EmailSyncTarget
  schedule: EmailSyncSchedule
  include_attachments: boolean
  status: EmailSyncStatus
  last_sync_at?: string
  last_error?: string
  synced_messages: number
  created_at: string
  updated_at: string
}

export type SaveEmailSyncWorkflowInput = {
  name: string
  connection: EmailSyncConnection
  password?: string
  target: EmailSyncTarget
  schedule: EmailSyncSchedule
  include_attachments: boolean
}

export type EmailSyncTestResult = {
  ok: boolean
  mailbox?: string
  message?: string
  error_code?: string
}

export type EmailSyncRunResult = {
  workflow_id: string
  imported: number
  updated: number
  skipped: number
  failed: number
  table_path: string
  started_at: string
  finished_at: string
}

export type EmailSyncRunMode = 'incremental' | 'full' | 'scheduled'
export type EmailSyncRunStatus = 'queued' | 'scanning' | 'running' | 'completed' | 'failed' | 'canceling' | 'canceled' | 'interrupted'

export type EmailSyncRun = {
  id: string
  workflow_id: string
  mode: EmailSyncRunMode
  status: EmailSyncRunStatus
  discovered_messages: number
  processed_messages: number
  imported: number
  updated: number
  skipped: number
  failed: number
  current_batch: number
  table_path: string
  error?: string
  started_at?: string
  finished_at?: string
  created_at: string
  updated_at: string
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
