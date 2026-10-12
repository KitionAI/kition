/**
 * The agent panel's view of one session, reduced from its session events
 * (`contracts/runtime/agent-session-events.schema.json`) and the live
 * `agent/assistant-stream` frames. Pure: every function returns a new view
 * and leaves its input untouched.
 */
import type {
  AgentSessionEventsApprovalDecidedEvent,
  AgentSessionEventsApprovalOutcome,
  AgentSessionEventsContentBlock,
  AgentSessionEventsDeliverablesPresentedEvent,
  AgentSessionEventsLlmFailure,
  AgentSessionEventsPermissionPresetEvent,
  AgentSessionEventsSessionEvent,
  AgentSessionEventsTodoItem,
  AgentSessionEventsToolResultEvent,
  AgentSessionEventsToolResultMeta,
  AgentSessionEventsTurnEndReason,
} from '@/api/generated/agent-session-events'
import { replyWithoutTablePlan } from './agentTablePlan'

// The `agent/assistant-stream` shapes (DeepSeek Harness `AssistantStreamFrame`
// and `StreamChunk`). Local until the stream contract generates them.
type AgentStreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }

type AgentStreamOutcome =
  | { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number }
  | { kind: 'abandoned' }

export type AgentAssistantStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: AgentStreamChunk }
  | { type: 'end'; attemptId: string; revision: number; index: number; outcome: AgentStreamOutcome }

type AgentShellApprovalRequest = Extract<AgentSessionEventsToolResultMeta, { kind: 'shell.approval' }>

export type AgentToolRun = {
  callId: string
  name: string
  arguments: unknown
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval'
  summary: string
  output: unknown
  error: string
  meta?: AgentSessionEventsToolResultMeta
  hosted: boolean
  startedAt: number
  endedAt?: number
}

type AgentTurnStep = {
  step: number
  startedAt: number
  endedAt?: number
  message?: { content: string; toolCallCount: number; model: string; stopReason: string; at: number }
  attemptError?: string
}

type AgentRetry = {
  retryId: string
  step: number
  retry: number
  maxRetries: number
  delayMs: number
  failure: AgentSessionEventsLlmFailure
  at: number
  started: boolean
}

type AgentApproval = {
  id: string
  callId: string
  toolName: string
  reason?: string
  request?: AgentShellApprovalRequest
  decided?: AgentSessionEventsApprovalOutcome
}

export type AgentTurnView = {
  turn: number
  startedAt: number
  /** `source.kind` of the turn's first `user/message`; only `user` is shown as a bubble. */
  source: string
  userText: string
  userImages: string[]
  preset?: AgentSessionEventsPermissionPresetEvent['preset']
  steps: AgentTurnStep[]
  toolRuns: AgentToolRun[]
  deliverables: { callId: string; path: string; description?: string }[]
  retries: AgentRetry[]
  todos?: { explanation?: string; items: AgentSessionEventsTodoItem[] }
  approval?: AgentApproval
  /** The last assistant text of a completed turn, without its table plan block. */
  reply?: string
  /** Streamed text that never reached the log (interrupted or failed attempt). */
  partialReply?: string
  end?: { reason: AgentSessionEventsTurnEndReason; error: string; at: number }
  interrupted?: boolean
}

type AgentLiveAttempt = {
  attemptId: string
  turn: number
  step: number
  text: string
  toolArgs: Record<string, { name?: string; args: string }>
}

export type AgentSessionView = {
  /** The last applied event `seq`. */
  cursor: number
  /** The last applied assistant-stream `revision`. */
  revision: number
  turns: AgentTurnView[]
  live: AgentLiveAttempt | null
  running: boolean
}

export function emptyAgentSessionView(): AgentSessionView {
  return { cursor: 0, revision: 0, turns: [], live: null, running: false }
}

/** `value[key]` when `value` is a plain JSON object. */
export function readField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function textAt(content: AgentSessionEventsContentBlock[], index: number): string {
  const block = content[index]
  return block?.type === 'text' ? block.text : ''
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** A Kition tool value or failure detail: `{name, summary, output}`. */
function toolRecord(value: unknown): { summary: string; output: unknown } | null {
  const summary = readField(value, 'summary')
  if (typeof summary !== 'string' || !('output' in (value as object))) return null
  return { summary, output: readField(value, 'output') }
}

function isShellApproval(meta: AgentSessionEventsToolResultMeta | undefined): meta is AgentShellApprovalRequest {
  return readField(meta, 'kind') === 'shell.approval'
}

function updateAt<T>(items: T[], index: number, update: (item: T) => T): T[] {
  return items.map((item, position) => (position === index ? update(item) : item))
}

function lastIndexWhere<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (test(items[index])) return index
  }
  return -1
}

function updateTurnAt(view: AgentSessionView, index: number, update: (turn: AgentTurnView) => AgentTurnView) {
  return index < 0 ? view : { ...view, turns: updateAt(view.turns, index, update) }
}

function updateLastStep(turn: AgentTurnView, update: (step: AgentTurnStep) => AgentTurnStep): AgentTurnView {
  return turn.steps.length ? { ...turn, steps: updateAt(turn.steps, turn.steps.length - 1, update) } : turn
}

function newTurn(turn: number, at: number, previous: AgentTurnView | undefined): AgentTurnView {
  return {
    turn,
    startedAt: at,
    source: '',
    userText: '',
    userImages: [],
    ...(previous?.preset ? { preset: previous.preset } : {}),
    steps: [],
    toolRuns: [],
    deliverables: [],
    retries: [],
  }
}

function settleRun(run: AgentToolRun | undefined, event: AgentSessionEventsToolResultEvent): AgentToolRun {
  const base: AgentToolRun = run ?? {
    callId: event.callId, name: event.name, arguments: null, status: 'running',
    summary: '', output: null, error: '', hosted: false, startedAt: event.at,
  }
  const settled = { ...base, name: event.name, meta: event.meta, endedAt: event.at }
  if (event.isError) {
    const detail = parseJson(textAt(event.content, 1))
    const record = toolRecord(detail)
    return {
      ...settled,
      status: 'failed',
      error: textAt(event.content, 0),
      summary: record?.summary ?? '',
      output: record ? record.output : detail ?? null,
    }
  }
  const record = toolRecord(event.value)
  return {
    ...settled,
    status: isShellApproval(event.meta) ? 'awaiting_approval' : 'completed',
    summary: record?.summary ?? '',
    output: record ? record.output : event.value,
    hosted: base.hosted || readField(event.meta, 'hosted') === true,
  }
}

function lastReply(turn: AgentTurnView): string | undefined {
  const index = lastIndexWhere(turn.steps, (step) => Boolean(step.message?.content.trim()))
  return index < 0 ? undefined : replyWithoutTablePlan(turn.steps[index].message!.content)
}

function endTurn(turn: AgentTurnView, event: Extract<AgentSessionEventsSessionEvent, { type: 'turn/end' }>): AgentTurnView {
  const reply = event.reason === 'completed' ? lastReply(turn) : undefined
  return {
    ...turn,
    toolRuns: turn.toolRuns.map((run) => (run.status === 'running' ? { ...run, status: 'failed', endedAt: event.at } : run)),
    ...(reply === undefined ? {} : { reply }),
    end: { reason: event.reason, error: event.error ?? '', at: event.at },
  }
}

function writeTodos(turn: AgentTurnView, items: AgentSessionEventsTodoItem[]): AgentTurnView {
  const plan = turn.toolRuns[lastIndexWhere(turn.toolRuns, (run) => run.name === 'update_plan' && run.status === 'completed')]
  const explanation = readField(plan?.output, 'explanation')
  return { ...turn, todos: { ...(typeof explanation === 'string' && explanation ? { explanation } : {}), items } }
}

function reduceTurn(turn: AgentTurnView, event: AgentSessionEventsSessionEvent): AgentTurnView {
  switch (event.type) {
    case 'step/start':
      return { ...turn, steps: [...turn.steps, { step: event.step, startedAt: event.at }] }
    case 'step/end':
      return { ...turn, steps: turn.steps.map((step) => (step.step === event.step ? { ...step, endedAt: event.at } : step)) }
    case 'permission/preset':
      return { ...turn, preset: event.preset }
    case 'user/message':
      if (turn.source) return turn
      return {
        ...turn,
        source: event.source.kind,
        userText: event.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
        userImages: event.content.flatMap((block) => (block.type === 'image' ? [block.url] : [])),
      }
    case 'assistant/message':
      return updateLastStep(turn, (step) => ({
        ...step,
        message: {
          content: event.content, toolCallCount: event.toolCalls?.length ?? 0,
          model: event.model, stopReason: event.stopReason, at: event.at,
        },
      }))
    case 'assistant/attempt':
      return updateLastStep(turn, (step) => ({ ...step, attemptError: event.error }))
    case 'tool/call':
      return {
        ...turn,
        toolRuns: [...turn.toolRuns, {
          callId: event.callId, name: event.name, arguments: event.arguments, status: 'running',
          summary: '', output: null, error: '', hosted: readField(event.arguments, 'hosted') === true, startedAt: event.at,
        }],
      }
    case 'tool/result': {
      const index = lastIndexWhere(turn.toolRuns, (run) => run.callId === event.callId)
      return {
        ...turn,
        toolRuns: index < 0
          ? [...turn.toolRuns, settleRun(undefined, event)]
          : updateAt(turn.toolRuns, index, (run) => settleRun(run, event)),
      }
    }
    case 'approval/asked': {
      const meta = turn.toolRuns[lastIndexWhere(turn.toolRuns, (run) => run.callId === event.callId)]?.meta
      return {
        ...turn,
        approval: {
          id: event.id, callId: event.callId, toolName: event.toolName,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(isShellApproval(meta) ? { request: meta } : {}),
        },
      }
    }
    case 'todo/write':
      return writeTodos(turn, event.todos)
    case 'llm/retry':
      return {
        ...turn,
        retries: [...turn.retries, {
          retryId: event.retryId, step: event.step, retry: event.retry, maxRetries: event.maxRetries,
          delayMs: event.delayMs, failure: event.failure, at: event.at, started: false,
        }],
      }
    case 'llm/retry-started':
      return {
        ...turn,
        retries: turn.retries.map((retry) => (
          retry.retryId === event.retryId && retry.retry === event.retry ? { ...retry, started: true } : retry
        )),
      }
    case 'turn/end':
      return endTurn(turn, event)
    default:
      return turn
  }
}

function decide(view: AgentSessionView, event: AgentSessionEventsApprovalDecidedEvent): AgentSessionView {
  const index = lastIndexWhere(view.turns, (turn) => turn.approval?.id === event.id)
  return updateTurnAt(view, index, (turn) => ({
    ...turn,
    approval: { ...turn.approval!, decided: event.outcome },
    toolRuns: turn.toolRuns.map((run) => (
      run.callId === turn.approval!.callId && run.status === 'awaiting_approval'
        ? { ...run, status: event.outcome === 'allowed-once' ? 'completed' : 'failed' }
        : run
    )),
  }))
}

function present(view: AgentSessionView, event: AgentSessionEventsDeliverablesPresentedEvent): AgentSessionView {
  const byNumber = lastIndexWhere(view.turns, (turn) => turn.turn === event.turn)
  const files = event.files.map((file) => ({ callId: event.callId, ...file }))
  return updateTurnAt(view, byNumber < 0 ? view.turns.length - 1 : byNumber, (turn) => ({
    ...turn,
    deliverables: [...turn.deliverables, ...files],
  }))
}

/** Applies one session event; events at or below the cursor are ignored. */
export function applySessionEvent(view: AgentSessionView, event: AgentSessionEventsSessionEvent): AgentSessionView {
  if (event.seq <= view.cursor) return view
  const next = { ...view, cursor: event.seq }
  switch (event.type) {
    case 'turn/start':
      return { ...next, turns: [...next.turns, newTurn(event.turn, event.at, next.turns.at(-1))] }
    case 'approval/decided':
      return decide(next, event)
    case 'deliverables/presented':
      return present(next, event)
    default:
      return updateTurnAt(next, next.turns.length - 1, (turn) => reduceTurn(turn, event))
  }
}

function accumulate(live: AgentLiveAttempt, chunk: AgentStreamChunk): AgentLiveAttempt {
  if (chunk.type === 'text-delta') return { ...live, text: live.text + chunk.text }
  const previous = live.toolArgs[chunk.id]
  const name = chunk.name ?? previous?.name
  return {
    ...live,
    toolArgs: {
      ...live.toolArgs,
      [chunk.id]: { ...(name === undefined ? {} : { name }), args: (previous?.args ?? '') + chunk.argumentsDelta },
    },
  }
}

/**
 * Applies one assistant-stream frame. Revisions grow across the whole
 * session; a frame whose revision is not newer than the last one is ignored.
 */
export function applyAssistantStream(view: AgentSessionView, frame: AgentAssistantStreamFrame): AgentSessionView {
  if (frame.revision <= view.revision) return view
  const next = { ...view, revision: frame.revision }
  if (frame.type === 'start') {
    return { ...next, live: { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, text: '', toolArgs: {} } }
  }
  const live = next.live
  if (!live || live.attemptId !== frame.attemptId) return next
  if (frame.type === 'chunk') return { ...next, live: accumulate(live, frame.chunk) }
  const settled = { ...next, live: null }
  const withoutMessage = frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt'
  if (!withoutMessage || !live.text) return settled
  const index = lastIndexWhere(settled.turns, (turn) => turn.turn === live.turn)
  return updateTurnAt(settled, index, (turn) => ({ ...turn, partialReply: live.text }))
}

/** Applies a `session.status`: `running` while a turn runs, anything else is idle. */
export function applyStatus(view: AgentSessionView, status: string): AgentSessionView {
  const running = status === 'running'
  return { ...view, running, live: running ? view.live : null }
}

/**
 * The stream ended before `idle`: the outcome is unknown. The open turn keeps
 * the streamed text as its partial reply until the log is read again.
 */
export function markInterrupted(view: AgentSessionView): AgentSessionView {
  const last = view.turns.length - 1
  const open = last >= 0 && !view.turns[last].end ? last : -1
  const text = view.live?.text ?? ''
  const marked = updateTurnAt(view, open, (turn) => ({
    ...turn,
    interrupted: true,
    ...(text ? { partialReply: text } : {}),
  }))
  return { ...marked, running: false, live: null }
}

/** The approval the latest turn waits for, when it has no decision yet. */
export function pendingApprovalOf(view: AgentSessionView): AgentApproval | null {
  const turn = view.turns.at(-1)
  return turn?.end?.reason === 'awaiting-approval' && turn.approval && !turn.approval.decided ? turn.approval : null
}
