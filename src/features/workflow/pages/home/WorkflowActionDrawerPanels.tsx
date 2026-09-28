import { LoaderCircle, Play, Plus, Send } from 'lucide-react'
import { InlineError } from '@/components/states'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import type { ConnectionView } from '@/api/connections'
import type { NodeIssue, WorkflowDefinition } from '@/api/workflows'
import { Button } from '@/components/ui'
import { AddRecordActionPropertiesPanel } from '@/features/workflow/components/AddRecordActionPropertiesPanel'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { RecordActionPropertiesPanel } from '@/features/workflow/components/RecordActionPropertiesPanel'
import { SampleRowPicker } from '@/features/workflow/components/SampleRowPicker'
import { TemplateTokenInput } from '@/features/workflow/components/TemplateTokenInput'
import { DrawerField, DrawerSection } from '@/features/workflow/drawer/PropertiesDrawer'
import type { useWorkflowNodeTest } from '@/features/workflow/hooks/useWorkflowNodeTest'
import type { useWorkflowSendTest } from '@/features/workflow/hooks/useWorkflowSendTest'
import { parseIdAsNumber, type ValidationErrors, type WorkflowDraft } from '@/features/workflow/lib/workflowDraft'
import { DEFAULT_ACTION_NODE_ID, type TriggerTableOption } from '@/features/workflow/lib/workflowPatches'
import { drawerInputClassName } from '@/features/workflow/pages/WorkflowHomePagePrimitives'

type NodeTest = ReturnType<typeof useWorkflowNodeTest>
type SendTest = ReturnType<typeof useWorkflowSendTest>

/** State every action panel shares. */
export type WorkflowActionPanelContext = {
  selected: WorkflowDefinition
  draft: WorkflowDraft
  setDraft: Dispatch<SetStateAction<WorkflowDraft>>
  validation: ValidationErrors
  serverErrors: NodeIssue[]
  saving: boolean
  /** Unsaved edits block node tests, which run against the saved workflow. */
  dirty: boolean
  hasValidationErrors: boolean
  schema: TableSchema | null
  schemaByTableId: Record<string, TableSchema>
  tableOptions: TriggerTableOption[]
  nodeTest: NodeTest
}

const ADD_RECORD_CODES = ['action_add_record_target_missing', 'action_add_record_fields_empty', 'add_record_target_equals_trigger_table']

function NodeTestOutcome({ nodeTest, successMessage, testIdPrefix }: { nodeTest: NodeTest; successMessage: string; testIdPrefix: string }) {
  return (
    <>
      {nodeTest.status === 'done' ? (
        <div data-testid={`${testIdPrefix}-status`} className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground">
          {successMessage}
        </div>
      ) : null}
      {nodeTest.status === 'error' ? (
        <InlineError size="xs" className="mt-2" message={nodeTest.error} data-testid={`${testIdPrefix}-error`} />
      ) : null}
    </>
  )
}

export function WorkflowAddRecordDrawerPanel({ context, targetLabel }: { context: WorkflowActionPanelContext; targetLabel: string }) {
  const { t } = useTranslation('workflow')
  const { selected, draft, setDraft, nodeTest } = context
  const actionNodeId = selected.action.nodeId || DEFAULT_ACTION_NODE_ID
  const testBlocked = nodeTest.status === 'running' || context.hasValidationErrors || context.dirty
  const scheduled = selected.trigger.type === 'scheduled_time'
  const created = nodeTest.status === 'done' && nodeTest.result?.output?.recordId
  return (
    <>
      <AddRecordActionPropertiesPanel
        config={draft.addRecord || null}
        tableOptions={context.tableOptions}
        targetSchema={draft.addRecord?.targetTableId ? context.schemaByTableId[draft.addRecord.targetTableId] || null : null}
        sourceSchema={context.schema}
        sourceNodeId={selected.trigger.nodeId || 'trigger_1'}
        sourceNodeTitle="1. Trigger"
        triggerTableId={selected.trigger.tableId}
        onChange={(next) => setDraft((current) => ({ ...current, addRecord: next }))}
        disabled={context.saving}
        error={(context.validation.addRecordTarget ? t(`panels.home.validation.${context.validation.addRecordTarget}`) : '')
          || context.serverErrors.find((issue) => ADD_RECORD_CODES.includes(issue.code))?.message}
      />
      <DrawerSection title={t('panels.addRecord.testSection')}>
        <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="workflow-add-record-test-step">
          <p className="m-0 text-xs text-muted-foreground">
            {scheduled ? t('panels.addRecord.scheduledTestDescription', { target: targetLabel }) : t('panels.addRecord.testDescription', { target: targetLabel })}
          </p>
          <div className="mt-2">
            {scheduled ? (
              <Button variant="outline" size="sm" data-testid="workflow-add-record-run-now" disabled={testBlocked} onClick={() => { void nodeTest.run(selected.id, actionNodeId) }}>
                {nodeTest.status === 'running' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                {t('panels.addRecord.runNow')}
              </Button>
            ) : (
              <SampleRowPicker
                documentId={parseIdAsNumber(selected.trigger.documentId)}
                tableId={parseIdAsNumber(selected.trigger.tableId)}
                disabled={testBlocked}
                onPick={(values) => { void nodeTest.run(selected.id, actionNodeId, { triggerFields: values }) }}
              />
            )}
          </div>
          {context.dirty ? <p className="mt-2 text-[11px] text-warning-foreground">{t('panels.addRecord.saveBeforeTest')}</p> : null}
          {created ? (
            <div data-testid="workflow-add-record-test-status" className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground">
              {t('panels.addRecord.testCreated', { target: targetLabel, recordId: nodeTest.result?.output?.recordId })}
            </div>
          ) : null}
          {nodeTest.status === 'error' ? (
            <InlineError size="xs" className="mt-2" message={nodeTest.error} data-testid="workflow-add-record-test-error" />
          ) : null}
        </div>
      </DrawerSection>
    </>
  )
}

export function WorkflowRecordActionDrawerPanel({ context }: { context: WorkflowActionPanelContext }) {
  const { t } = useTranslation('workflow')
  const { selected, draft, setDraft, nodeTest } = context
  const actionNodeId = selected.action.nodeId || DEFAULT_ACTION_NODE_ID
  return (
    <>
      <RecordActionPropertiesPanel
        actionType={draft.actionType as 'update_record' | 'lookup_record' | 'transform_record'}
        updateRecord={draft.updateRecord}
        lookupRecord={draft.lookupRecord}
        transformRecord={draft.transformRecord}
        sourceSchema={context.schema}
        sourceNodeId={selected.trigger.nodeId || 'trigger_1'}
        tableOptions={context.tableOptions}
        schemaByTableId={context.schemaByTableId}
        onUpdateRecordChange={(updateRecord) => setDraft((current) => ({ ...current, updateRecord }))}
        onLookupRecordChange={(lookupRecord) => setDraft((current) => ({ ...current, lookupRecord }))}
        onTransformRecordChange={(transformRecord) => setDraft((current) => ({ ...current, transformRecord }))}
        error={context.validation.recordAction ? t(`panels.home.validation.${context.validation.recordAction}`) : ''}
      />
      <DrawerSection title={t('panels.recordActions.testSection')}>
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="m-0 text-xs text-muted-foreground">{t('panels.recordActions.testDescription')}</p>
          <div className="mt-2">
            <SampleRowPicker
              documentId={parseIdAsNumber(selected.trigger.documentId)}
              tableId={parseIdAsNumber(selected.trigger.tableId)}
              disabled={nodeTest.status === 'running' || context.hasValidationErrors || context.dirty}
              onPick={(values, record) => { void nodeTest.run(selected.id, actionNodeId, { triggerFields: values, recordId: String(record.id) }) }}
            />
          </div>
          <NodeTestOutcome
            nodeTest={nodeTest}
            successMessage={nodeTest.result?.output?.matched === false ? t('panels.recordActions.noMatch') : t('panels.recordActions.testUpdated')}
            testIdPrefix="workflow-record-action-test"
          />
        </div>
      </DrawerSection>
    </>
  )
}

export type WorkflowEmailDrawerPanelProps = {
  context: WorkflowActionPanelContext
  connections: ConnectionView[]
  onNewConnection: () => void
  onEditConnection: (connectionId: string) => void
  sendTest: SendTest
  onSendInlineTest: () => void
  /** Name of the bound table for the test step copy. */
  tableLabel: string
}

export function WorkflowEmailDrawerPanel({ context, connections, onNewConnection, onEditConnection, sendTest, onSendInlineTest, tableLabel }: WorkflowEmailDrawerPanelProps) {
  const { t } = useTranslation('workflow')
  const { selected, draft, setDraft, validation, nodeTest } = context
  const unbound = !selected.trigger.tableId
  const pickTableHint = unbound ? t('panels.drawer.email.pickTableFirstHint') : undefined
  const pickTablePlaceholder = unbound ? t('panels.drawer.email.pickTableFirstPlaceholder') : undefined
  return (
    <>
      <DrawerSection title={t('panels.drawer.channel.section')}>
        <DrawerField
          label={t('panels.drawer.channel.connectionLabel')}
          action={(
            <button type="button" className="inline-flex items-center gap-1 text-[11px] font-medium text-primary" onClick={onNewConnection} data-testid="workflow-home-new-connection">
              <Plus className="size-3" />
              {t('panels.drawer.channel.newConnection')}
            </button>
          )}
        >
          <select
            className={drawerInputClassName}
            value={draft.connectionId}
            onChange={(event) => setDraft((current) => ({ ...current, connectionId: event.target.value }))}
            data-testid="workflow-home-connection"
          >
            <option value="">{t('panels.home.nodeCard.noConnectionSelected')}</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} - {String(connection.settings.from || connection.settings.host || 'Email SMTP')}
              </option>
            ))}
          </select>
          {draft.connectionId ? (
            <div className="mt-1 flex gap-2 text-[11px]">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground hover:bg-muted"
                onClick={() => onEditConnection(draft.connectionId)}
                data-testid="workflow-home-edit-connection"
              >
                {t('panels.drawer.channel.editConnection')}
              </button>
            </div>
          ) : null}
        </DrawerField>
      </DrawerSection>

      <DrawerSection title={t('panels.drawer.email.section')}>
        <DrawerField
          label={t('panels.drawer.email.toLabel')}
          error={validation.to ? t(`panels.home.validation.${validation.to}`) : ''}
          action={(
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary"
              onClick={onSendInlineTest}
              disabled={sendTest.status === 'running' || Boolean(validation.to)}
              data-testid="workflow-home-send-test"
            >
              {sendTest.status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : <Send className="size-3" />}
              {t('panels.drawer.email.sendTestEmail')}
            </button>
          )}
        >
          <input className={drawerInputClassName} value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} data-testid="workflow-home-to" />
        </DrawerField>
        {sendTest.status === 'done' && sendTest.result ? (
          <div data-testid="send-test-status" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success-foreground">
            {t('panels.drawer.email.testDelivered', { to: sendTest.result.input.to })}
          </div>
        ) : null}
        {sendTest.status === 'error' ? (
          <InlineError size="sm" message={sendTest.error} data-testid="send-test-error" />
        ) : null}
        <DrawerField label={t('panels.drawer.email.subjectLabel')} hint={pickTableHint} error={validation.subject ? t(`panels.home.validation.${validation.subject}`) : ''}>
          <TemplateTokenInput
            value={draft.subject}
            schema={context.schema}
            triggerNodeId={selected.trigger.nodeId}
            triggerNodeTitle="1. Trigger"
            multiline={false}
            testId="workflow-home-subject"
            disabled={unbound}
            placeholder={pickTablePlaceholder}
            onChange={(subject) => setDraft((current) => ({ ...current, subject }))}
          />
        </DrawerField>
        <DrawerField label={t('panels.drawer.email.bodyLabel')} hint={pickTableHint || t('panels.drawer.email.bodyHint')} error={validation.body ? t(`panels.home.validation.${validation.body}`) : ''}>
          <TemplateTokenInput
            value={draft.body}
            schema={context.schema}
            triggerNodeId={selected.trigger.nodeId}
            triggerNodeTitle="1. Trigger"
            multiline
            testId="workflow-home-body"
            disabled={unbound}
            placeholder={pickTablePlaceholder}
            onChange={(body) => setDraft((current) => ({ ...current, body }))}
          />
        </DrawerField>
      </DrawerSection>

      <DrawerSection title={t('panels.drawer.testStep.section')}>
        <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="workflow-drawer-test-step">
          <p className="m-0 text-xs text-muted-foreground">
            {t('panels.drawer.testStep.descriptionPre')}{tableLabel}{t('panels.drawer.testStep.descriptionMid')}<code className="rounded bg-card px-1 py-0.5 text-[10px] text-primary">manual.test</code>{t('panels.drawer.testStep.descriptionPost')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              className="h-8 bg-primary px-3 hover:bg-primary/90"
              onClick={() => void nodeTest.run(selected.id, selected.action.nodeId || DEFAULT_ACTION_NODE_ID, { to: draft.to })}
              disabled={nodeTest.status === 'running' || Boolean(validation.to)}
              data-testid="workflow-drawer-run-with-sample"
            >
              {nodeTest.status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}
              {t('panels.drawer.testStep.runWithSample')}
            </Button>
          </div>
          {nodeTest.status === 'done' && nodeTest.result?.input ? (
            <div data-testid="workflow-drawer-test-step-status" className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground">
              {t('panels.drawer.testStep.testDelivered', { to: nodeTest.result.input.to })}
            </div>
          ) : null}
          {nodeTest.status === 'error' ? (
            <InlineError size="xs" className="mt-2" message={nodeTest.error} data-testid="workflow-drawer-test-step-error" />
          ) : null}
        </div>
      </DrawerSection>
    </>
  )
}
