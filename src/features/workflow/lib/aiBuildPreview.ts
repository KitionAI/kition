import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from '@/features/workflow/api'
import type { NodeStatus } from '@/features/workflow/canvas/NodeCard'
import type { BodyTemplate, TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { WorkflowBuildEvent, WorkflowBuildStatus } from '@/features/workflow/types'

/**
 * Sentinel id used to mark the synthetic preview workflow that lives in
 * WorkflowHomePage's list during AI streaming. Real workflow rows are
 * UUID-shaped; this double-underscore string can never collide with a real id
 * issued by the backend, and acts as the gate for every place that needs to
 * short-circuit network calls / dirty bits / Save bar while the AI is still
 * writing.
 */
export const STREAMING_WORKFLOW_ID = '__streaming__'

/**
 * Wrap a synthesized preview so its id is the streaming sentinel. Callers
 * should always pipe eventsToPreviewWorkflow output through this before
 * exposing the result to the home page, otherwise the preview's real
 * (future) UUID would collide with the row the backend writes once
 * workflow.created arrives.
 */
export function withStreamingId(def: WorkflowDefinition): WorkflowDefinition {
  return { ...def, id: STREAMING_WORKFLOW_ID }
}

/**
 * AI-build SSE events → in-memory WorkflowDefinition preview.
 *
 * The build pipeline only persists to the DB once it has trigger + action ready
 * (workflow.created arrives last). To render the same canvas during streaming
 * we synthesize a transient WorkflowDefinition from the partial events. The
 * resulting object is fed into WorkflowHomePage's `selected` slot, so existing
 * normaliseGraph + draft/graph-state machinery renders it without special
 * cases.
 *
 * Returns null while no `workflow.generated` event has arrived (the canvas
 * shows a "waiting for stream" placeholder instead).
 */
export function eventsToPreviewWorkflow(
  events: WorkflowBuildEvent[],
  tableSchema: TableSchema | null,
  documentId?: string,
): WorkflowDefinition | null {
  const wEv = events.find((e) => e.kind === 'workflow.generated')
  if (!wEv || wEv.kind !== 'workflow.generated') return null

  const tEv = events.find((e) => e.kind === 'trigger.generated')
  const aEv = events.find((e) => e.kind === 'action.generated')

  const triggerNodeId = tEv && tEv.kind === 'trigger.generated' ? tEv.nodeId : 't_preview'
  const actionNodeId = aEv && aEv.kind === 'action.generated' ? aEv.nodeId : 'a_preview'

  const trigger: WorkflowDefinition['trigger'] = tEv && tEv.kind === 'trigger.generated'
    ? {
        nodeId: tEv.nodeId,
        type: tEv.triggerType,
        tableId: tEv.tableId,
        documentId,
      }
    : {
        nodeId: triggerNodeId,
        type: 'record_created',
        tableId: tableSchema?.id ?? '',
        documentId,
      }

  const action: WorkflowDefinition['action'] = aEv && aEv.kind === 'action.generated'
    ? resolveActionConfig(aEv.nodeId, aEv.actionType, aEv.config)
    : { nodeId: actionNodeId, type: 'send_email', to: '', subject: { parts: [] }, body: { parts: [] } }

  const nodes: WorkflowNode[] = [
    { nodeId: trigger.nodeId, kind: 'trigger', config: { type: trigger.type, tableId: trigger.tableId } },
    { nodeId: action.nodeId, kind: 'action', config: { type: action.type } },
  ]
  const edges: WorkflowEdge[] = [{ from: trigger.nodeId, to: action.nodeId }]

  return {
    id: wEv.workflowId,
    name: wEv.name,
    description: wEv.description,
    enabled: false,
    trigger,
    action,
    nodes,
    edges,
  }
}

function resolveActionConfig(
  nodeId: string,
  actionType: 'send_email' | string,
  config: Record<string, unknown>,
): WorkflowDefinition['action'] {
  const cfg = config as { to?: string; subject?: BodyTemplate | string; body?: BodyTemplate; connectionId?: string }
  const subject: BodyTemplate = typeof cfg.subject === 'string'
    ? (cfg.subject ? { parts: [{ kind: 'text', text: cfg.subject }] } : { parts: [] })
    : (cfg.subject ?? { parts: [] })
  return {
    nodeId,
    type: actionType,
    connectionId: cfg.connectionId,
    to: cfg.to ?? '',
    subject,
    body: cfg.body ?? { parts: [] },
  }
}

/**
 * Coarse progress phases derived from the SSE stream. Maps to UI banner copy
 * so we don't bake the i18n keys into the adapter.
 */
export type AiBuildPhase =
  | 'idle'
  | 'submitting'
  | 'generating-workflow'
  | 'generating-trigger'
  | 'generating-action'
  | 'persisting'
  | 'done'
  | 'error'

export function eventsToProgressState(
  events: WorkflowBuildEvent[],
  status: WorkflowBuildStatus,
): AiBuildPhase {
  if (status === 'idle') return 'idle'
  if (status === 'error') return 'error'
  if (status === 'submitting') return 'submitting'
  if (status === 'done') return 'done'
  // status === 'streaming'
  const hasCreated = events.some((e) => e.kind === 'workflow.created')
  if (hasCreated) return 'persisting'
  const hasAction = events.some((e) => e.kind === 'action.generated')
  if (hasAction) return 'persisting'
  const hasTrigger = events.some((e) => e.kind === 'trigger.generated')
  if (hasTrigger) return 'generating-action'
  const hasWorkflow = events.some((e) => e.kind === 'workflow.generated')
  if (hasWorkflow) return 'generating-trigger'
  return 'generating-workflow'
}

/** True while the AI is still mutating the workflow — the UI uses this to
 *  disable Save / Enable / Delete so the user doesn't race with the stream. */
export function isAiBuildLocked(status: WorkflowBuildStatus): boolean {
  return status === 'submitting' || status === 'streaming'
}

/** Extract the persisted workflow id once it's been written. Returns null
 *  while the stream is still mid-flight. */
export function findCreatedWorkflowId(events: WorkflowBuildEvent[]): string | null {
  for (const ev of events) {
    if (ev.kind === 'workflow.created') return ev.workflowId
  }
  return null
}

/**
 * i18n key for the streaming banner / list chip phase label. Lives here so
 * the home page's banner switch and any future surface share one mapping.
 */
export function phaseLabelKey(phase: AiBuildPhase): string {
  switch (phase) {
    case 'idle':
      return 'panels.build.streamWaiting'
    case 'submitting':
      return 'panels.build.streamWaiting'
    case 'generating-workflow':
      return 'panels.progress.stepWorkflow'
    case 'generating-trigger':
      return 'panels.progress.stepTrigger'
    case 'generating-action':
      return 'panels.progress.stepAction'
    case 'persisting':
      return 'panels.build.streamGenerating'
    case 'done':
      return 'panels.progress.title'
    case 'error':
      return 'panels.build.streamGenerating'
  }
}

/**
 * Node status color for trigger / action cards during streaming. Each role
 * lights up its own status as the SSE pipeline reaches its phase.
 */
export function statusForPhase(phase: AiBuildPhase, role: 'trigger' | 'action'): NodeStatus {
  if (phase === 'error') return 'red'
  if (role === 'trigger') {
    if (phase === 'generating-workflow' || phase === 'submitting' || phase === 'idle') return 'muted'
    return 'green'
  }
  // role === 'action'
  if (phase === 'persisting' || phase === 'done') return 'green'
  if (phase === 'generating-action') return 'amber'
  return 'muted'
}
