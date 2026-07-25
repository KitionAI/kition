import { Plus, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  WorkflowLookupRecordConfig,
  WorkflowTransformRecordConfig,
  WorkflowTransformOperation,
  WorkflowUpdateRecordConfig,
} from '@/features/workflow/api'
import { DrawerField, DrawerSection } from '@/features/workflow/drawer/PropertiesDrawer'

import { BodyTemplateEditor } from './BodyTemplateEditor'
import type { BodyTemplate, TableSchema } from './BodyTemplateEditor.types'
import { TriggerTableSelect, type TriggerTableOption } from './TriggerTableSelect'

type Props = {
  actionType: 'update_record' | 'lookup_record' | 'transform_record'
  updateRecord?: WorkflowUpdateRecordConfig
  lookupRecord?: WorkflowLookupRecordConfig
  transformRecord?: WorkflowTransformRecordConfig
  sourceSchema: TableSchema
  sourceNodeId: string
  tableOptions: TriggerTableOption[]
  schemaByTableId: Record<string, TableSchema>
  onUpdateRecordChange: (config: WorkflowUpdateRecordConfig) => void
  onLookupRecordChange: (config: WorkflowLookupRecordConfig) => void
  onTransformRecordChange: (config: WorkflowTransformRecordConfig) => void
  error?: string
}

const operationKeys: WorkflowTransformOperation['operation'][] = [
  'trim', 'lowercase', 'uppercase', 'digits_only', 'domain_from_email', 'concat', 'number_add', 'number_multiply',
]

export function RecordActionPropertiesPanel(props: Props) {
  if (props.actionType === 'update_record') return <UpdateRecordPanel {...props} />
  if (props.actionType === 'lookup_record') return <LookupRecordPanel {...props} />
  return <TransformRecordPanel {...props} />
}

function UpdateRecordPanel({ updateRecord, sourceSchema, sourceNodeId, onUpdateRecordChange, error }: Props) {
  const { t } = useTranslation('workflow')
  const values = useMemo(() => new Map((updateRecord?.fields || []).map((item) => [item.fieldId, item.value])), [updateRecord])
  function setField(fieldId: string, value: BodyTemplate) {
    const rest = (updateRecord?.fields || []).filter((item) => item.fieldId !== fieldId)
    onUpdateRecordChange({ target: 'trigger_record', fields: value.parts.length ? [...rest, { fieldId, value }] : rest })
  }
  return (
    <DrawerSection title={t('panels.recordActions.update.section')}>
      <p className="m-0 text-xs text-muted-foreground">{t('panels.recordActions.update.description')}</p>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      <div className="grid gap-3" data-testid="update-record-fields">
        {sourceSchema.fields.map((field) => (
          <DrawerField key={field.id} label={field.name} hint={field.type}>
            <BodyTemplateEditor
              template={values.get(field.id) || { parts: [] }}
              schema={sourceSchema}
              triggerNodeId={sourceNodeId}
              triggerNodeTitle={t('panels.recordActions.triggerRecord')}
              readOnly={false}
              onChange={(value) => setField(field.id, value)}
            />
          </DrawerField>
        ))}
      </div>
    </DrawerSection>
  )
}

function LookupRecordPanel({ lookupRecord, sourceSchema, sourceNodeId, tableOptions, schemaByTableId, onLookupRecordChange, error }: Props) {
  const { t } = useTranslation('workflow')
  const targetSchema = schemaByTableId[lookupRecord?.targetTableId || '']
  const config: WorkflowLookupRecordConfig = lookupRecord || {
    targetTableId: '', matchFieldId: '', matchValue: { parts: [] }, writeBack: [],
  }
  function change(patch: Partial<WorkflowLookupRecordConfig>) {
    onLookupRecordChange({ ...config, ...patch })
  }
  return (
    <DrawerSection title={t('panels.recordActions.lookup.section')}>
      <DrawerField label={t('panels.recordActions.lookup.table')} error={error}>
        <TriggerTableSelect
          value={config.targetTableId}
          options={tableOptions}
          onChange={(targetTableId) => change({ targetTableId, matchFieldId: '', writeBack: [] })}
          draftLabel={t('panels.recordActions.lookup.tablePlaceholder')}
          testId="lookup-record-target-table"
        />
      </DrawerField>
      {targetSchema ? (
        <>
          <DrawerField label={t('panels.recordActions.lookup.matchField')}>
            <select className={inputClass} value={config.matchFieldId} onChange={(event) => change({ matchFieldId: event.target.value })} data-testid="lookup-record-match-field">
              <option value="">{t('panels.recordActions.lookup.fieldPlaceholder')}</option>
              {targetSchema.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </DrawerField>
          <DrawerField label={t('panels.recordActions.lookup.matchValue')}>
            <BodyTemplateEditor
              template={config.matchValue}
              schema={sourceSchema}
              triggerNodeId={sourceNodeId}
              triggerNodeTitle={t('panels.recordActions.triggerRecord')}
              readOnly={false}
              onChange={(matchValue) => change({ matchValue })}
            />
          </DrawerField>
          <div className="grid gap-2" data-testid="lookup-record-writeback">
            {config.writeBack.map((mapping, index) => (
              <div key={`${index}-${mapping.sourceFieldId}-${mapping.targetFieldId}`} className="grid grid-cols-[1fr_20px_1fr_32px] items-center gap-2">
                <select className={inputClass} value={mapping.sourceFieldId} onChange={(event) => change({ writeBack: config.writeBack.map((item, itemIndex) => itemIndex === index ? { ...item, sourceFieldId: event.target.value } : item) })}>
                  <option value="">{t('panels.recordActions.lookup.sourceField')}</option>
                  {targetSchema.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
                </select>
                <span className="text-center text-muted-foreground">→</span>
                <select className={inputClass} value={mapping.targetFieldId} onChange={(event) => change({ writeBack: config.writeBack.map((item, itemIndex) => itemIndex === index ? { ...item, targetFieldId: event.target.value } : item) })}>
                  <option value="">{t('panels.recordActions.lookup.targetField')}</option>
                  {sourceSchema.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
                </select>
                <IconButton label={t('panels.recordActions.remove')} onClick={() => change({ writeBack: config.writeBack.filter((_, itemIndex) => itemIndex !== index) })} />
              </div>
            ))}
            <button type="button" className={addButtonClass} data-testid="lookup-record-add-mapping" onClick={() => change({ writeBack: [...config.writeBack, { sourceFieldId: '', targetFieldId: '' }] })}>
              <Plus className="size-4" /> {t('panels.recordActions.lookup.addMapping')}
            </button>
          </div>
        </>
      ) : null}
    </DrawerSection>
  )
}

function TransformRecordPanel({ transformRecord, sourceSchema, sourceNodeId, onTransformRecordChange, error }: Props) {
  const { t } = useTranslation('workflow')
  const operations = transformRecord?.operations || []
  function replace(index: number, next: WorkflowTransformOperation) {
    onTransformRecordChange({ operations: operations.map((item, itemIndex) => itemIndex === index ? next : item) })
  }
  return (
    <DrawerSection title={t('panels.recordActions.transform.section')}>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      <div className="grid gap-3" data-testid="transform-record-operations">
        {operations.map((operation, index) => (
          <div key={index} className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>{t('panels.recordActions.transform.operation', { index: index + 1 })}</span>
              <IconButton label={t('panels.recordActions.remove')} onClick={() => onTransformRecordChange({ operations: operations.filter((_, itemIndex) => itemIndex !== index) })} />
            </div>
            <BodyTemplateEditor
              template={operation.source}
              schema={sourceSchema}
              triggerNodeId={sourceNodeId}
              triggerNodeTitle={t('panels.recordActions.triggerRecord')}
              readOnly={false}
              onChange={(source) => replace(index, { ...operation, source })}
            />
            <select className={inputClass} value={operation.operation} onChange={(event) => replace(index, { ...operation, operation: event.target.value as WorkflowTransformOperation['operation'] })}>
              {operationKeys.map((key) => <option key={key} value={key}>{t(`panels.recordActions.transform.operations.${key}`)}</option>)}
            </select>
            {['concat', 'number_add', 'number_multiply'].includes(operation.operation) ? (
              <input className={inputClass} value={operation.argument || ''} onChange={(event) => replace(index, { ...operation, argument: event.target.value })} placeholder={t('panels.recordActions.transform.argument')} />
            ) : null}
            <select className={inputClass} value={operation.targetFieldId} onChange={(event) => replace(index, { ...operation, targetFieldId: event.target.value })}>
              <option value="">{t('panels.recordActions.transform.targetField')}</option>
              {sourceSchema.fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </div>
        ))}
        <button type="button" className={addButtonClass} data-testid="transform-record-add-operation" onClick={() => onTransformRecordChange({ operations: [...operations, { source: { parts: [] }, operation: 'trim', targetFieldId: '' }] })}>
          <Plus className="size-4" /> {t('panels.recordActions.transform.addOperation')}
        </button>
      </div>
    </DrawerSection>
  )
}

function IconButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className="inline-grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><Trash2 className="size-4" /></button>
}

const inputClass = 'h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary'
const addButtonClass = 'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-foreground hover:bg-muted'
