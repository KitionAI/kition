// src/features/workflow/types.ts

export type WorkflowBuildEvent =
  | { kind: 'workflow.generated'; workflowId: string; name: string; description: string }
  | { kind: 'trigger.generated'; nodeId: string; triggerType: 'record_created'; tableId: string; config: Record<string, unknown> }
  | { kind: 'action.generated'; nodeId: string; actionType: 'send_email'; config: Record<string, unknown> }
  | { kind: 'workflow.created'; workflowId: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'done' }

const KIND_REQUIREMENTS: Record<string, string[]> = {
  'workflow.generated': ['workflowId', 'name'],
  'trigger.generated': ['nodeId', 'triggerType', 'tableId', 'config'],
  'action.generated': ['nodeId', 'actionType', 'config'],
  'workflow.created': ['workflowId'],
  'error': ['code', 'message'],
  'done': [],
}

export function parseWorkflowBuildEvent(raw: string): WorkflowBuildEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const kind = typeof obj.kind === 'string' ? obj.kind : null
  if (!kind || !(kind in KIND_REQUIREMENTS)) return null
  for (const key of KIND_REQUIREMENTS[kind]) {
    if (!(key in obj)) return null
  }
  return obj as unknown as WorkflowBuildEvent
}

export type WorkflowBuildStatus = 'idle' | 'submitting' | 'streaming' | 'done' | 'error'
