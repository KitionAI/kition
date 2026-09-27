/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/form-sync.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type FormSyncFormFieldType = "text" | "email" | "phone" | "number" | "datetime" | "select" | "long_text"

export type FormSyncFormField = {
  key: string
  label: string
  type: FormSyncFormFieldType
  required: boolean
  options?: string[]
}

export type FormSyncFieldMapping = {
  source_key: string
  target_field_title: string
}

export type FormSyncDefaultValue = {
  target_field_title: string
  value: unknown
}

export type FormSyncTarget = {
  document_id: string
  table_id: string
  field_mappings: FormSyncFieldMapping[]
  defaults?: FormSyncDefaultValue[]
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
  public_url: string | ""
  published: boolean
  fields: FormSyncFormField[]
  target: FormSyncTarget
  schedule: FormSyncSchedule
  status: "active" | "paused" | "syncing" | "error"
  last_sync_at?: string
  last_error?: string
  synced_submissions: number
  created_at: string
  updated_at: string
}

export type FormSyncCreateInput = {
  name: string
  template_id: string
  fields: FormSyncFormField[]
  target: FormSyncTarget
  schedule: FormSyncSchedule
  published?: boolean
}

export type FormSyncUpdateInput = {
  name?: string
  fields?: FormSyncFormField[]
  target?: FormSyncTarget
  schedule?: FormSyncSchedule
  published?: boolean
}

export type FormSyncSyncResult = {
  workflow_id: string
  imported: number
  skipped: number
  failed: number
  started_at: string
  finished_at: string
}

export type FormSyncContract = FormSyncWorkflow
