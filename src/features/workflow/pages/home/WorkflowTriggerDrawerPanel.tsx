import { useTranslation } from 'react-i18next'

import type { NodeIssue, WorkflowDefinition } from '@/api/workflows'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { ScheduledTriggerPropertiesPanel } from '@/features/workflow/components/ScheduledTriggerPropertiesPanel'
import { TriggerRequiredFieldsPanel } from '@/features/workflow/components/TriggerRequiredFieldsPanel'
import { TriggerTableSelect } from '@/features/workflow/components/TriggerTableSelect'
import { DrawerField, DrawerSection } from '@/features/workflow/drawer/PropertiesDrawer'
import type { useWorkflowTriggerEditor } from '@/features/workflow/hooks/useWorkflowTriggerEditor'
import { issueMessageFor } from '@/features/workflow/lib/workflowNodePresentation'
import type { TriggerTableOption, WorkflowTriggerType } from '@/features/workflow/lib/workflowPatches'
import { drawerInputClassName } from '@/features/workflow/pages/WorkflowHomePagePrimitives'

const SCHEDULE_CODES = ['trigger_schedule_invalid', 'trigger_schedule_empty']
const TIMEZONE_CODES = ['trigger_schedule_timezone_invalid']

export type WorkflowTriggerDrawerPanelProps = {
  selected: WorkflowDefinition
  saving: boolean
  serverErrors: NodeIssue[]
  tableOptions: TriggerTableOption[]
  schema: TableSchema | null
  editor: ReturnType<typeof useWorkflowTriggerEditor>
}

/** The trigger's drawer: the event picker, then either the cron editor or the table and required-field pickers. Every change commits at once. */
export function WorkflowTriggerDrawerPanel({ selected, saving, serverErrors, tableOptions, schema, editor }: WorkflowTriggerDrawerPanelProps) {
  const { t } = useTranslation('workflow')
  return (
    <DrawerSection title={t('panels.drawer.trigger.section')}>
      <DrawerField label={t('panels.drawer.trigger.eventLabel')}>
        <select
          className={drawerInputClassName}
          value={selected.trigger.type || 'record_created'}
          onChange={(event) => { void editor.setTriggerType(event.target.value as WorkflowTriggerType) }}
          disabled={saving}
          data-testid="workflow-home-trigger-type"
        >
          <option value="record_created">{t('panels.drawer.titles.whenRecordCreated')}</option>
          <option value="record_created_or_updated">{t('panels.drawer.titles.whenRecordCreatedOrUpdated')}</option>
          <option value="record_updated">{t('panels.drawer.titles.whenRecordUpdated')}</option>
          <option value="record_date_reached">{t('panels.drawer.titles.whenRecordDateReached')}</option>
          <option value="scheduled_time">{t('panels.drawer.titles.whenScheduledTime')}</option>
        </select>
      </DrawerField>
      {selected.trigger.type === 'scheduled_time' ? (
        // A clock has no table to bind or filter; the drawer collapses to the cron picker.
        <ScheduledTriggerPropertiesPanel
          cron={selected.trigger.schedule?.cron || ''}
          timezone={selected.trigger.schedule?.timezone}
          onChange={(next) => { void editor.setTriggerSchedule(next) }}
          disabled={saving}
          error={issueMessageFor(serverErrors, SCHEDULE_CODES)}
          timezoneError={issueMessageFor(serverErrors, TIMEZONE_CODES)}
        />
      ) : (
        <>
          <DrawerField
            label={t('panels.drawer.trigger.tableLabel')}
            hint={selected.trigger.tableId ? undefined : t('panels.drawer.trigger.tableHint')}
          >
            <TriggerTableSelect
              value={selected.trigger.tableId || ''}
              options={tableOptions}
              onChange={(nextTableId) => { void editor.setTriggerTable(nextTableId) }}
              disabled={saving}
              testId="workflow-home-trigger-table"
            />
          </DrawerField>
          <DrawerField label={t('panels.drawer.trigger.requiredFieldsLabel')} hint={t('panels.drawer.trigger.requiredFieldsHint')}>
            <TriggerRequiredFieldsPanel
              value={selected.trigger.requiredFields || []}
              schema={schema}
              onChange={(next) => { void editor.setTriggerRequiredFields(next) }}
              disabled={saving}
            />
          </DrawerField>
        </>
      )}
    </DrawerSection>
  )
}
