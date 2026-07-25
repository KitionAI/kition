import { describe, expect, it } from 'vitest'
import { createWorkflowFromTemplate } from './createWorkflowFromTemplate'
import { getBuiltinTemplates, type WorkflowTemplate } from '@/features/workflow/templates'

const baseTpl: WorkflowTemplate = {
  id: 'demo',
  name: 'Demo',
  description: '',
  icons: [{ kind: 'lucide', name: 'Send' }],
  draft: {
    name: 'Demo',
    description: '',
    trigger: { type: 'record_created' },
    action: {
      type: 'send_email',
      to: '{{me}}',
      subject: 'Hi',
      bodyParts: [
        { kind: 'text', text: 'Hello ' },
        { kind: 'field_ref_by_name', fieldName: 'Name', fallback: 'friend' },
      ],
    },
  },
}

const ctx = {
  documentId: 'd1',
  tableId: 't1',
  tableName: 'Leads',
  schema: { id: 't1', name: 'Leads', fields: [{ id: 'f_name', name: 'Name', type: 'text' }] },
  currentUserEmail: 'me@example.com',
}

describe('createWorkflowFromTemplate', () => {
  it('substitutes {{me}} with currentUserEmail', () => {
    const out = createWorkflowFromTemplate(baseTpl, ctx)
    expect(out.input.action.to).toBe('me@example.com')
  })

  it('falls back to "you@example.com" when {{me}} is unresolved', () => {
    const out = createWorkflowFromTemplate(baseTpl, { ...ctx, currentUserEmail: undefined })
    expect(out.input.action.to).toBe('you@example.com')
  })

  it('resolves field_ref_by_name against schema (case-insensitive)', () => {
    const out = createWorkflowFromTemplate(baseTpl, {
      ...ctx,
      schema: { id: 't1', name: 'Leads', fields: [{ id: 'f_name', name: 'name', type: 'text' }] },
    })
    const fieldPart = out.input.action.body.parts.find((p) => p.kind === 'field_ref')
    expect(fieldPart?.fieldRef?.fieldId).toBe('f_name')
    // Schema matched cleanly → no unresolved hints to surface.
    expect(out.unresolvedFieldNames).toEqual([])
  })

  it('downgrades unresolved field_ref to text fallback and reports the name', () => {
    const out = createWorkflowFromTemplate(baseTpl, {
      ...ctx,
      schema: { id: 't1', name: 'Leads', fields: [] },
    })
    expect(out.input.action.body.parts).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'friend' },
    ])
    // The U4 contract: the field name the template asked for must surface
    // in the result so the caller can banner the user. Silent downgrade is
    // exactly what we're fixing.
    expect(out.unresolvedFieldNames).toEqual(['Name'])
  })

  it('substitutes {{email_field}} with the first email-typed field, falling back to "you@example.com"', () => {
    const tpl = { ...baseTpl, draft: { ...baseTpl.draft, action: { ...baseTpl.draft.action, to: '{{email_field}}' } } }
    const out1 = createWorkflowFromTemplate(tpl, {
      ...ctx,
      schema: { id: 't1', name: 'Leads', fields: [{ id: 'f_email', name: 'Email', type: 'email' }] },
    })
    expect(out1.input.action.to).toBe('you@example.com')  // no email runtime resolution — placeholder used
  })

  it('injects context tableId/documentId and forces enabled=false + empty connectionId', () => {
    const out = createWorkflowFromTemplate(baseTpl, ctx)
    expect(out.input.trigger.tableId).toBe('t1')
    expect(out.input.trigger.documentId).toBe('d1')
    expect(out.input.enabled).toBe(false)
    expect(out.input.action.connectionId).toBe('')
  })

  it('passes through schema=null without throwing and reports every unresolved field', () => {
    const out = createWorkflowFromTemplate(baseTpl, { ...ctx, schema: null })
    expect(out.input.action.body.parts.find((p) => p.kind === 'field_ref')).toBeUndefined()
    // Null schema → every field_ref_by_name fails to bind.
    expect(out.unresolvedFieldNames).toEqual(['Name'])
  })

  it('propagates record_date_reached trigger type through to CreateWorkflowInput', () => {
    // The Feishu-style "At record's trigger time" template lands here with
    // its trigger type set to record_date_reached. The date-field selection
    // happens later in the trigger node's properties drawer (delayed
    // binding), so the freshly-created workflow only needs the type + table
    // binding set — that's what we assert here.
    const dateTpl: WorkflowTemplate = {
      ...baseTpl,
      id: 'date',
      draft: { ...baseTpl.draft, trigger: { type: 'record_date_reached' } },
    }
    const out = createWorkflowFromTemplate(dateTpl, ctx)
    expect(out.input.trigger.type).toBe('record_date_reached')
    expect(out.input.trigger.tableId).toBe('t1')
    expect(out.input.trigger.documentId).toBe('d1')
    expect(out.input.enabled).toBe(false)
  })

  it('emits a scheduled_time trigger with cron and no table binding', () => {
    // The "At scheduled time" trigger fires by clock, not by record event —
    // tableId/documentId stay empty even though the launcher passed them in.
    // The backend's Validate() special-cases scheduled_time to skip the
    // "trigger_table_empty" gate; if we accidentally forwarded the picked
    // tableId, the workflow would still validate but the canvas's "Object"
    // chip would mislead the user into thinking the trigger is bound to a
    // table. So we drop them on purpose.
    const schedTpl: WorkflowTemplate = {
      id: 'sched',
      name: 'Daily 11 AM',
      description: '',
      icons: [{ kind: 'lucide', name: 'AlarmClock' }],
      draft: {
        name: 'Daily 11 AM',
        description: '',
        trigger: { type: 'scheduled_time', schedule: { cron: '0 11 * * *' } },
        action: { type: 'add_record' },
      },
    }
    const out = createWorkflowFromTemplate(schedTpl, ctx)
    expect(out.input.trigger.type).toBe('scheduled_time')
    expect(out.input.trigger.schedule?.cron).toBe('0 11 * * *')
    expect(out.input.trigger.tableId).toBe('')
    expect(out.input.trigger.documentId).toBe('')
  })

  it('emits an add_record action with empty target + fields (delayed binding)', () => {
    // The user picks the target table + per-field assignments in the drawer
    // after creation — same delayed-binding pattern as record_date_reached's
    // date-field selection. The template just sets the action type and
    // ships an empty addRecord payload.
    const schedTpl: WorkflowTemplate = {
      id: 'sched',
      name: 'Daily 11 AM',
      description: '',
      icons: [{ kind: 'lucide', name: 'AlarmClock' }],
      draft: {
        name: 'Daily 11 AM',
        description: '',
        trigger: { type: 'scheduled_time', schedule: { cron: '0 11 * * *' } },
        action: { type: 'add_record' },
      },
    }
    const out = createWorkflowFromTemplate(schedTpl, ctx)
    expect(out.input.action.type).toBe('add_record')
    expect(out.input.action.addRecord?.targetTableId).toBe('')
    expect(out.input.action.addRecord?.fields).toEqual([])
    // Email scaffolding stays empty on add_record actions — the server's
    // Validate() skips the to/subject/body checks for non-email actions.
    expect(out.input.action.to).toBe('')
    expect(out.input.action.subject).toEqual({ parts: [] })
    expect(out.input.action.body.parts).toEqual([])
  })

  it('de-duplicates repeated unresolved field names so the banner stays compact', () => {
    // A template that references the same missing field twice should
    // produce a single entry in unresolvedFieldNames — otherwise the
    // banner would say "Name, Name" which is just noise.
    const tpl: WorkflowTemplate = {
      ...baseTpl,
      draft: {
        ...baseTpl.draft,
        action: {
          ...baseTpl.draft.action,
          type: 'send_email' as const,
          to: '{{me}}',
          subject: 'Hi',
          bodyParts: [
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: 'A' },
            { kind: 'text', text: ' and ' },
            { kind: 'field_ref_by_name', fieldName: 'Name', fallback: 'B' },
          ],
        },
      },
    }
    const out = createWorkflowFromTemplate(tpl, { ...ctx, schema: null })
    expect(out.unresolvedFieldNames).toEqual(['Name'])
  })

  it('fully binds and enables the local Content Ideas to Publishing Queue template', () => {
    const [tpl] = getBuiltinTemplates((key) => key, { tableName: 'Content Ideas' })
    const out = createWorkflowFromTemplate(tpl, {
      documentId: 'doc_content',
      tableId: 'tbl_ideas',
      tableName: 'Content Ideas',
      schema: {
        id: 'tbl_ideas',
        name: 'Content Ideas',
        fields: [
          { id: 'idea', name: 'Idea', type: 'text' },
          { id: 'channel', name: 'Channel', type: 'single_select' },
          { id: 'priority', name: 'Priority', type: 'single_select' },
          { id: 'status', name: 'Status', type: 'single_select' },
        ],
      },
      tables: [{
        documentId: 'doc_content',
        tableId: 'tbl_queue',
        tableName: 'Publishing Queue',
        schema: {
          id: 'tbl_queue',
          name: 'Publishing Queue',
          fields: [
            { id: 'title', name: 'Title', type: 'text' },
            { id: 'queue_channel', name: 'Channel', type: 'single_select' },
            { id: 'queue_priority', name: 'Priority', type: 'single_select' },
            { id: 'source_status', name: 'Source Status', type: 'single_select' },
            { id: 'note', name: 'Automation Note', type: 'long_text' },
          ],
        },
      }],
    })

    expect(out.unresolvedFieldNames).toEqual([])
    expect(out.input.enabled).toBe(true)
    expect(out.input.trigger.requiredFields).toEqual(['idea', 'channel', 'priority', 'status'])
    expect(out.input.action.addRecord?.targetTableId).toBe('tbl_queue')
    expect(out.input.action.addRecord?.fields).toHaveLength(5)
    expect(out.input.action.addRecord?.fields[0]).toEqual({
      fieldId: 'title',
      value: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'idea' } }] },
    })
  })

  it('creates a disabled draft plus an enable-after-filter graph patch', () => {
    const tpl = getBuiltinTemplates((key) => key, { tableName: 'Tasks' })
      .find((item) => item.id === 'archive-completed-tasks')!
    const out = createWorkflowFromTemplate(tpl, {
      documentId: 'doc_tasks',
      tableId: 'tbl_tasks',
      tableName: 'Tasks',
      schema: {
        id: 'tbl_tasks',
        name: 'Tasks',
        fields: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'status', name: 'Status', type: 'single_select' },
          { id: 'due', name: 'Due', type: 'date' },
          { id: 'notes', name: 'Notes', type: 'long_text' },
        ],
      },
      tables: [{
        documentId: 'doc_tasks',
        tableId: 'tbl_completed',
        tableName: 'Completed Tasks',
        schema: {
          id: 'tbl_completed',
          name: 'Completed Tasks',
          fields: [
            { id: 'task', name: 'Task', type: 'text' },
            { id: 'archived_status', name: 'Status', type: 'single_select' },
            { id: 'archived_due', name: 'Due', type: 'date' },
            { id: 'archived_notes', name: 'Notes', type: 'long_text' },
            { id: 'automation_note', name: 'Automation Note', type: 'long_text' },
          ],
        },
      }],
    })

    expect(out.unresolvedFieldNames).toEqual([])
    expect(out.input.enabled).toBe(false)
    expect(out.graphPatch?.enabled).toBe(true)
    expect(out.graphPatch?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'filter_1',
        kind: 'filter',
        config: expect.objectContaining({ expression: 'trigger_1.Status == "Done"' }),
      }),
    ]))
    expect(out.graphPatch?.edges).toEqual([
      { from: 'trigger_1', to: 'filter_1' },
      { from: 'filter_1', to: 'action_1' },
    ])
  })

  it('fully binds the high-value expense update action and its condition', () => {
    const template = getBuiltinTemplates((key) => key, { tableName: 'Expenses' })[0]
    const out = createWorkflowFromTemplate(template, {
      documentId: 'doc_expenses',
      tableId: 'tbl_expenses',
      tableName: 'Expenses',
      schema: {
        id: 'tbl_expenses',
        name: 'Expenses',
        fields: [
          { id: 'expense_amount', name: 'Amount', type: 'number' },
          { id: 'expense_status', name: 'Status', type: 'single_select' },
          { id: 'expense_note', name: 'Review Note', type: 'long_text' },
        ],
      },
    })

    expect(out.unresolvedFieldNames).toEqual([])
    expect(out.input.action.type).toBe('update_record')
    expect(out.input.action.updateRecord?.fields.map((field) => field.fieldId)).toEqual(['expense_status', 'expense_note'])
    expect(out.graphPatch?.enabled).toBe(true)
    expect(out.graphPatch?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'filter', config: expect.objectContaining({ expression: 'trigger_1.Amount > 1000' }) }),
    ]))
  })

  it('fully binds the order catalog lookup and write-back mappings', () => {
    const template = getBuiltinTemplates((key) => key, { tableName: 'Orders' })[0]
    const out = createWorkflowFromTemplate(template, {
      documentId: 'doc_orders',
      tableId: 'tbl_orders',
      tableName: 'Orders',
      schema: {
        id: 'tbl_orders',
        name: 'Orders',
        fields: [
          { id: 'order_sku', name: 'SKU', type: 'text' },
          { id: 'order_product', name: 'Product Name', type: 'text' },
          { id: 'order_price', name: 'Unit Price', type: 'number' },
          { id: 'order_category', name: 'Category', type: 'text' },
        ],
      },
      tables: [{
        documentId: 'doc_orders',
        tableId: 'tbl_catalog',
        tableName: 'Product Catalog',
        schema: {
          id: 'tbl_catalog',
          name: 'Product Catalog',
          fields: [
            { id: 'catalog_sku', name: 'SKU', type: 'text' },
            { id: 'catalog_product', name: 'Product Name', type: 'text' },
            { id: 'catalog_price', name: 'Unit Price', type: 'number' },
            { id: 'catalog_category', name: 'Category', type: 'text' },
          ],
        },
      }],
    })

    expect(out.unresolvedFieldNames).toEqual([])
    expect(out.input.enabled).toBe(true)
    expect(out.input.action.lookupRecord).toEqual({
      targetDocumentId: 'doc_orders',
      targetTableId: 'tbl_catalog',
      matchFieldId: 'catalog_sku',
      matchValue: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'order_sku' } }] },
      writeBack: [
        { sourceFieldId: 'catalog_price', targetFieldId: 'order_price' },
        { sourceFieldId: 'catalog_category', targetFieldId: 'order_category' },
        { sourceFieldId: 'catalog_product', targetFieldId: 'order_product' },
      ],
    })
  })

  it('fully binds the contact cleanup transform operations', () => {
    const template = getBuiltinTemplates((key) => key, { tableName: 'Contacts' })[0]
    const out = createWorkflowFromTemplate(template, {
      documentId: 'doc_contacts',
      tableId: 'tbl_contacts',
      tableName: 'Contacts',
      schema: {
        id: 'tbl_contacts',
        name: 'Contacts',
        fields: [
          { id: 'contact_email', name: 'Email', type: 'text' },
          { id: 'contact_phone', name: 'Phone', type: 'text' },
          { id: 'contact_domain', name: 'Email Domain', type: 'text' },
          { id: 'contact_phone_normalized', name: 'Normalized Phone', type: 'text' },
        ],
      },
    })

    expect(out.unresolvedFieldNames).toEqual([])
    expect(out.input.enabled).toBe(true)
    expect(out.input.action.transformRecord?.operations).toEqual([
      {
        source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'contact_email' } }] },
        operation: 'domain_from_email',
        targetFieldId: 'contact_domain',
      },
      {
        source: { parts: [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'contact_phone' } }] },
        operation: 'digits_only',
        targetFieldId: 'contact_phone_normalized',
      },
    ])
  })
})
