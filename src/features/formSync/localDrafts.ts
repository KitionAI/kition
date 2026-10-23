import type { KitTablesFile } from '@/api/kitTables'

import type { FormSyncWorkflow } from './api'

export const FORM_SYNC_WORKFLOWS_META_KEY = 'form_sync_workflows'

export type LocalFormSyncWorkflow = FormSyncWorkflow & {
  remote_workflow_id?: string
}

export function readLocalFormSyncWorkflows(
  meta?: Record<string, unknown> | null,
): LocalFormSyncWorkflow[] {
  const workflows = meta?.[FORM_SYNC_WORKFLOWS_META_KEY]
  if (!Array.isArray(workflows)) return []
  return workflows.filter(isLocalFormSyncWorkflow)
}

/** The unpublished forms kept in the tables they write to (each table's `form_sync_workflows`). */
export function readTableFileFormSyncWorkflows(
  files: KitTablesFile[],
): LocalFormSyncWorkflow[] {
  return files.flatMap((file) => file.tables.flatMap((table) => readLocalFormSyncWorkflows(table.meta)))
}

export function writeLocalFormSyncWorkflow(
  meta: Record<string, unknown> | null | undefined,
  workflow: LocalFormSyncWorkflow,
): Record<string, unknown> {
  const current = readLocalFormSyncWorkflows(meta)
  const exists = current.some((item) => item.id === workflow.id)
  return {
    ...(meta || {}),
    [FORM_SYNC_WORKFLOWS_META_KEY]: exists
      ? current.map((item) => item.id === workflow.id ? workflow : item)
      : [...current, workflow],
  }
}

export function removeLocalFormSyncWorkflow(
  meta: Record<string, unknown> | null | undefined,
  workflowId: string,
): Record<string, unknown> {
  return {
    ...(meta || {}),
    [FORM_SYNC_WORKFLOWS_META_KEY]: readLocalFormSyncWorkflows(meta)
      .filter((workflow) => workflow.id !== workflowId),
  }
}

function isLocalFormSyncWorkflow(value: unknown): value is LocalFormSyncWorkflow {
  if (!value || typeof value !== 'object') return false
  const workflow = value as Partial<LocalFormSyncWorkflow>
  return typeof workflow.id === 'string'
    && typeof workflow.name === 'string'
    && typeof workflow.template_id === 'string'
    && typeof workflow.published === 'boolean'
    && Array.isArray(workflow.fields)
    && Boolean(workflow.target && typeof workflow.target === 'object')
    && Boolean(workflow.schedule && typeof workflow.schedule === 'object')
}
