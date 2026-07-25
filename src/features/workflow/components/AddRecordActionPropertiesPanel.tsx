import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { BodyTemplateEditor } from './BodyTemplateEditor'
import type { BodyTemplate, TableSchema } from './BodyTemplateEditor.types'
import { TriggerTableSelect, type TriggerTableOption } from './TriggerTableSelect'
import { DrawerField, DrawerSection } from '../drawer/PropertiesDrawer'
import type { WorkflowAddRecordConfig } from '../api'

/**
 * AddRecordActionPropertiesPanel edits the `add_record` action's target
 * table + per-field BodyTemplate assignments. The component is fully
 * controlled — the parent owns the draft AddRecordConfig and emits a
 * fresh copy on every edit (matching ScheduledTriggerPropertiesPanel's
 * pattern).
 *
 * Layout mirrors the Feishu Base "Add a record → in target table → fill
 * fields" affordance: a target-table picker at the top, then one row per
 * field in the target table's schema with a BodyTemplateEditor so the
 * user can templatize the value with text + upstream field-ref tokens
 * (the upstream node is the trigger; when the trigger is scheduled_time
 * there's no upstream record so the editor's field-insert picker just
 * exposes an empty schema).
 *
 * Switching target tables WIPES the field assignments — the field IDs
 * belong to the previous table's schema and would silently mismap if we
 * preserved them. We could later add a "migrate by name" heuristic, but
 * for v1 the explicit wipe is clearer than a half-mapped state.
 *
 * Validation: the backend's Validate() emits per-node diagnostics for
 *   - missing targetTableId (`action_add_record_target_missing`)
 *   - no populated field assignments (`action_add_record_fields_empty`)
 * The panel surfaces them through `error` (panel-level, anchored to the
 * target picker), while `fieldErrors` (keyed by fieldId) is reserved for
 * future per-row diagnostics — at the moment the backend doesn't yet
 * pin "empty value" errors to a specific field, so the parent passes
 * the panel-level codes via `error` and leaves `fieldErrors` empty.
 */
export interface AddRecordActionPropertiesPanelProps {
  /** Current add_record config. Pass `null` when the workflow hasn't been
   *  flipped to add_record yet — the panel renders an empty picker. */
  config: WorkflowAddRecordConfig | null
  /** Tables eligible as the target. Same shape as the trigger picker uses. */
  tableOptions: TriggerTableOption[]
  /** Schema of the currently-targeted table. Null while loading or before
   *  a target is picked. */
  targetSchema: TableSchema | null
  /** Source schema for the BodyTemplateEditor's field-insert picker — the
   *  upstream trigger's table. Null when the trigger is scheduled_time
   *  (no upstream row) or before the trigger's schema has loaded. */
  sourceSchema: TableSchema | null
  /** Node ID of the upstream trigger. Required by BodyTemplateEditor when
   *  it inserts field_ref parts. */
  sourceNodeId: string
  /** Display label of the upstream node, used by BodyTemplateEditor's
   *  insert-picker header. */
  sourceNodeTitle: string
  onChange: (next: WorkflowAddRecordConfig) => void
  disabled?: boolean
  /** Panel-level server error (e.g. target_table_missing). */
  error?: string
  /** Per-field server errors keyed by fieldId. */
  fieldErrors?: Record<string, string>
  /** Trigger's bound tableId, used to detect the same-table loop case.
   *  When this matches `config.targetTableId` the panel renders an amber
   *  warning — the backend's Validate() also blocks Save with
   *  `add_record_target_equals_trigger_table`, but the inline warning
   *  shows up before the user even tries to Save. Pass undefined when the
   *  trigger has no table (e.g. scheduled_time) — the warning never fires. */
  triggerTableId?: string
}

const EMPTY_SCHEMA: TableSchema = { id: '', name: '', fields: [] }

export function AddRecordActionPropertiesPanel({
  config,
  tableOptions,
  targetSchema,
  sourceSchema,
  sourceNodeId,
  sourceNodeTitle,
  onChange,
  disabled,
  error,
  fieldErrors,
  triggerTableId,
}: AddRecordActionPropertiesPanelProps) {
  const { t } = useTranslation('workflow')
  const targetTableId = config?.targetTableId || ''
  const isLoopback = Boolean(
    triggerTableId && targetTableId && triggerTableId === targetTableId,
  )
  // valueByFieldId gives the BodyTemplateEditor a stable per-field reference
  // without forcing the parent to maintain a sparse fields array (the
  // controlled component pattern stays clean: parent stores only the
  // populated entries, the panel fills in empties at render time).
  const valueByFieldId = useMemo(() => {
    const map = new Map<string, BodyTemplate>()
    for (const entry of config?.fields || []) {
      map.set(entry.fieldId, entry.value)
    }
    return map
  }, [config])

  function handleTargetTableChange(nextTableId: string) {
    // Wipe the fields array — the previous table's field IDs don't apply
    // to the new schema. The parent's onChange handler resolves
    // `targetDocumentId` from its own tableLabels map (it owns the
    // documentId lookup, not this panel), so we emit just the targetTableId
    // here and let the parent fill in the rest.
    onChange({
      targetTableId: nextTableId,
      fields: [],
    })
  }

  function handleFieldValueChange(fieldId: string, value: BodyTemplate) {
    const existing = config?.fields || []
    const without = existing.filter((entry) => entry.fieldId !== fieldId)
    // Drop fields whose template went empty (no parts) — keeps the wire
    // payload tight and lets validateDraft easily check "at least one
    // populated field".
    const next = value.parts.length === 0 ? without : [...without, { fieldId, value }]
    onChange({
      targetTableId: config?.targetTableId || '',
      targetDocumentId: config?.targetDocumentId,
      fields: next,
    })
  }

  return (
    <DrawerSection title={t('panels.addRecord.section')}>
      <DrawerField
        label={t('panels.addRecord.targetTableLabel')}
        hint={targetTableId ? undefined : t('panels.addRecord.targetTableHint')}
        error={error}
      >
        <TriggerTableSelect
          value={targetTableId}
          options={tableOptions}
          onChange={handleTargetTableChange}
          disabled={disabled}
          draftLabel={t('panels.addRecord.targetTableDraftLabel')}
          testId="add-record-target-table"
        />
      </DrawerField>

      {isLoopback ? (
        <div
          data-testid="add-record-loop-warning"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          <strong className="font-semibold">{t('panels.addRecord.loopWarningBold')}</strong>{' '}
          {t('panels.addRecord.loopWarningBody')}
        </div>
      ) : null}

      {targetTableId && targetSchema && targetSchema.fields.length > 0 ? (
        <div className="grid gap-3" data-testid="add-record-field-rows">
          {targetSchema.fields.map((field) => (
            <DrawerField
              key={field.id}
              label={field.name}
              hint={field.type}
              error={fieldErrors?.[field.id]}
            >
              <BodyTemplateEditor
                template={valueByFieldId.get(field.id) || { parts: [] }}
                schema={sourceSchema || EMPTY_SCHEMA}
                triggerNodeTitle={sourceNodeTitle}
                triggerNodeId={sourceNodeId}
                readOnly={Boolean(disabled)}
                onChange={(next) => handleFieldValueChange(field.id, next)}
              />
            </DrawerField>
          ))}
        </div>
      ) : targetTableId ? (
        // Target picked but schema not yet loaded (or table has no fields).
        // The placeholder keeps the layout from collapsing while the fetch
        // is in flight and gives the user a hint when the table really is
        // empty (rare but possible during a wipe + redefine).
        <div
          className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground"
          data-testid="add-record-field-rows-empty"
        >
          {targetSchema ? t('panels.addRecord.noFields') : t('panels.addRecord.loadingFields')}
        </div>
      ) : null}
    </DrawerSection>
  )
}
