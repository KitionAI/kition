/**
 * Form sync orchestration: decides whether a form lives as a document-embedded
 * local draft or as a published runtime workflow, and keeps the two in step.
 * HTTP calls and contract types come from src/api/formSync.ts.
 */
import {
  FORM_SYNC_CHANGED_EVENT,
  createRemoteFormSyncWorkflow,
  listRemoteFormSyncWorkflows,
  syncRemoteFormSyncWorkflow,
  updateRemoteFormSyncWorkflow,
  type CreateFormSyncWorkflowInput,
  type FormSyncWorkflow,
  type UpdateFormSyncWorkflowInput,
} from '@/api/formSync'
import { listTableFiles, updateTable } from '@/api/kitTables'

import {
  readTableFileFormSyncWorkflows,
  removeLocalFormSyncWorkflow,
  writeLocalFormSyncWorkflow,
  type LocalFormSyncWorkflow,
} from './localDrafts'

export type {
  CreateFormSyncWorkflowInput,
  FormSyncField,
  FormSyncFieldType,
  FormSyncWorkflow,
  UpdateFormSyncWorkflowInput,
} from '@/api/formSync'

export async function listFormSyncWorkflows() {
  const [files, remoteWorkflows] = await Promise.all([
    listTableFiles().then((response) => response.files || []),
    listRemoteFormSyncWorkflows(),
  ])
  const localWorkflows = readTableFileFormSyncWorkflows(files)
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
    const workflow = await createRemoteFormSyncWorkflow(input)
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
    const workflow = await updateRemoteFormSyncWorkflow(id, input)
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
      ? await updateRemoteFormSyncWorkflow(localWorkflow.remote_workflow_id, input)
      : await createRemoteFormSyncWorkflow(toCreateInput(mergedWorkflow, true))
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
  return syncRemoteFormSyncWorkflow(remoteId)
}

function emitFormSyncChanged(workflowId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(FORM_SYNC_CHANGED_EVENT, {
    detail: { workflowId },
  }))
}

async function findLocalWorkflow(id: string) {
  const files = await listTableFiles().then((response) => response.files || [])
  return readTableFileFormSyncWorkflows(files).find((workflow) => workflow.id === id)
}

/** The table an unpublished form keeps its draft in: the one it writes to. */
async function targetTable(workflow: LocalFormSyncWorkflow) {
  const { document_path: path, table_id: tableId } = workflow.target
  const files = await listTableFiles().then((response) => response.files || [])
  const table = files.find((file) => file.path === path)?.tables.find((item) => item.id === tableId)
  if (!path || !table) throw new Error('The form destination table is invalid.')
  return table
}

async function persistLocalWorkflow(workflow: LocalFormSyncWorkflow) {
  const table = await targetTable(workflow)
  await updateTable(
    { path: workflow.target.document_path, tableId: workflow.target.table_id },
    { meta: writeLocalFormSyncWorkflow(table.meta, workflow) },
    'formsync',
  )
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
