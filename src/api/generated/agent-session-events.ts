/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-session-events.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

/**
 * Position of the event in its session, starting at 1.
 */
export type AgentSessionEventsSeq = number

/**
 * When the event was appended, in Unix milliseconds.
 */
export type AgentSessionEventsAt = number

export type AgentSessionEventsContentBlock = {
  type: "text"
  text: string
} | {
  type: "image"
  url: string
}

/**
 * A tool call as the model asked for it.
 */
export type AgentSessionEventsLoggedCall = {
  callId: string
  name: string
  /**
   * The call arguments as the tool's log projection writes them (passwords redacted, search queries and patch text reduced to counts).
   */
  arguments: unknown
}

export type AgentSessionEventsTurnEndReason = "completed" | "cancelled" | "failed" | "awaiting-approval" | "step-limit"

/**
 * Who produced a user/message (DeepSeek Harness MessageSource). Known kinds: user (the person, shown as a bubble), approval (resumes a turn after an approval decision), context-action (a hidden follow-up the client sent), recovery (context the runtime adds after tool failures), tool-follow-up (content a model reply hands to the next step, such as hosted images). Open: other kinds may appear.
 */
export type AgentSessionEventsMessageSource = {
  kind: string
}

export type AgentSessionEventsApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable"

/**
 * A file a turn hands to the user; path is workspace-relative.
 */
export type AgentSessionEventsPresentedFile = {
  path: string
  description?: string
}

export type AgentSessionEventsTodoItem = {
  content: string
  status: "pending" | "in_progress" | "completed"
}

export type AgentSessionEventsLlmFailure = {
  message: string
  code: string
}

/**
 * Display-only data derived from the arguments and the value. The known shapes are listed; any other object may appear.
 */
export type AgentSessionEventsToolResultMeta = {
  kind: "whiteboard.patch" | "design.patch"
  patch: Record<string, unknown>
} | {
  kind: "shell.approval"
  command: string
  reason: string
  requires: "approval"
  decision: "prompt"
  suggested?: {
    prefix: string[]
    decision: "allow"
  }
} | {
  kind: "image_generation.variant"
  request_id: string
  artifact: Record<string, unknown>
} | {
  hosted: true
} | Record<string, unknown>

/**
 * A turn began.
 */
export type AgentSessionEventsTurnStartEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "turn/start"
  turn: number
}

/**
 * A turn ended; error is omitted when empty.
 */
export type AgentSessionEventsTurnEndEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "turn/end"
  turn: number
  reason: AgentSessionEventsTurnEndReason
  error?: string
}

/**
 * One model call and its tool calls began.
 */
export type AgentSessionEventsStepStartEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "step/start"
  turn: number
  step: number
}

/**
 * One model call and its tool calls ended.
 */
export type AgentSessionEventsStepEndEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "step/end"
  turn: number
  step: number
}

/**
 * The system prompt the model saw.
 */
export type AgentSessionEventsSystemMessageEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "system/message"
  content: string
}

/**
 * A user-role message: what the person sent, or context the runtime adds (see source).
 */
export type AgentSessionEventsUserMessageEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "user/message"
  content: AgentSessionEventsContentBlock[]
  source: AgentSessionEventsMessageSource
}

/**
 * What the model answered, with the tool calls it asked for. Provider-native replay items are kept in the log but never returned.
 */
export type AgentSessionEventsAssistantMessageEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "assistant/message"
  content: string
  toolCalls?: AgentSessionEventsLoggedCall[]
  stopReason: string
  model: string
}

/**
 * A model call that settled without a message: failed or cancelled.
 */
export type AgentSessionEventsAssistantAttemptEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "assistant/attempt"
  error: string
}

/**
 * A tool call the runtime is about to run, with its arguments as the tool's log projection writes them.
 */
export type AgentSessionEventsToolCallEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "tool/call"
  callId: string
  name: string
  /**
   * The logged arguments (passwords redacted, search queries and patch text reduced to counts).
   */
  arguments: unknown
}

/**
 * The outcome of a tool call.
 */
export type AgentSessionEventsToolResultEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "tool/result"
  callId: string
  name: string
  /**
   * The canonical output value; null on failure.
   */
  value: unknown
  /**
   * What the model sees.
   */
  content: AgentSessionEventsContentBlock[]
  isError: boolean
  meta?: AgentSessionEventsToolResultMeta
}

/**
 * A tool call that waits for the user's approval. id is approval:<callId>; the matching approval/decided carries the same id.
 */
export type AgentSessionEventsApprovalAskedEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "approval/asked"
  id: string
  toolName: string
  callId: string
  reason?: string
}

/**
 * How the user settled an approval/asked with the same id.
 */
export type AgentSessionEventsApprovalDecidedEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "approval/decided"
  id: string
  outcome: AgentSessionEventsApprovalOutcome
}

/**
 * Files a successful tool result (callId) of a turn hands to the user.
 */
export type AgentSessionEventsDeliverablesPresentedEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "deliverables/presented"
  turn: number
  callId: string
  files: AgentSessionEventsPresentedFile[]
}

/**
 * The agent's whole todo list; the latest write wins. Never model history.
 */
export type AgentSessionEventsTodoWriteEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "todo/write"
  todos: AgentSessionEventsTodoItem[]
}

/**
 * A failed model request of a step that will be retried after delayMs. retryId names the retry chain of one model step (every retry of the step shares it); retry counts from 1.
 */
export type AgentSessionEventsLlmRetryEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "llm/retry"
  retryId: string
  turn: number
  step: number
  provider: string
  mode: "normal"
  policyKey: string
  retry: number
  maxRetries: number
  delayMs: number
  failure: AgentSessionEventsLlmFailure
}

/**
 * The wait of llm/retry number retry (same retryId) is over and the next attempt starts.
 */
export type AgentSessionEventsLlmRetryStartedEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "llm/retry-started"
  retryId: string
  turn: number
  step: number
  retry: number
}

/**
 * The permission preset (execution mode) from this point on, logged when it changes.
 */
export type AgentSessionEventsPermissionPresetEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "permission/preset"
  preset: "research" | "preview" | "apply"
}

/**
 * One durable session event, named after DeepSeek Harness events.
 */
export type AgentSessionEventsSessionEvent = AgentSessionEventsTurnStartEvent | AgentSessionEventsTurnEndEvent | AgentSessionEventsStepStartEvent | AgentSessionEventsStepEndEvent | AgentSessionEventsSystemMessageEvent | AgentSessionEventsUserMessageEvent | AgentSessionEventsAssistantMessageEvent | AgentSessionEventsAssistantAttemptEvent | AgentSessionEventsToolCallEvent | AgentSessionEventsToolResultEvent | AgentSessionEventsApprovalAskedEvent | AgentSessionEventsApprovalDecidedEvent | AgentSessionEventsDeliverablesPresentedEvent | AgentSessionEventsTodoWriteEvent | AgentSessionEventsLlmRetryEvent | AgentSessionEventsLlmRetryStartedEvent | AgentSessionEventsPermissionPresetEvent

export type AgentSessionEventsPage = {
  items: AgentSessionEventsSessionEvent[]
  /**
   * Pass as after to read the next page: the last seq returned, or the given after when the page is empty.
   */
  next_after: number
}

/**
 * GET /agent/sessions/{id}/session-events?after=<seq> answers the caller's own session event log in the runtime envelope: events with seq greater than after, in order, at most 500 per page. Another user's or an unknown session answers 404. Tool-call arguments in tool/call and in assistant/message toolCalls are logged through each tool's projection (passwords redacted, search queries and patch text reduced to counts); other fields are logged as the model and tools produced them.
 */
export type AgentSessionEventsContract = AgentSessionEventsPage
