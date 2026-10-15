import type { Page, Request } from '@playwright/test'

import { expectMatchesContract } from '../../src/test/contracts'

/**
 * Mocks the agent stream (`contracts/runtime/agent-stream.schema.json`): each
 * `POST /agent/sessions/{id}/messages/stream` answers the notifications a
 * script writes, and `GET /agent/sessions/{id}/session-events` serves the
 * same events from the session's log after the requested cursor.
 */

type EventBody = { type: string } & Record<string, unknown>
type Line = Record<string, unknown>

const key = (sessionId: number) => `agent:${sessionId}`

/** One notification of the stream. */
export const notification = {
  event: (sessionId: number, seq: number, body: EventBody): Line => ({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: key(sessionId), event: { seq, at: Date.now(), ...body } },
  }),
  status: (sessionId: number, status: 'running' | 'idle'): Line => ({
    jsonrpc: '2.0',
    method: 'session.status',
    params: { sessionId: key(sessionId), status },
  }),
  frame: (sessionId: number, frame: Record<string, unknown>): Line => ({
    jsonrpc: '2.0',
    method: 'agent/assistant-stream',
    params: { sessionId: key(sessionId), frame },
  }),
}

/** The NDJSON body of `lines`, each checked against the stream contract. */
export function ndjson(lines: Line[]) {
  for (const line of lines) expectMatchesContract(line, 'agent-stream')
  return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : '')
}

/** Writes one turn: every event goes to the stream and the session's log. */
export class AgentTurnScript {
  readonly lines: Line[] = []
  private ended = false
  private interrupted = false
  private step = 0
  private attempts = 0
  private revision = 0

  constructor(
    readonly sessionId: number,
    readonly turn: number,
    private readonly log: Array<Record<string, unknown>>,
  ) {}

  /** The turn and step that step-scoped events carry. */
  get scope() {
    return { turn: this.turn, step: Math.max(1, this.step) }
  }

  /** Appends one durable event. */
  event(body: EventBody) {
    const line = notification.event(this.sessionId, this.log.length, body)
    this.log.push((line.params as { event: Record<string, unknown> }).event)
    this.lines.push(line)
    return this
  }

  /** Opens the next model step. */
  nextStep() {
    this.step += 1
    return this.event({ type: 'step/start', turn: this.turn, step: this.step })
  }

  /** Streams `text` live without logging it (a reply that never settles). */
  streamText(text: string) {
    this.attempts += 1
    const attemptId = `${key(this.sessionId)}#${this.turn}.${this.attempts}`
    this.lines.push(
      notification.frame(this.sessionId, { type: 'start', attemptId, revision: ++this.revision, turn: this.turn, step: Math.max(1, this.step) }),
      notification.frame(this.sessionId, {
        type: 'chunk', attemptId, revision: ++this.revision, index: 0, time: Date.now(),
        chunk: { type: 'text-delta', index: 0, text },
      }),
    )
    return attemptId
  }

  /** Streams the arguments of a tool call as the model writes them. */
  streamToolCall(callId: string, name: string, args: unknown) {
    this.attempts += 1
    const attemptId = `${key(this.sessionId)}#${this.turn}.${this.attempts}`
    this.lines.push(
      notification.frame(this.sessionId, { type: 'start', attemptId, revision: ++this.revision, turn: this.turn, step: Math.max(1, this.step) }),
      notification.frame(this.sessionId, {
        type: 'chunk', attemptId, revision: ++this.revision, index: 0, time: Date.now(),
        chunk: { type: 'tool-call-delta', index: 1, id: callId, name, argumentsDelta: JSON.stringify(args) },
      }),
    )
    this.event({
      type: 'assistant/message', ...this.scope, content: '', stopReason: 'tool_calls', provider: 'test', model: 'gpt-test',
      toolCalls: [{ callId, name, arguments: args }],
    })
    this.lines.push(notification.frame(this.sessionId, {
      type: 'end', attemptId, revision: ++this.revision, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: this.log.length - 1 },
    }))
    return this
  }

  /** A tool call and its successful result (`output` is the tool's output). */
  tool(callId: string, name: string, args: unknown, output: unknown, extra: { meta?: unknown; summary?: string } = {}) {
    this.event({ type: 'tool/call', ...this.scope, callId, name, arguments: args, hosted: false })
    return this.event({
      type: 'tool/result', ...this.scope, callId, name, isError: false, hosted: false,
      content: [{ type: 'text', text: extra.summary ?? `${name} done` }],
      value: { name, summary: extra.summary ?? `${name} done`, output },
      ...(extra.meta ? { meta: extra.meta } : {}),
    })
  }

  /** A tool call that failed with `message`. */
  toolError(callId: string, name: string, args: unknown, message: string) {
    this.event({ type: 'tool/call', ...this.scope, callId, name, arguments: args, hosted: false })
    return this.event({
      type: 'tool/result', ...this.scope, callId, name, isError: true, hosted: false, value: null,
      content: [{ type: 'text', text: message }],
    })
  }

  /** Files a call hands to the user. */
  deliver(callId: string, ...files: Array<string | { path: string; description?: string }>) {
    return this.event({
      type: 'deliverables/presented', turn: this.turn, callId,
      files: files.map((file) => (typeof file === 'string' ? { path: file } : file)),
    })
  }

  /** Streams `content` and logs it as the step's reply. */
  reply(content: string) {
    if (!this.step) this.nextStep()
    const attemptId = this.streamText(content)
    this.event({ type: 'assistant/message', ...this.scope, content, stopReason: 'stop', provider: 'test', model: 'gpt-test' })
    this.lines.push(notification.frame(this.sessionId, {
      type: 'end', attemptId, revision: ++this.revision, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: this.log.length - 1 },
    }))
    return this
  }

  /** Ends the turn. */
  end(reason = 'completed', error?: string) {
    this.ended = true
    return this.event({ type: 'turn/end', turn: this.turn, reason, ...(error ? { error } : {}) })
  }

  /** Stops the stream before the turn is known to have ended. */
  interrupt() {
    this.interrupted = true
    return this
  }

  /** The stream's lines: `running`, the turn, and `idle` unless interrupted. */
  finish() {
    if (!this.ended && !this.interrupted) this.end()
    return [
      notification.status(this.sessionId, 'running'),
      ...this.lines,
      ...(this.interrupted ? [] : [notification.status(this.sessionId, 'idle')]),
    ]
  }
}

type TurnRequest = { sessionId: number; body: Record<string, unknown>; call: number; request: Request }

/**
 * Answers every agent stream request of `page` with the turn `script`
 * writes. The turn opens with `turn/start`, `step/start`, and the request's
 * `user/message`; a script that does not end it ends it completed.
 */
export async function mockAgentTurn(
  page: Page,
  script: (turn: AgentTurnScript, request: TurnRequest) => void | Promise<void>,
) {
  const logs = new Map<number, Array<Record<string, unknown>>>()
  const requests: TurnRequest[] = []
  await page.route('**/api/v1/agent/sessions/*/messages/stream', async (route) => {
    const sessionId = Number(route.request().url().match(/sessions\/(\d+)/)?.[1])
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    const log = logs.get(sessionId) ?? []
    logs.set(sessionId, log)
    const turnNumber = log.filter((event) => event.type === 'turn/start').length + 1
    const turn = new AgentTurnScript(sessionId, turnNumber, log)
    const request = { sessionId, body, call: requests.length + 1, request: route.request() }
    requests.push(request)
    turn.event({ type: 'turn/start', turn: turnNumber })
    turn.nextStep()
    const kind = body.shell_approval ? 'approval' : body.hide_user_message ? 'context-action' : 'user'
    turn.event({ type: 'user/message', content: [{ type: 'text', text: String(body.content ?? '') }], source: { kind } })
    await script(turn, request)
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: ndjson(turn.finish()) })
  })
  await page.route('**/api/v1/agent/sessions/*/session-events*', async (route) => {
    const url = new URL(route.request().url())
    const sessionId = Number(url.pathname.match(/sessions\/(\d+)/)?.[1])
    const raw = url.searchParams.get('after')
    const after = raw === null ? -1 : Number(raw)
    const items = (logs.get(sessionId) ?? []).filter((event) => Number(event.seq) > after)
    const next = items.length ? Number(items.at(-1)!.seq) : after
    const page = { items, ...(next < 0 ? {} : { next_after: next }) }
    expectMatchesContract(page, 'agent-session-events', 'page')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 200, data: page }),
    })
  })
  return { requests, logs }
}
