import request from '@/api/request'
import {
  getDataDocument,
  listDataDocuments,
  updateDataDocument,
} from '@/api/dataDocuments'

import {
  readDocumentFormSyncWorkflows,
  removeLocalFormSyncWorkflow,
  writeLocalFormSyncWorkflow,
  type LocalFormSyncWorkflow,
} from './localDrafts'

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

export async function listFormSyncWorkflows() {
  const [documents, remoteWorkflows] = await Promise.all([
    listDataDocuments().then((response) => response.items || []),
    request
      .get<{ items?: FormSyncWorkflow[] }>('/v1/form-sync/workflows', { suppressErrorMessage: true })
      .then((response) => response.items || [])
      .catch(() => []),
  ])
  const localWorkflows = readDocumentFormSyncWorkflows(documents)
  const aliasedRemoteIds = new Set(
    localWorkflows.map((workflow) => workflow.remote_workflow_id).filter(Boolean),
  )
  return [
    ...remoteWorkflows.filter((workflow) => !aliasedRemoteIds.has(workflow.id)),
    ...localWorkflows,
  ]
}

export async function createFormSyncWorkflow(input: CreateFormSyncWorkflowInput) {
  if (input.published) {
    const workflow = await request.post<FormSyncWorkflow>('/v1/form-sync/workflows', input)
    emitFormSyncChanged(workflow.id)
    return workflow
  }

  const now = new Date().toISOString()
  const workflow: LocalFormSyncWorkflow = {
    ...input,
    id: createLocalWorkflowId(),
    remote_source_id: '',
    public_url: '',
    published: false,
    status: 'paused',
    synced_submissions: 0,
    created_at: now,
    updated_at: now,
  }
  await persistLocalWorkflow(workflow)
  emitFormSyncChanged(workflow.id)
  return workflow
}

export async function updateFormSyncWorkflow(id: string, input: UpdateFormSyncWorkflowInput) {
  const localWorkflow = await findLocalWorkflow(id)
  if (!localWorkflow) {
    const workflow = await request.patch<FormSyncWorkflow>(
      `/v1/form-sync/workflows/${encodeURIComponent(id)}`,
      input,
    )
    emitFormSyncChanged(workflow.id)
    return workflow
  }

  const mergedWorkflow = mergeWorkflow(localWorkflow, input)
  if (!localWorkflow.remote_workflow_id && input.published !== true) {
    await persistLocalWorkflow(mergedWorkflow)
    emitFormSyncChanged(mergedWorkflow.id)
    return mergedWorkflow
  }

  let remoteWorkflow: FormSyncWorkflow
  try {
    remoteWorkflow = localWorkflow.remote_workflow_id
      ? await request.patch<FormSyncWorkflow>(
          `/v1/form-sync/workflows/${encodeURIComponent(localWorkflow.remote_workflow_id)}`,
          input,
        )
      : await request.post<FormSyncWorkflow>(
          '/v1/form-sync/workflows',
          toCreateInput(mergedWorkflow, true),
        )
  } catch (error) {
    if (!localWorkflow.remote_workflow_id && input.published === true && isMissingFormSyncRoute(error)) {
      throw new Error('Publishing forms requires a runtime with form sync support. Your local draft is safe.')
    }
    throw error
  }
  const nextWorkflow: LocalFormSyncWorkflow = {
    ...mergedWorkflow,
    ...remoteWorkflow,
    id: localWorkflow.id,
    remote_workflow_id: localWorkflow.remote_workflow_id || remoteWorkflow.id,
  }
  await persistLocalWorkflow(nextWorkflow)
  emitFormSyncChanged(nextWorkflow.id)
  return nextWorkflow
}

export async function getFormSyncWorkflow(id: string) {
  const workflows = await listFormSyncWorkflows()
  const workflow = workflows.find((item) => item.id === id)
  if (!workflow) throw new Error('Form not found')
  return workflow
}

export async function syncFormSyncWorkflow(id: string) {
  const localWorkflow = await findLocalWorkflow(id)
  const remoteId = localWorkflow?.remote_workflow_id || id
  if (localWorkflow && !localWorkflow.remote_workflow_id) {
    throw new Error('Publish the form before syncing submissions.')
  }
  return request.post<FormSyncResult>(`/v1/form-sync/workflows/${encodeURIComponent(remoteId)}/sync`, {})
}

export async function deleteFormSyncWorkflow(id: string) {
  const localWorkflow = await findLocalWorkflow(id)
  if (!localWorkflow) {
    throw new Error('Deleting published forms is not supported by this runtime.')
  }
  if (localWorkflow.remote_workflow_id) {
    throw new Error('Deleting a form after it has been published is not supported by this runtime.')
  }
  const documentId = parseDocumentId(localWorkflow.target.document_id)
  const document = await getDataDocument(documentId)
  await updateDataDocument(documentId, {
    meta: removeLocalFormSyncWorkflow(document.meta, id),
  })
  emitFormSyncChanged(id)
}

export const FORM_SYNC_CHANGED_EVENT = 'kition:form-sync:changed'

function emitFormSyncChanged(workflowId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(FORM_SYNC_CHANGED_EVENT, {
    detail: { workflowId },
  }))
}

async function findLocalWorkflow(id: string) {
  const documents = await listDataDocuments().then((response) => response.items || [])
  return readDocumentFormSyncWorkflows(documents).find((workflow) => workflow.id === id)
}

async function persistLocalWorkflow(workflow: LocalFormSyncWorkflow) {
  const documentId = parseDocumentId(workflow.target.document_id)
  const document = await getDataDocument(documentId)
  await updateDataDocument(documentId, {
    meta: writeLocalFormSyncWorkflow(document.meta, workflow),
  })
}

function mergeWorkflow(
  workflow: LocalFormSyncWorkflow,
  input: UpdateFormSyncWorkflowInput,
): LocalFormSyncWorkflow {
  return {
    ...workflow,
    ...input,
    updated_at: new Date().toISOString(),
  }
}

function toCreateInput(
  workflow: LocalFormSyncWorkflow,
  published: boolean,
): CreateFormSyncWorkflowInput {
  return {
    name: workflow.name,
    template_id: workflow.template_id,
    fields: workflow.fields,
    target: workflow.target,
    schedule: workflow.schedule,
    published,
  }
}

function parseDocumentId(value: string) {
  const documentId = Number(value)
  if (!Number.isInteger(documentId) || documentId <= 0) {
    throw new Error('The form destination document is invalid.')
  }
  return documentId
}

function createLocalWorkflowId() {
  const token = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `formsync_local_${token.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
}

function isMissingFormSyncRoute(error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status
  return status === 404
    || (error instanceof Error && error.message === 'The requested resource was not found')
}
