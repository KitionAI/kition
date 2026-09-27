/**
 * Cloud form sync workflows: HTTP calls only. Contract:
 * contracts/runtime/form-sync.schema.json. The local-draft orchestration that
 * decides between a runtime workflow and a document-embedded draft lives in
 * src/features/formSync/api.ts and composes these calls.
 */
import request from '@/api/request'
import type {
  FormSyncCreateInput,
  FormSyncFormField,
  FormSyncFormFieldType,
  FormSyncSchedule,
  FormSyncSyncResult,
  FormSyncTarget,
  FormSyncUpdateInput,
  FormSyncWorkflow,
} from '@/api/generated'

export type { FormSyncSchedule, FormSyncTarget, FormSyncWorkflow }
export type FormSyncFieldType = FormSyncFormFieldType
export type FormSyncField = FormSyncFormField
export type CreateFormSyncWorkflowInput = FormSyncCreateInput
export type UpdateFormSyncWorkflowInput = FormSyncUpdateInput
export type FormSyncResult = FormSyncSyncResult

export const FORM_SYNC_CHANGED_EVENT = 'kition:form-sync:changed'

const BASE = '/v1/form-sync/workflows'

function workflowPath(id: string) {
  return `${BASE}/${encodeURIComponent(id)}`
}

/** Lists runtime-backed workflows. Resolves to an empty list when the runtime lacks form sync. */
export function listRemoteFormSyncWorkflows() {
  return request
    .get<{ items?: FormSyncWorkflow[] }>(BASE, { suppressErrorMessage: true })
    .then((response) => response.items || [])
    .catch(() => [] as FormSyncWorkflow[])
}

export function createRemoteFormSyncWorkflow(input: CreateFormSyncWorkflowInput) {
  return request.post<FormSyncWorkflow>(BASE, input)
}

export function updateRemoteFormSyncWorkflow(id: string, input: UpdateFormSyncWorkflowInput) {
  return request.patch<FormSyncWorkflow>(workflowPath(id), input)
}

export function syncRemoteFormSyncWorkflow(id: string) {
  return request.post<FormSyncResult>(`${workflowPath(id)}/sync`, {})
}
