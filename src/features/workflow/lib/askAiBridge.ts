import type { WorkflowDefinition } from '@/features/workflow/api'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'

/**
 * "workflow-node:ask-ai" context bridge.
 *
 * NodeCard's hover Ask AI pill emits a CustomEvent on the window with a
 * typed payload describing the node the user wants help with. The outer
 * agent panel (or any other listener) consumes the event and:
 *
 *  1. Opens itself, creating a session if needed.
 *  2. Prepends a system message referencing the workflow/node and table
 *     schema so the LLM has the context it would otherwise need to be
 *     pasted in by hand.
 *
 * The bridge intentionally lives in features/workflow (not features/agent)
 * because workflow owns the payload shape — the agent side just consumes
 * whatever we publish here. Keeping the source of truth on the publisher
 * side stops the two surfaces from drifting.
 */
export const WORKFLOW_NODE_ASK_AI_EVENT = 'kition:workflow-node:ask-ai'

export interface WorkflowNodeAskAIPayload {
  workflow: Pick<WorkflowDefinition, 'id' | 'name'>
  /** Node id within the workflow graph (trigger / action). */
  nodeId: string
  /** What kind of node was selected; lets the agent tailor its hint
   *  (eg. "explain this trigger" vs "review this email body"). */
  nodeKind: 'trigger' | 'action' | 'filter'
  /** Live config snapshot at the moment Ask AI was clicked. Plain object so
   *  it round-trips through the event system without losing shape. */
  nodeConfig: Record<string, unknown>
  /** Optional table schema. We include it on the publisher side so the
   *  consumer can build the prompt without doing its own fetch. */
  tableSchema?: TableSchema | null
}

/**
 * Publish an Ask AI request. Returns the underlying CustomEvent so callers
 * can detect cancellation if a listener calls preventDefault().
 */
export function publishWorkflowNodeAskAI(payload: WorkflowNodeAskAIPayload): CustomEvent<WorkflowNodeAskAIPayload> {
  const event = new CustomEvent<WorkflowNodeAskAIPayload>(WORKFLOW_NODE_ASK_AI_EVENT, {
    detail: payload,
    cancelable: true,
  })
  window.dispatchEvent(event)
  return event
}

/**
 * Build the human-readable prompt that the agent should append/prepend to
 * its session draft. Exposed as a pure function so listeners and unit
 * tests can produce identical text.
 *
 * For email-action nodes we additionally call out the
 * `configure_smtp_connection` tool by name so the model knows it can
 * upsert an SMTP connection directly when the user pastes config values.
 * Other node kinds get a simpler "explain / help me with" prompt — they
 * have no direct tool yet.
 */
export function buildWorkflowNodeAskAIPrompt(payload: WorkflowNodeAskAIPayload): string {
  const { workflow, nodeKind, nodeId, nodeConfig, tableSchema } = payload
  const fields = (tableSchema?.fields || []).map((f) => `  - ${f.name} (${f.id}, ${f.type})`).join('\n') || '  (no fields available)'
  const isEmailAction = nodeKind === 'action' && (nodeConfig as { type?: string })?.type === 'send_email'
  const existingConnectionId = isEmailAction ? String((nodeConfig as { connectionId?: string })?.connectionId || '').trim() : ''
  const toolGuidance = isEmailAction
    ? [
        '',
        'Available tool: `configure_smtp_connection`.',
        existingConnectionId
          ? `If the user provides SMTP settings (host, port, username, password, from, fromName, tlsMode), call configure_smtp_connection with existingConnectionId="${existingConnectionId}" and workflowId="${workflow.id}" to update the connection currently selected by this action AND keep it attached.`
          : `If the user provides SMTP settings (host, port, username, password, from, fromName, tlsMode), call configure_smtp_connection with workflowId="${workflow.id}" so the new connection is created AND immediately attached to this workflow's action — the user should not have to touch the Connection dropdown afterwards.`,
        'After the tool returns, tell the user the connection name + id. If workflow_attached=true is in the output, also confirm the action is now wired to it.',
      ].join('\n')
    : ''
  return [
    `Help me with the ${nodeKind} node "${nodeId}" of workflow "${workflow.name}" (${workflow.id}).`,
    '',
    'Current node configuration:',
    '```json',
    JSON.stringify(nodeConfig, null, 2),
    '```',
    '',
    `Source table (${tableSchema?.name || 'unknown'}):`,
    fields,
    toolGuidance,
  ].join('\n').trimEnd()
}
