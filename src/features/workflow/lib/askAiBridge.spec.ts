import { describe, expect, it } from 'vitest'

import {
  WORKFLOW_NODE_ASK_AI_EVENT,
  buildWorkflowNodeAskAIPrompt,
  publishWorkflowNodeAskAI,
} from './askAiBridge'

describe('publishWorkflowNodeAskAI', () => {
  it('emits a typed CustomEvent on window with the full payload', () => {
    let captured: CustomEvent | null = null
    const handler = (event: Event) => {
      captured = event as CustomEvent
    }
    window.addEventListener(WORKFLOW_NODE_ASK_AI_EVENT, handler)
    try {
      publishWorkflowNodeAskAI({
        workflow: { id: 'auto_1', name: 'Lead alert' },
        nodeId: 'action_1',
        nodeKind: 'action',
        nodeConfig: { to: 'x@y' },
        tableSchema: { id: 'tbl_1', name: 'Leads', fields: [] },
      })
    } finally {
      window.removeEventListener(WORKFLOW_NODE_ASK_AI_EVENT, handler)
    }
    expect(captured, 'event should fire').toBeTruthy()
    expect(captured!.detail.workflow.id).toBe('auto_1')
    expect(captured!.detail.nodeKind).toBe('action')
  })
})

describe('buildWorkflowNodeAskAIPrompt', () => {
  it('includes the workflow name, node ids, JSON config and schema field list', () => {
    const text = buildWorkflowNodeAskAIPrompt({
      workflow: { id: 'auto_x', name: 'Lead alert' },
      nodeId: 'action_1',
      nodeKind: 'action',
      nodeConfig: { to: 'x@y', subject: { parts: [{ kind: 'text' as const, text: 'Hi' }] } },
      tableSchema: {
        id: 'tbl_1',
        name: 'Leads',
        fields: [
          { id: 'fld_a', name: 'First Name', type: 'text' },
          { id: 'fld_b', name: 'Email', type: 'email' },
        ],
      },
    })
    expect(text).toContain('action node "action_1"')
    expect(text).toContain('Lead alert')
    expect(text).toContain('"to": "x@y"')
    expect(text).toContain('First Name (fld_a, text)')
  })

  it('falls back gracefully when no schema is available', () => {
    const text = buildWorkflowNodeAskAIPrompt({
      workflow: { id: 'auto_y', name: 'Lead alert' },
      nodeId: 'trigger_1',
      nodeKind: 'trigger',
      nodeConfig: { type: 'record_created', tableId: 'tbl_1' },
      tableSchema: null,
    })
    expect(text).toContain('Source table (unknown)')
    expect(text).toContain('(no fields available)')
  })

  it('points the model at configure_smtp_connection for send_email action nodes', () => {
    const text = buildWorkflowNodeAskAIPrompt({
      workflow: { id: 'auto_x', name: 'Lead alert' },
      nodeId: 'action_1',
      nodeKind: 'action',
      nodeConfig: { type: 'send_email', connectionId: 'conn_a', to: 'x@y' },
      tableSchema: null,
    })
    expect(text).toContain('configure_smtp_connection')
    // Existing connection is referenced so the model patches instead of duplicating.
    expect(text).toContain('existingConnectionId="conn_a"')
    // Auto-attach is requested in the same call so the user doesn't have
    // to pick from the dropdown after the tool finishes.
    expect(text).toContain('workflowId="auto_x"')
  })

  it('does not mention the SMTP tool for non-email or non-action nodes', () => {
    const text = buildWorkflowNodeAskAIPrompt({
      workflow: { id: 'auto_x', name: 'Lead alert' },
      nodeId: 'trigger_1',
      nodeKind: 'trigger',
      nodeConfig: { type: 'record_created' },
      tableSchema: null,
    })
    expect(text).not.toContain('configure_smtp_connection')
  })

  it('passes workflowId on the create path so the new connection auto-attaches', () => {
    const text = buildWorkflowNodeAskAIPrompt({
      workflow: { id: 'auto_x', name: 'Lead alert' },
      nodeId: 'action_1',
      nodeKind: 'action',
      nodeConfig: { type: 'send_email', connectionId: '', to: 'x@y' },
      tableSchema: null,
    })
    expect(text).toContain('configure_smtp_connection')
    expect(text).toContain('workflowId="auto_x"')
    expect(text).toContain('immediately attached')
  })
})
