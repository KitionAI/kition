/**
 * What the workspace must do when a live session event or stream frame
 * arrives: reload modified documents, refresh the tree, announce
 * connections, and preview or cancel canvas patches. Pure: the hook runs
 * the returned effects. Each function takes the session view as it was
 * before the input is applied, so replayed input yields no effects.
 */
import type { AgentDesignPatch } from '@/api/generated/agent-design'
import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import type { AgentStreamNotification } from '@/api/generated/agent-stream'
import type { AgentWhiteboardPatch } from '@/api/generated/agent-whiteboard'
import {
  applyAssistantStream,
  applySessionEvent,
  applyStatus,
  isGap,
  type AgentAssistantStreamFrame,
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
  | { type: 'whiteboard-patch'; patch: AgentWhiteboardPatch; provisional: boolean }
  | { type: 'whiteboard-patch-cancelled' }
  | { type: 'design-patch'; patch: AgentDesignPatch; provisional: boolean }
  | { type: 'design-patch-cancelled' }

/** Canvas patch tools: tool name, patch `type`, and the effect it drives. */
const PATCH_TOOLS = [
  { tool: 'whiteboard_propose_patch', kind: 'whiteboard.patch', effect: 'whiteboard-patch' },
  { tool: 'design_propose_patch', kind: 'design.patch', effect: 'design-patch' },
] as const

type PatchTool = (typeof PATCH_TOOLS)[number]

function patchToolOf(name: string | undefined): PatchTool | undefined {
  return PATCH_TOOLS.find((entry) => entry.tool === name)
}

function isPatch(value: unknown, kind: PatchTool['kind']) {
  return field(value, 'type') === kind
}

function patchEffect(tool: PatchTool, patch: unknown, provisional: boolean): AgentEffect {
  return tool.effect === 'whiteboard-patch'
    ? { type: 'whiteboard-patch', patch: patch as AgentWhiteboardPatch, provisional }
    : { type: 'design-patch', patch: patch as AgentDesignPatch, provisional }
}

function cancelled(tools: Iterable<PatchTool>): AgentEffect[] {
  const names = new Set([...tools].map((tool) => tool.tool))
  return PATCH_TOOLS
    .filter((tool) => names.has(tool.tool))
    .map((tool) => ({ type: `${tool.effect}-cancelled` }) as AgentEffect)
}

function parsedPatch(tool: PatchTool, args: string): unknown {
  try {
    const patch = JSON.parse(args) as unknown
    return isPatch(patch, tool.kind) ? patch : undefined
  } catch {
    return undefined
  }
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
  for (const tool of PATCH_TOOLS) {
    const patch = field(run.meta, 'patch')
    if (field(run.meta, 'kind') === tool.kind && isPatch(patch, tool.kind)) effects.push(patchEffect(tool, patch, false))
  }
  return effects
}

function runEffects(run: AgentToolRun | undefined): AgentEffect[] {
  if (!run) return []
  if (run.status === 'failed') {
    const tool = patchToolOf(run.name)
    return tool ? cancelled([tool]) : []
  }
  return run.status === 'completed' ? completedRunEffects(run) : []
}

/** Patch tools of the open turn that were called and have no result yet. */
function runningPatches(view: AgentSessionView): PatchTool[] {
  return (view.turns.at(-1)?.toolRuns ?? [])
    .filter((run) => run.status === 'running')
    .map((run) => patchToolOf(run.name))
    .filter((tool): tool is PatchTool => Boolean(tool))
}

/** Patches the live attempt previewed from its streamed arguments. */
function streamedPatches(view: AgentSessionView): PatchTool[] {
  return Object.values(view.live?.toolArgs ?? {})
    .map((entry) => {
      const tool = patchToolOf(entry.name)
      return tool && parsedPatch(tool, entry.args) !== undefined ? tool : undefined
    })
    .filter((tool): tool is PatchTool => Boolean(tool))
}

/** Effects of one session event received live; `view` is the view before it. */
export function effectsOfEvent(event: AgentSessionEventsSessionEvent, view: AgentSessionView): AgentEffect[] {
  if (event.seq !== view.cursor + 1) return []
  switch (event.type) {
    case 'deliverables/presented':
      return event.files.length ? [{ type: 'deliverables-saved', paths: event.files.map((file) => file.path) }] : []
    case 'turn/end':
      return event.reason === 'completed' ? [] : cancelled([...runningPatches(view), ...streamedPatches(view)])
    case 'tool/result': {
      const runs = applySessionEvent(view, event).turns.at(-1)?.toolRuns ?? []
      return runEffects([...runs].reverse().find((run) => run.callId === event.callId))
    }
    default:
      return []
  }
}

/** Effects of one assistant-stream frame; `view` is the view before it. */
export function effectsOfStream(frame: AgentAssistantStreamFrame, view: AgentSessionView): AgentEffect[] {
  const live = view.live
  if (frame.type === 'start' || live?.attemptId !== frame.attemptId) return []
  if (frame.type === 'end') {
    const withoutMessage = frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt'
    return withoutMessage ? cancelled(streamedPatches(view)) : []
  }
  if (frame.chunk.type !== 'tool-call-delta') return []
  const before = live.toolArgs[frame.chunk.id]
  const after = applyAssistantStream(view, frame).live?.toolArgs[frame.chunk.id]
  const tool = patchToolOf(after?.name)
  if (!tool || !after) return []
  // Only the delta that first completes the arguments previews the patch.
  if (before && parsedPatch(tool, before.args) !== undefined) return []
  const patch = parsedPatch(tool, after.args)
  return patch === undefined ? [] : [patchEffect(tool, patch, true)]
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
      return { view: applyAssistantStream(view, frame), effects: effectsOfStream(frame, view), gap: false }
    }
  }
}
