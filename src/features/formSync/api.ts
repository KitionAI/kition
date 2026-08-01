import request from '@/api/request'

export type FormSyncFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'datetime'
  | 'select'
  | 'long_text'

export type FormSyncField = {
  key: string
  label: string
  type: FormSyncFieldType
  required: boolean
  options?: string[]
}

export type FormSyncTarget = {
  document_id: string
  table_id: string
  field_mappings: Array<{
    source_key: string
    target_field_title: string
  }>
  defaults?: Array<{
    target_field_title: string
    value: unknown
  }>
  submission_id_field_title?: string
  submitted_at_field_title?: string
}

export type FormSyncSchedule = {
  enabled: boolean
  interval_minutes: number
}

export type FormSyncWorkflow = {
  id: string
  name: string
  template_id: string
  remote_source_id: string
  public_url: string
  published: boolean
  fields: FormSyncField[]
  target: FormSyncTarget
  schedule: FormSyncSchedule
  status: 'active' | 'paused' | 'syncing' | 'error'
  last_sync_at?: string
  last_error?: string
  synced_submissions: number
  created_at: string
  updated_at: string
}

export type CreateFormSyncWorkflowInput = {
  name: string
  template_id: string
  fields: FormSyncField[]
  target: FormSyncTarget
  schedule: FormSyncSchedule
  published?: boolean
}

export type UpdateFormSyncWorkflowInput = Partial<Pick<
  CreateFormSyncWorkflowInput,
  'name' | 'fields' | 'target' | 'schedule' | 'published'
>>

export type FormSyncResult = {
  workflow_id: string
  imported: number
  skipped: number
  failed: number
  started_at: string
  finished_at: string
}

export function listFormSyncWorkflows() {
  return request.get<{ items?: FormSyncWorkflow[] }>('/v1/form-sync/workflows').then((response) => (
    response.items || []
  ))
}

export function createFormSyncWorkflow(input: CreateFormSyncWorkflowInput) {
  return request.post<FormSyncWorkflow>('/v1/form-sync/workflows', input).then((workflow) => {
    emitFormSyncChanged(workflow.id)
    return workflow
  })
}

export function updateFormSyncWorkflow(id: string, input: UpdateFormSyncWorkflowInput) {
  return request
    .patch<FormSyncWorkflow>(`/v1/form-sync/workflows/${encodeURIComponent(id)}`, input)
    .then((workflow) => {
      emitFormSyncChanged(workflow.id)
      return workflow
    })
}

export async function getFormSyncWorkflow(id: string) {
  const workflows = await listFormSyncWorkflows()
  const workflow = workflows.find((item) => item.id === id)
  if (!workflow) throw new Error('Form not found')
  return workflow
}

export function syncFormSyncWorkflow(id: string) {
  return request.post<FormSyncResult>(`/v1/form-sync/workflows/${encodeURIComponent(id)}/sync`, {})
}

export const FORM_SYNC_CHANGED_EVENT = 'kition:form-sync:changed'

function emitFormSyncChanged(workflowId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(FORM_SYNC_CHANGED_EVENT, {
    detail: { workflowId },
  }))
}
