import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import documentWriteTurn from './__fixtures__/documentWriteTurn.json'
import hostedCallsTurn from './__fixtures__/hostedCallsTurn.json'
import { effectsOfEvent, effectsOfStream, stepAgentSession } from './agentEventEffects'
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

const whiteboardPatch = {
  type: 'whiteboard.patch' as const,
  schema_version: 1 as const,
  summary: 'Create a node',
  operations: [{
    op: 'element.create' as const,
    element: { id: 'node-1', kind: 'mind_node' as const, bounds: { x: 10, y: 20, width: 140, height: 70 }, text: 'Idea' },
  }],
}

const designPatch = {
  type: 'design.patch' as const,
  schema_version: 1 as const,
  summary: 'Retitle',
  operations: [{ op: 'layer.update' as const, layer_id: 'title', changes: { text: 'Launch' } }],
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
  seq: at(), at: seq, type: 'tool/call', callId, name, arguments: args,
})
const ok = (callId: string, name: string, output: unknown, meta?: Record<string, unknown>): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'tool/result', callId, name, isError: false, content: [],
  value: { name, summary: '', output }, ...(meta ? { meta } : {}),
})
const failed = (callId: string, name: string): AgentSessionEventsSessionEvent => ({
  seq: at(), at: seq, type: 'tool/result', callId, name, isError: true, value: null,
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

  it('reports a created kitable and every table mutation', () => {
    const { effects } = collect([
      turnStart(),
      call('t1', 'data_table_create', { title: 'Samples' }),
      ok('t1', 'data_table_create', { path: 'Admissions/Low-threshold samples.kitable', document_id: 42, table_id: 7 }),
      call('t2', 'data_table_add_records'),
      ok('t2', 'data_table_add_records', { created: 2 }),
      call('t3', 'data_table_create', { kitable_path: 'Admissions/Fallback.kitable' }),
      ok('t3', 'data_table_create', {}),
      call('t4', 'data_table_add_fields'),
      failed('t4', 'data_table_add_fields'),
    ])
    expect(effects).toEqual([
      { type: 'documents-modified', paths: ['Admissions/Low-threshold samples.kitable'] },
      { type: 'table-mutated' },
      { type: 'table-mutated' },
      { type: 'documents-modified', paths: ['Admissions/Fallback.kitable'] },
      { type: 'table-mutated' },
    ])
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

  it('emits final patches from the result meta and cancels on a failed patch tool', () => {
    const { effects } = collect([
      turnStart(),
      call('w1', 'whiteboard_propose_patch'),
      ok('w1', 'whiteboard_propose_patch', {}, { kind: 'whiteboard.patch', patch: whiteboardPatch }),
      call('g1', 'design_propose_patch'),
      ok('g1', 'design_propose_patch', {}, { kind: 'design.patch', patch: designPatch }),
      call('w2', 'whiteboard_propose_patch'),
      failed('w2', 'whiteboard_propose_patch'),
      call('g2', 'design_propose_patch'),
      failed('g2', 'design_propose_patch'),
    ])
    expect(effects).toEqual([
      { type: 'whiteboard-patch', patch: whiteboardPatch, provisional: false },
      { type: 'design-patch', patch: designPatch, provisional: false },
      { type: 'whiteboard-patch-cancelled' },
      { type: 'design-patch-cancelled' },
    ])
  })

  it('cancels patches still open when the turn does not complete', () => {
    const { effects } = collect([
      turnStart(),
      call('w1', 'whiteboard_propose_patch'),
      call('g1', 'design_propose_patch'),
      turnEnd('cancelled'),
    ])
    expect(effects).toEqual([{ type: 'whiteboard-patch-cancelled' }, { type: 'design-patch-cancelled' }])
    const completed = collect([turnStart(), call('w1', 'whiteboard_propose_patch'), turnEnd('completed')])
    expect(completed.effects).toEqual([])
  })
})

describe('effectsOfStream', () => {
  const opened = applySessionEvent(emptyAgentSessionView(), { seq: 0, at: 1, type: 'turn/start', turn: 1 })
  const start: AgentAssistantStreamFrame = { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }
  const args = (revision: number, id: string, delta: string, name?: string): AgentAssistantStreamFrame => ({
    type: 'chunk', attemptId: 'a', revision, index: revision - 2, time: revision,
    chunk: { type: 'tool-call-delta', index: 1, id, argumentsDelta: delta, ...(name ? { name } : {}) },
  })

  function run(frames: AgentAssistantStreamFrame[], view: AgentSessionView = opened) {
    const effects: unknown[] = []
    let current = view
    for (const frame of frames) {
      effects.push(...effectsOfStream(frame, current))
      current = applyAssistantStream(current, frame)
    }
    return { effects, view: current }
  }

  it('emits a provisional patch once the streamed arguments parse', () => {
    const text = JSON.stringify(whiteboardPatch)
    const { effects } = run([
      start,
      args(2, 'w1', text.slice(0, 20), 'whiteboard_propose_patch'),
      args(3, 'w1', text.slice(20)),
      args(4, 'g1', JSON.stringify(designPatch), 'design_propose_patch'),
      args(5, 'x1', JSON.stringify(whiteboardPatch), 'document_write'),
    ])
    expect(effects).toEqual([
      { type: 'whiteboard-patch', patch: whiteboardPatch, provisional: true },
      { type: 'design-patch', patch: designPatch, provisional: true },
    ])
  })

  it('previews a patch once, on the delta that completes its arguments', () => {
    const first = run([start, args(2, 'w1', JSON.stringify(whiteboardPatch), 'whiteboard_propose_patch')])
    expect(first.effects).toHaveLength(1)
    expect(run([args(3, 'w1', '', 'whiteboard_propose_patch')], first.view).effects).toEqual([])
  })

  it('ignores frames of an attempt that is not live', () => {
    const other: AgentAssistantStreamFrame = {
      type: 'chunk', attemptId: 'b', revision: 2, index: 0, time: 2,
      chunk: { type: 'tool-call-delta', index: 1, id: 'w1', name: 'whiteboard_propose_patch', argumentsDelta: JSON.stringify(whiteboardPatch) },
    }
    expect(run([start, other]).effects).toEqual([])
  })

  it('cancels a provisional patch when its attempt settles without a message', () => {
    const streamed = run([start, args(2, 'w1', JSON.stringify(whiteboardPatch), 'whiteboard_propose_patch')])
    const attempt = run([{
      type: 'end', attemptId: 'a', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 1 },
    }], streamed.view)
    expect(attempt.effects).toEqual([{ type: 'whiteboard-patch-cancelled' }])
    const message = run([{
      type: 'end', attemptId: 'a', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
    }], streamed.view)
    expect(message.effects).toEqual([])
  })

  it('does not cancel a called patch when only its attempt ends', () => {
    const called = applySessionEvent(opened, {
      seq: 1, at: 2, type: 'tool/call', callId: 'w9', name: 'whiteboard_propose_patch', arguments: {},
    })
    const attempt = run([start, {
      type: 'end', attemptId: 'a', revision: 2, index: 0, outcome: { kind: 'abandoned' },
    }], called)
    expect(attempt.effects).toEqual([])
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
