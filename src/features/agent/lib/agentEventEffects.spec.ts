import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import documentWriteTurn from './__fixtures__/documentWriteTurn.json'
import hostedCallsTurn from './__fixtures__/hostedCallsTurn.json'
import { effectsOfEvent, stepAgentSession } from './agentEventEffects'
import {
  applyAssistantStream,
  applySessionEvent,
  emptyAgentSessionView,
  type AgentAssistantStreamFrame,
  type AgentSessionView,
} from './agentSessionView'

const events = (fixture: unknown) => fixture as AgentSessionEventsSessionEvent[]

/** Runs the hook's order: effects from the view before each event, then the reducer. */
function collect(list: AgentSessionEventsSessionEvent[], view = emptyAgentSessionView()) {
  const effects: unknown[] = []
  let current = view
  for (const event of list) {
    effects.push(...effectsOfEvent(event, current))
    current = applySessionEvent(current, event)
  }
  return { effects, view: current }
}

let seq = -1
const at = () => {
  seq += 1
  return seq
}
/** Opens a fresh log: every list starts with it at seq 0. */
const turnStart = (): AgentSessionEventsSessionEvent => {
  seq = -1
  return { seq: at(), at: seq, type: 'turn/start', turn: 1 }
}
const call = (callId: string, name: string, args: unknown = {}): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'tool/call', turn: 1, step: 1, callId, name, arguments: args, hosted: false,
})
const ok = (callId: string, name: string, output: unknown, meta?: Record<string, unknown>): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'tool/result', turn: 1, step: 1, callId, name, isError: false, content: [], hosted: false,
  value: { name, summary: '', output }, ...(meta ? { meta } : {}),
})
const failed = (callId: string, name: string): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'tool/result', turn: 1, step: 1, callId, name, isError: true, value: null, hosted: false,
  content: [{ type: 'text', text: 'invalid patch' }],
})
const turnEnd = (reason: 'completed' | 'cancelled' | 'failed'): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'turn/end', turn: 1, reason,
})

describe('effectsOfEvent', () => {
  it('reports the written document and the delivered file', () => {
    const { effects } = collect(events(documentWriteTurn))
    expect(effects).toEqual([
      { type: 'documents-modified', paths: ['Notes/plan.md'] },
      { type: 'deliverables-saved', paths: ['Notes/plan.md'] },
    ])
  })

  it('reports hosted image deliverables only', () => {
    expect(collect(events(hostedCallsTurn)).effects).toEqual([
      { type: 'deliverables-saved', paths: ['Agent/images/1/ig_1.png'] },
    ])
  })

  it('fires nothing for events already reduced', () => {
    const list = events(documentWriteTurn)
    const { view } = collect(list)
    expect(collect(list, view).effects).toEqual([])
  })

  it('collects every file a completed patch changed and ignores failed patches', () => {
    const { effects } = collect([
      turnStart(),
      call('p1', 'apply_patch'),
      ok('p1', 'apply_patch', {
        file_ops: [{ path: 'Docs/Article.md' }],
        changes: [{ path: 'Docs/Article.md' }, { path: 'Docs/Notes.md' }],
      }),
      call('p2', 'apply_patch'),
      failed('p2', 'apply_patch'),
    ])
    expect(effects).toEqual([{ type: 'documents-modified', paths: ['Docs/Article.md', 'Docs/Notes.md'] }])
  })

  it('falls back to the call path of a document write', () => {
    const { effects } = collect([
      turnStart(),
      call('d1', 'document_write', { path: 'Docs/From-args.md' }),
      ok('d1', 'document_write', { operation: 'updated' }),
    ])
    expect(effects).toEqual([{ type: 'documents-modified', paths: ['Docs/From-args.md'] }])
  })

  it('announces a configured SMTP connection', () => {
    const { effects } = collect([
      turnStart(),
      call('s1', 'configure_smtp_connection', { password: '[redacted]' }),
      ok('s1', 'configure_smtp_connection', { id: 'conn-1', workflow_id: 'wf-2', workflow_attached: true }),
    ])
    expect(effects).toEqual([{
      type: 'connections-changed',
      detail: { source: 'configure_smtp_connection', connectionId: 'conn-1', workflowId: 'wf-2', workflowAttached: true },
    }])
  })
})

describe('stepAgentSession', () => {
  const sessionId = 'agent:7'
  it('applies the next event with its effects and stops at a gap', () => {
    const list = events(documentWriteTurn)
    let view = emptyAgentSessionView()
    const effects: unknown[] = []
    for (const event of list) {
      const step = stepAgentSession(view, { jsonrpc: '2.0', method: 'session.event', params: { sessionId, event } })
      expect(step.gap).toBe(false)
      effects.push(...step.effects)
      view = step.view
    }
    expect(view.cursor).toBe(13)
    expect(effects).toHaveLength(2)
    const gap = stepAgentSession(emptyAgentSessionView(), {
      jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: list[3] },
    })
    expect(gap).toEqual({ view: emptyAgentSessionView(), effects: [], gap: true })
  })

  it('tracks status and the live attempt', () => {
    const running = stepAgentSession(emptyAgentSessionView(), {
      jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' },
    }).view
    expect(running.running).toBe(true)
    const live = stepAgentSession(running, {
      jsonrpc: '2.0', method: 'agent/assistant-stream',
      params: { sessionId, frame: { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 } },
    }).view
    expect(live.live?.attemptId).toBe('a')
  })
})
