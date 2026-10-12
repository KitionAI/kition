/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/agent-stream.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

import type { AgentSessionEventsSessionEvent } from './agent-session-events'

export type AgentStreamSessionId = string

export type AgentStreamSessionEventNotification = {
  jsonrpc: "2.0"
  method: "session.event"
  params: {
    sessionId: AgentStreamSessionId
    event: AgentSessionEventsSessionEvent
  }
}

export type AgentStreamSessionStatusNotification = {
  jsonrpc: "2.0"
  method: "session.status"
  params: {
    sessionId: AgentStreamSessionId
    status: "running" | "idle"
  }
}

export type AgentStreamAssistantStreamNotification = {
  jsonrpc: "2.0"
  method: "agent/assistant-stream"
  params: {
    sessionId: AgentStreamSessionId
    frame: AgentStreamAssistantStreamFrame
  }
}

/**
 * DeepSeek Harness AssistantStreamFrame: one publication of a model attempt. revision counts the frames of a session from 1 for as long as the runtime runs; index counts the chunks of one attempt from 0, and end carries their number.
 */
export type AgentStreamAssistantStreamFrame = {
  type: "start"
  attemptId: string
  revision: number
  turn: number
  step: number
} | {
  type: "chunk"
  attemptId: string
  revision: number
  index: number
  time: number
  chunk: AgentStreamStreamChunk
} | {
  type: "end"
  attemptId: string
  revision: number
  index: number
  outcome: AgentStreamStreamOutcome
}

/**
 * How the attempt settled: the durable event committed for it, or abandoned when none could be appended.
 */
export type AgentStreamStreamOutcome = {
  kind: "committed"
  eventType: "assistant/message" | "assistant/attempt"
  seq: number
} | {
  kind: "abandoned"
}

/**
 * DeepSeek Harness StreamChunk. Text uses block index 0; tool call i of the attempt uses 1 + i, and id is the call id it is logged under.
 */
export type AgentStreamStreamChunk = {
  type: "text-delta"
  index: number
  text: string
} | {
  type: "tool-call-delta"
  index: number
  id: string
  name?: string
  argumentsDelta: string
}

export type AgentStreamNotification = AgentStreamSessionEventNotification | AgentStreamSessionStatusNotification | AgentStreamAssistantStreamNotification

/**
 * POST /agent/sessions/{id}/messages/stream answers NDJSON: one JSON-RPC 2.0 notification per line, in the DeepSeek Harness SDK shapes. session.status says running before the turn and idle once the turn ended and the session row is saved; the stream ends after idle. session.event carries each durable session event as it is appended (the same envelope GET /agent/sessions/{id}/session-events serves). agent/assistant-stream carries live model text and tool-call argument deltas. EOF before idle means the outcome is unknown: the client reads GET /agent/sessions/{id}/session-events?after=<cursor>. A request whose image request_id was already logged with the same settings streams only running and idle. Errors before streaming are HTTP errors; errors after it are turn/end {reason: failed, error}.
 */
export type AgentStreamContract = AgentStreamNotification
