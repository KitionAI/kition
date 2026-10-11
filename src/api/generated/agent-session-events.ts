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
   * The call arguments; secrets are redacted before they are logged.
   */
  arguments: unknown
}

export type AgentSessionEventsTurnEndReason = "completed" | "cancelled" | "failed" | "awaiting-approval" | "step-limit"

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
 * What the user sent.
 */
export type AgentSessionEventsUserMessageEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "user/message"
  content: AgentSessionEventsContentBlock[]
}

/**
 * What the model answered, with the tool calls it asked for.
 */
export type AgentSessionEventsAssistantMessageEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "assistant/message"
  content: string
  toolCalls?: AgentSessionEventsLoggedCall[]
  stopReason: string
  model: string
  /**
   * Provider-native items replayed verbatim on the Responses wire.
   */
  rawItems?: unknown[]
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
 * A tool call the runtime is about to run; secrets in the arguments are redacted.
 */
export type AgentSessionEventsToolCallEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "tool/call"
  callId: string
  name: string
  /**
   * The logged arguments, possibly summarized by the tool.
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
  /**
   * Display-only data derived from the arguments and the value.
   */
  meta?: unknown
}

/**
 * A tool call that waits for the user's approval.
 */
export type AgentSessionEventsApprovalAskedEvent = {
  seq: AgentSessionEventsSeq
  at: AgentSessionEventsAt
  type: "approval/asked"
  callId: string
  reason: string
}

/**
 * One durable session event, named after DeepSeek Harness events.
 */
export type AgentSessionEventsSessionEvent = AgentSessionEventsTurnStartEvent | AgentSessionEventsTurnEndEvent | AgentSessionEventsStepStartEvent | AgentSessionEventsStepEndEvent | AgentSessionEventsSystemMessageEvent | AgentSessionEventsUserMessageEvent | AgentSessionEventsAssistantMessageEvent | AgentSessionEventsAssistantAttemptEvent | AgentSessionEventsToolCallEvent | AgentSessionEventsToolResultEvent | AgentSessionEventsApprovalAskedEvent

export type AgentSessionEventsPage = {
  items: AgentSessionEventsSessionEvent[]
  /**
   * Pass as after to read the next page: the last seq returned, or the given after when the page is empty.
   */
  next_after: number
}

/**
 * GET /agent/sessions/{id}/session-events?after=<seq> answers the caller's own session event log in the runtime envelope: events with seq greater than after, in order, at most 500 per page. Another user's or an unknown session answers 404. Logged tool arguments are redacted by the harness.
 */
export type AgentSessionEventsContract = AgentSessionEventsPage
