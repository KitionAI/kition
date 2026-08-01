import {
  createFormSyncWorkflow,
  type FormSyncField,
} from './api'

export type FormSyncTemplateSetup = {
  type: 'form-sync'
  name: string
  templateId: string
  tableTitle: string
  fields: FormSyncField[]
  fieldMappings: Array<{
    sourceKey: string
    targetFieldTitle: string
  }>
  defaults?: Array<{
    targetFieldTitle: string
    value: unknown
  }>
  submissionIdFieldTitle?: string
  submittedAtFieldTitle?: string
  intervalMinutes: number
}

export async function setupTemplateFormSync({
  documentId,
  tableIdsByTitle,
  setup,
}: {
  documentId: number
  tableIdsByTitle: Record<string, number>
  setup: FormSyncTemplateSetup
}) {
  const tableId = tableIdsByTitle[setup.tableTitle]
  if (tableId == null) {
    throw new Error(`Form sync target table was not created: ${setup.tableTitle}`)
  }
  const workflow = await createFormSyncWorkflow({
    name: setup.name,
    template_id: setup.templateId,
    fields: setup.fields,
    target: {
      document_id: String(documentId),
      table_id: String(tableId),
      field_mappings: setup.fieldMappings.map((mapping) => ({
        source_key: mapping.sourceKey,
        target_field_title: mapping.targetFieldTitle,
      })),
      defaults: setup.defaults?.map((item) => ({
        target_field_title: item.targetFieldTitle,
        value: item.value,
      })),
      submission_id_field_title: setup.submissionIdFieldTitle,
      submitted_at_field_title: setup.submittedAtFieldTitle,
    },
    schedule: {
      enabled: true,
      interval_minutes: setup.intervalMinutes,
    },
    published: false,
  })
  return workflow
}
