/**
 * What the workspace must do when a live session event or stream frame
 * arrives: reload modified documents, refresh the tree, and announce
 * connections. Pure: the hook runs the returned effects. Each function takes the session view as it was
 * before the input is applied, so replayed input yields no effects.
 */
import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import type { AgentStreamNotification } from '@/api/generated/agent-stream'
import {
  applyAssistantStream,
  applySessionEvent,
  applyStatus,
  isGap,
  type AgentSessionView,
  readField as field,
  type AgentToolRun,
} from './agentSessionView'

export type AgentEffect =
  | { type: 'documents-modified'; paths: string[] }
  | { type: 'deliverables-saved'; paths: string[] }
  | {
    type: 'connections-changed'
    detail: { source: 'configure_smtp_connection'; connectionId: string; workflowId: string; workflowAttached: boolean }
  }

/** Workspace documents a completed run changed (the former `getAgentModifiedDocumentPaths`). */
function modifiedPaths(run: AgentToolRun): string[] {
  const output = run.output
  const input = run.arguments
  if (run.name === 'document_write') {
    const outputPath = field(output, 'path')
    const inputPath = field(input, 'path')
    const path = typeof outputPath === 'string' ? outputPath : typeof inputPath === 'string' ? inputPath : ''
    return path ? [path] : []
  }
  if (run.name === 'apply_patch') {
    const fileOps = field(output, 'file_ops')
    const changes = field(output, 'changes')
    const paths = [...(Array.isArray(fileOps) ? fileOps : []), ...(Array.isArray(changes) ? changes : [])]
      .map((operation) => field(operation, 'path'))
      .filter((path): path is string => typeof path === 'string' && path !== '')
    return [...new Set(paths)]
  }
  return []
}

/** Workspace documents the completed runs changed, in order and without repeats. */
export function agentModifiedDocumentPaths(runs: AgentToolRun[]): Set<string> {
  return new Set(runs.filter((run) => run.status === 'completed').flatMap(modifiedPaths))
}

function completedRunEffects(run: AgentToolRun): AgentEffect[] {
  const effects: AgentEffect[] = []
  const paths = modifiedPaths(run)
  if (paths.length) effects.push({ type: 'documents-modified', paths })
  if (run.name === 'configure_smtp_connection') {
    const id = field(run.output, 'id')
    const workflowId = field(run.output, 'workflow_id')
    effects.push({
      type: 'connections-changed',
      detail: {
        source: 'configure_smtp_connection',
        connectionId: typeof id === 'string' ? id : '',
        workflowId: typeof workflowId === 'string' ? workflowId : '',
        workflowAttached: Boolean(field(run.output, 'workflow_attached')),
      },
    })
  }
  return effects
}

function runEffects(run: AgentToolRun | undefined): AgentEffect[] {
  return run?.status === 'completed' ? completedRunEffects(run) : []
}

/** Effects of one session event received live; `view` is the view before it. */
export function effectsOfEvent(event: AgentSessionEventsSessionEvent, view: AgentSessionView): AgentEffect[] {
  if (event.seq !== view.cursor + 1) return []
  switch (event.type) {
    case 'deliverables/presented':
      return event.files.length ? [{ type: 'deliverables-saved', paths: event.files.map((file) => file.path) }] : []
    case 'tool/result': {
      const runs = applySessionEvent(view, event).turns.at(-1)?.toolRuns ?? []
      return runEffects([...runs].reverse().find((run) => run.callId === event.callId))
    }
    default:
      return []
  }
}

/**
 * One live notification applied to a session view: the next view, the
 * effects to run (computed from the view before it), and whether a session
 * event skipped past the cursor, so the log must be read first.
 */
export function stepAgentSession(
  view: AgentSessionView,
  notification: AgentStreamNotification,
): { view: AgentSessionView; effects: AgentEffect[]; gap: boolean } {
  switch (notification.method) {
    case 'session.event': {
      const { event } = notification.params
      if (isGap(view, event)) return { view, effects: [], gap: true }
      return { view: applySessionEvent(view, event), effects: effectsOfEvent(event, view), gap: false }
    }
    case 'session.status':
      return { view: applyStatus(view, notification.params.status), effects: [], gap: false }
    case 'agent/assistant-stream': {
      const { frame } = notification.params
      return { view: applyAssistantStream(view, frame), effects: [], gap: false }
    }
  }
}
