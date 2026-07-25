import { describe, expect, it } from 'vitest'

import type { ConnectionView } from '@/features/connections/api'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowDefinition } from '@/features/workflow/api'

import {
  actionInlineError,
  actionNodeDescription,
  actionStatus,
  changedFields,
  cloneAddRecord,
  cloneBody,
  draftsEqual,
  draftToValidationPatch,
  emptyDraft,
  fallbackSchemaFromWorkflow,
  filterNodeDescription,
  filterNodeStatus,
  filterNodeTitle,
  resolveWorkflowKitablePath,
  toDraft,
  triggerLabel,
  triggerStatus,
  validateDraft,
  workflowStatus,
  type TableLabel,
  type WorkflowDraft,
} from './workflowDraft'

const baseWorkflow: WorkflowDefinition = {
  id: 'wf_1',
  name: 'Sample',
  description: '',
  enabled: false,
  trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
  action: {
    nodeId: 'action_1',
    type: 'send_email',
    connectionId: 'conn_1',
    to: 'ops@example.com',
    subject: { parts: [{ kind: 'text' as const, text: 'New lead' }] },
    body: { parts: [{ kind: 'text', text: 'hello' }] },
  },
} as any

describe('resolveWorkflowKitablePath', () => {
  const labels: Record<string, TableLabel> = {
    tbl_leads: {
      tableName: 'Leads',
      documentTitle: 'CRM',
      documentId: 'doc_1',
      documentPath: 'CRM.kitable',
    },
    tbl_queue: {
      tableName: 'Queue',
      documentTitle: 'Publishing',
      documentId: 'doc_2',
      documentPath: 'Publishing.kitable',
    },
  }

  it('uses the trigger document for record workflows', () => {
    expect(resolveWorkflowKitablePath(baseWorkflow, labels)).toBe('CRM.kitable')
  })

  it('uses the add-record target for scheduled workflows without a trigger document', () => {
    const workflow = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, type: 'scheduled_time', documentId: '', tableId: '' },
      action: {
        ...baseWorkflow.action,
        type: 'add_record',
        addRecord: {
          targetDocumentId: 'doc_2',
          targetTableId: 'tbl_queue',
          fields: [],
        },
      },
    } as WorkflowDefinition

    expect(resolveWorkflowKitablePath(workflow, labels)).toBe('Publishing.kitable')
  })

  it('falls back to table labels for older workflows without document ids', () => {
    const workflow = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, documentId: '', tableId: 'tbl_leads' },
    } as WorkflowDefinition

    expect(resolveWorkflowKitablePath(workflow, labels)).toBe('CRM.kitable')
  })
})

describe('emptyDraft', () => {
  it('seeds send_email defaults with empty fields and an empty body', () => {
    const d = emptyDraft()
    expect(d.actionType).toBe('send_email')
    expect(d.body.parts).toEqual([])
    expect(d.to).toBe('')
  })
})

describe('toDraft', () => {
  it('maps a saved workflow into the draft shape with cloned body parts', () => {
    const d = toDraft(baseWorkflow)
    expect(d.actionType).toBe('send_email')
    expect(d.to).toBe('ops@example.com')
    expect(d.body.parts).toEqual([{ kind: 'text', text: 'hello' }])
    // Body is cloned, not aliased — so mutations on the draft don't leak
    // into the workflow snapshot the page also holds.
    expect(d.body).not.toBe(baseWorkflow.action.body)
  })

  it('clones add_record config when the action type is add_record', () => {
    const wf: WorkflowDefinition = {
      ...baseWorkflow,
      action: {
        ...baseWorkflow.action,
        type: 'add_record',
        addRecord: {
          targetTableId: 'tbl_dst',
          fields: [
            { fieldId: 'f_name', value: { parts: [{ kind: 'text', text: 'x' }] } },
          ],
        },
      },
    } as any
    const d = toDraft(wf)
    expect(d.actionType).toBe('add_record')
    expect(d.addRecord?.targetTableId).toBe('tbl_dst')
    expect(d.addRecord?.fields[0].value).not.toBe(wf.action.addRecord?.fields[0].value)
  })
})

describe('cloneBody / cloneAddRecord', () => {
  it('cloneBody deep-clones text, newline, and field_ref parts', () => {
    const original = {
      parts: [
        { kind: 'text', text: 'hi' },
        { kind: 'newline' },
        { kind: 'field_ref', fieldRef: { nodeId: 't_1', fieldId: 'f_x' } },
      ],
    }
    const next = cloneBody(original as any)
    expect(next).toEqual(original)
    expect(next).not.toBe(original)
    expect(next.parts[0]).not.toBe(original.parts[0])
  })

  it('cloneAddRecord clones the fields array and each per-field BodyTemplate', () => {
    const original = {
      targetTableId: 'tbl_dst',
      fields: [
        { fieldId: 'f_a', value: { parts: [{ kind: 'text', text: 'a' }] } },
      ],
    }
    const next = cloneAddRecord(original as any)
    expect(next).toEqual(original)
    expect(next.fields).not.toBe(original.fields)
    expect(next.fields[0].value).not.toBe(original.fields[0].value)
  })
})

describe('draftsEqual / changedFields', () => {
  function makeDraft(over: Partial<WorkflowDraft> = {}): WorkflowDraft {
    return {
      name: 'A',
      description: '',
      actionType: 'send_email',
      connectionId: 'c1',
      to: 'a@b',
      subject: { parts: [{ kind: 'text' as const, text: 's' }] },
      body: { parts: [] },
      ...over,
    }
  }

  it('reports identical drafts as equal and no changed fields', () => {
    expect(draftsEqual(makeDraft(), makeDraft())).toBe(true)
    expect(changedFields(makeDraft(), makeDraft())).toEqual([])
  })

  it('detects single-field changes and lists them in display order', () => {
    const a = makeDraft()
    const b = makeDraft({ name: 'B', to: 'b@b' })
    expect(draftsEqual(a, b)).toBe(false)
    expect(changedFields(a, b)).toEqual(['Name', 'To'])
  })

  it('treats body part edits as a Body change', () => {
    const a = makeDraft({ body: { parts: [{ kind: 'text', text: 'one' }] } })
    const b = makeDraft({ body: { parts: [{ kind: 'text', text: 'two' }] } })
    expect(changedFields(a, b)).toEqual(['Body'])
  })
})

describe('validateDraft', () => {
  function send(over: Partial<WorkflowDraft> = {}): WorkflowDraft {
    return {
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: '',
      to: 'a@b.com',
      subject: { parts: [{ kind: 'text' as const, text: 'S' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
      ...over,
    }
  }

  it('flags missing name', () => {
    expect(validateDraft(send({ name: '   ' })).name).toBe('nameRequired')
  })

  it('rejects malformed recipients on send_email', () => {
    expect(validateDraft(send({ to: 'not-an-email' })).to).toBe('recipientInvalid')
    expect(validateDraft(send({ to: '' })).to).toBe('recipientRequired')
  })

  it('requires a subject and a body for send_email', () => {
    expect(validateDraft(send({ subject: { parts: [{ kind: 'text' as const, text: '' }] } })).subject).toBe('subjectRequired')
    expect(validateDraft(send({ body: { parts: [] } })).body).toBe('bodyRequired')
  })

  it('only checks the add_record target when actionType is add_record', () => {
    const errs = validateDraft({
      name: 'Y',
      description: '',
      actionType: 'add_record',
      connectionId: '',
      to: '',
      subject: { parts: [{ kind: 'text' as const, text: '' }] },
      body: { parts: [] },
    })
    expect(errs.addRecordTarget).toBe('addRecordTargetRequired')
    expect(errs.to).toBeUndefined()
    expect(errs.subject).toBeUndefined()
    expect(errs.body).toBeUndefined()
  })
})

describe('draftToValidationPatch', () => {
  // The fix for the stale "Recipient is required" bug relies on the
  // server validating the patch this helper produces — the patch needs
  // to carry the user's just-typed To value, otherwise the server
  // re-validates the empty-on-disk action and the canvas keeps showing
  // the same red dot the local validation already cleared.
  it('forwards send_email fields so server validation sees the in-progress draft', () => {
    const patch = draftToValidationPatch({
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: 'conn_1',
      to: '  sevennt.leslie@gmail.com  ',
      subject: { parts: [{ kind: 'text' as const, text: 'New record added' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    })
    expect(patch.action?.type).toBe('send_email')
    expect(patch.action?.to).toBe('sevennt.leslie@gmail.com')
    expect(patch.action?.subject).toEqual({ parts: [{ kind: 'text', text: 'New record added' }] })
    expect(patch.action?.connectionId).toBe('conn_1')
    expect(patch.action?.body?.parts).toHaveLength(1)
  })

  it('emits an add_record patch with the draft’s addRecord block when applicable', () => {
    const patch = draftToValidationPatch({
      name: 'Z',
      description: '',
      actionType: 'add_record',
      connectionId: '',
      to: '',
      subject: { parts: [{ kind: 'text' as const, text: '' }] },
      body: { parts: [] },
      addRecord: { targetDocumentId: 'doc_2', targetTableId: 'tbl_target', fields: [] },
    })
    expect(patch.action?.type).toBe('add_record')
    expect(patch.action?.addRecord?.targetTableId).toBe('tbl_target')
    expect(patch.action?.to).toBeUndefined()
  })
})

describe('workflowStatus / triggerLabel', () => {
  const labels: Record<string, TableLabel> = {
    tbl_leads: { tableName: 'Leads', documentTitle: 'CRM', documentId: 'doc_1', documentPath: 'crm.kitable' },
  }

  it('returns "error" when the latest run failed even if enabled', () => {
    expect(workflowStatus(baseWorkflow, { status: 'error' } as any)).toBe('error')
  })

  it('returns "on" / "off" based on enabled flag when last run is healthy', () => {
    expect(workflowStatus({ ...baseWorkflow, enabled: true }, { status: 'ok' } as any)).toBe('on')
    expect(workflowStatus({ ...baseWorkflow, enabled: false }, null)).toBe('off')
  })

  it('renders a scheduled trigger label with the cron string', () => {
    const wf: WorkflowDefinition = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, type: 'scheduled_time', tableId: '', schedule: { cron: '0 9 * * *' } } as any,
    }
    expect(triggerLabel(wf, labels)).toBe('At scheduled time · 0 9 * * *')
  })

  it('renders a record-event trigger with the bound table name', () => {
    expect(triggerLabel(baseWorkflow, labels)).toBe('Record created · Leads')
  })

  it('falls back to "(no schedule)" placeholder when cron is empty', () => {
    const wf: WorkflowDefinition = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, type: 'scheduled_time', tableId: '', schedule: { cron: '' } } as any,
    }
    expect(triggerLabel(wf, labels)).toBe('At scheduled time · (no schedule)')
  })
})

describe('triggerStatus / actionStatus / actionInlineError', () => {
  const validation = {}

  it('triggerStatus goes red when scheduled cron is missing', () => {
    const wf: WorkflowDefinition = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, type: 'scheduled_time', tableId: '', schedule: { cron: '' } } as any,
    }
    expect(triggerStatus(wf, validation)).toBe('red')
  })

  it('triggerStatus goes red when record-event has no tableId', () => {
    const wf: WorkflowDefinition = {
      ...baseWorkflow,
      trigger: { ...baseWorkflow.trigger, tableId: '' },
    }
    expect(triggerStatus(wf, validation)).toBe('red')
  })

  it('actionStatus goes amber when connection is missing on send_email', () => {
    const draft: WorkflowDraft = {
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: '',
      to: 'a@b.com',
      subject: { parts: [{ kind: 'text' as const, text: 'S' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    }
    expect(actionStatus(draft, {}, null)).toBe('amber')
  })

  it('actionInlineError surfaces latest run error over validation errors', () => {
    const draft: WorkflowDraft = {
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: 'c1',
      to: 'a@b.com',
      subject: { parts: [{ kind: 'text' as const, text: 'S' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    }
    const err = actionInlineError({ draft, validation: { to: 'recipientRequired' }, latestRun: { status: 'error', error: 'SMTP refused' } as any, t: (k: string) => k })
    expect(err?.message).toBe('SMTP refused')
  })
})

describe('actionNodeDescription', () => {
  it('add_record summarises the target + field count', () => {
    const draft: WorkflowDraft = {
      name: 'X',
      description: '',
      actionType: 'add_record',
      connectionId: '',
      to: '',
      subject: { parts: [{ kind: 'text' as const, text: '' }] },
      body: { parts: [] },
      addRecord: {
        targetTableId: 'tbl_dst',
        fields: [
          { fieldId: 'f1', value: { parts: [] } },
          { fieldId: 'f2', value: { parts: [] } },
        ],
      },
    }
    const labels: Record<string, TableLabel> = {
      tbl_dst: { tableName: 'Followups', documentTitle: 'CRM', documentId: 'doc_1', documentPath: 'crm.kitable' },
    }
    expect(actionNodeDescription(draft, [], labels)).toBe('into Followups · 2 fields')
  })

  it('send_email shows recipient and channel', () => {
    const draft: WorkflowDraft = {
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: 'conn_a',
      to: 'a@b.com',
      subject: { parts: [{ kind: 'text' as const, text: 'S' }] },
      body: { parts: [] },
    }
    const connections = [{ id: 'conn_a', name: 'Mailgun' }] as ConnectionView[]
    expect(actionNodeDescription(draft, connections, {})).toBe('via Mailgun · to a@b.com')
  })

  it('send_email describes an empty connection as not selected', () => {
    const draft: WorkflowDraft = {
      name: 'X',
      description: '',
      actionType: 'send_email',
      connectionId: '',
      to: 'a@b.com',
      subject: { parts: [{ kind: 'text' as const, text: 'S' }] },
      body: { parts: [] },
    }
    expect(actionNodeDescription(draft, [], {})).toBe('via No connection selected · to a@b.com')
  })
})

describe('filter node helpers', () => {
  const node = (over: Partial<GraphNode> = {}): GraphNode => ({
    nodeId: 'filter_1',
    kind: 'filter',
    config: { mode: 'all', expression: 'priority == "high"' },
    ...over,
  })

  it('filterNodeTitle returns the expression up to 40 chars', () => {
    expect(filterNodeTitle(node())).toBe('priority == "high"')
  })

  it('filterNodeTitle returns "New filter" when expression is empty', () => {
    expect(filterNodeTitle(node({ config: {} }))).toBe('New filter')
  })

  it('filterNodeStatus returns muted when disabled, amber when empty, green otherwise', () => {
    expect(filterNodeStatus(node({ disabled: true }))).toBe('muted')
    expect(filterNodeStatus(node({ config: {} }))).toBe('amber')
    expect(filterNodeStatus(node())).toBe('green')
  })

  it('filterNodeDescription explains the gating semantics', () => {
    expect(filterNodeDescription(node())).toMatch(/Match all/)
  })
})

describe('fallbackSchemaFromWorkflow', () => {
  it('synthesises a schema from the body field_refs when no real schema is available', () => {
    const wf: WorkflowDefinition = baseWorkflow
    const body = {
      parts: [
        { kind: 'text', text: 'x' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_a' } },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_a' } }, // duplicate
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_b' } },
      ],
    }
    const schema = fallbackSchemaFromWorkflow(wf, body as any)
    expect(schema.fields.map((f) => f.id)).toEqual(['f_a', 'f_b'])
    expect(schema.id).toBe('tbl_leads')
  })
})
