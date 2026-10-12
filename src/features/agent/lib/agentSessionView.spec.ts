import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import approvalTurns from './__fixtures__/approvalTurns.json'
import cancelledImageTurn from './__fixtures__/cancelledImageTurn.json'
import documentWriteTurn from './__fixtures__/documentWriteTurn.json'
import hostedCallsTurn from './__fixtures__/hostedCallsTurn.json'
import imageComposerTurns from './__fixtures__/imageComposerTurns.json'
import updatePlanTurn from './__fixtures__/updatePlanTurn.json'
import {
  applyAssistantStream,
  applySessionEvent,
  applyStatus,
  emptyAgentSessionView,
  markInterrupted,
  pendingApprovalOf,
  type AgentAssistantStreamFrame,
  type AgentSessionView,
} from './agentSessionView'

const events = (fixture: unknown) => fixture as AgentSessionEventsSessionEvent[]

function reduce(list: AgentSessionEventsSessionEvent[], view = emptyAgentSessionView()) {
  return list.reduce(applySessionEvent, view)
}

function stream(view: AgentSessionView, frames: AgentAssistantStreamFrame[]) {
  return frames.reduce(applyAssistantStream, view)
}

describe('applySessionEvent', () => {
  it('turns a document write into one completed turn', () => {
    const view = reduce(events(documentWriteTurn))
    expect(view.cursor).toBe(14)
    expect(view.turns).toHaveLength(1)
    const [turn] = view.turns
    expect(turn).toMatchObject({
      turn: 1,
      startedAt: 1791732515436,
      source: 'user',
      userText: 'Write a short plan',
      userImages: [],
      preset: 'apply',
      reply: 'Updated.',
      end: { reason: 'completed', error: '', at: 1791732515449 },
    })
    expect(turn.steps.map((step) => step.step)).toEqual([1, 2])
    expect(turn.steps[0].message).toMatchObject({ content: '', toolCallCount: 1, model: 'test-model' })
    expect(turn.toolRuns).toEqual([{
      callId: 'call_1',
      name: 'document_write',
      arguments: { path: 'Notes/plan.md', content: '# Plan' },
      status: 'completed',
      summary: 'Updated document: `Notes/plan.md`',
      output: { path: 'Notes/plan.md', operation: 'updated', chars: 6, at: true },
      error: '',
      meta: undefined,
      hosted: false,
      startedAt: 1791732515442,
      endedAt: 1791732515444,
    }])
    expect(turn.deliverables).toEqual([
      { callId: 'call_1', path: 'Notes/plan.md', description: 'Updated: Notes/plan.md' },
    ])
  })

  it('ignores events at or below the cursor', () => {
    const list = events(documentWriteTurn)
    const once = reduce(list)
    expect(reduce(list, once)).toBe(once)
    const partly = reduce(list.slice(0, 8))
    expect(reduce(list.slice(4), partly)).toEqual(once)
  })

  it('keeps hidden user sources out of the turn text', () => {
    const [turn] = reduce(events(hostedCallsTurn)).turns
    expect(turn.source).toBe('user')
    expect(turn.userText).toBe('Draw a fox')
    expect(turn.reply).toBe('Done.')
    expect(turn.toolRuns.map((run) => [run.callId, run.name, run.hosted, run.status])).toEqual([
      ['ws_1', 'web_search', true, 'completed'],
      ['ig_1', 'image_generation', true, 'completed'],
    ])
    expect(turn.deliverables).toEqual([{ callId: 'ig_1', path: 'Agent/images/1/ig_1.png' }])
  })

  it('reads the todo list and its explanation from update_plan', () => {
    const [turn] = reduce(events(updatePlanTurn)).turns
    expect(turn.todos).toEqual({
      explanation: 'Two steps',
      items: [
        { content: 'Draft', status: 'in_progress' },
        { content: 'Review', status: 'pending' },
      ],
    })
  })

  it('follows an approval from the ask to the resumed turn', () => {
    const list = events(approvalTurns)
    const asked = reduce(list.slice(0, 11))
    const [first] = asked.turns
    expect(first.end?.reason).toBe('awaiting-approval')
    expect(first.toolRuns[0].status).toBe('awaiting_approval')
    expect(first.approval).toEqual({
      id: 'approval:call_1',
      callId: 'call_1',
      toolName: 'exec_command',
      reason: 'Command not covered by any rule; user approval required.',
      request: {
        kind: 'shell.approval',
        command: 'ls && touch approved.txt',
        reason: 'Command not covered by any rule; user approval required.',
        requires: 'approval',
        decision: 'prompt',
        suggested: { prefix: ['ls'], decision: 'allow' },
      },
    })
    expect(first.reply).toBeUndefined()
    expect(pendingApprovalOf(asked)).toBe(first.approval)

    const resumed = reduce(list.slice(11), asked)
    expect(pendingApprovalOf(resumed)).toBeNull()
    expect(resumed.turns[0].approval?.decided).toBe('allowed-once')
    expect(resumed.turns[0].toolRuns[0].status).toBe('completed')
    expect(resumed.turns[1]).toMatchObject({ source: 'approval', userText: 'Approved', reply: 'Done.' })
    expect(resumed.turns[1].toolRuns[0]).toMatchObject({ callId: 'call_1', status: 'completed' })
  })

  it('marks a rejected approval as failed and clears the pending card', () => {
    const list = events(approvalTurns).slice(0, 12).map((event) => (
      event.type === 'approval/decided' ? { ...event, outcome: 'rejected' as const } : event
    ))
    const view = reduce(list)
    expect(view.turns[0].approval?.decided).toBe('rejected')
    expect(view.turns[0].toolRuns[0].status).toBe('failed')
    expect(pendingApprovalOf(view)).toBeNull()
  })

  it('keeps the error of a cancelled image turn and inherits the preset', () => {
    const view = reduce(events(cancelledImageTurn))
    const [cancelled, next] = view.turns
    expect(cancelled.end).toEqual({ reason: 'cancelled', error: 'canceled', at: 1791732515373 })
    expect(cancelled.reply).toBeUndefined()
    expect(cancelled.toolRuns[0]).toMatchObject({
      status: 'failed',
      error: 'canceled',
      output: { code: 'image_generation_canceled', message: 'canceled', retryable: true },
    })
    expect(next.reply).toBe('Done.')
    const composer = reduce(events(imageComposerTurns))
    expect(composer.turns[1].preset).toBe('apply')
  })

  it('fails runs still open when a turn ends', () => {
    const view = reduce([
      { seq: 1, at: 1, type: 'turn/start', turn: 1 },
      { seq: 2, at: 2, type: 'tool/call', callId: 'call_9', name: 'document_read', arguments: {} },
      { seq: 3, at: 3, type: 'turn/end', turn: 1, reason: 'cancelled' },
    ])
    expect(view.turns[0].toolRuns[0]).toMatchObject({ status: 'failed', endedAt: 3 })
  })

  it('reads failure details and retries', () => {
    const view = reduce([
      { seq: 1, at: 1, type: 'turn/start', turn: 1 },
      { seq: 2, at: 2, type: 'step/start', turn: 1, step: 1 },
      {
        seq: 3, at: 3, type: 'llm/retry', retryId: 'agent:7#1.1', turn: 1, step: 1, provider: 'openai',
        mode: 'normal', policyKey: 'engine', retry: 1, maxRetries: 5, delayMs: 500,
        failure: { message: 'overloaded', code: 'rate_limited' },
      },
      { seq: 4, at: 4, type: 'llm/retry-started', retryId: 'agent:7#1.1', turn: 1, step: 1, retry: 1 },
      { seq: 5, at: 5, type: 'tool/call', callId: 'call_1', name: 'apply_patch', arguments: { patch_chars: 12 } },
      {
        seq: 6, at: 6, type: 'tool/result', callId: 'call_1', name: 'apply_patch', value: null, isError: true,
        content: [
          { type: 'text', text: 'patch did not apply' },
          { type: 'text', text: '{"name":"apply_patch","summary":"Patch failed","output":{"path":"Docs/a.md"},"failed":true}' },
        ],
      },
      { seq: 7, at: 7, type: 'assistant/attempt', error: 'stream closed' },
      { seq: 8, at: 8, type: 'turn/end', turn: 1, reason: 'failed', error: 'stream closed' },
    ])
    const [turn] = view.turns
    expect(turn.retries).toEqual([{
      retryId: 'agent:7#1.1', step: 1, retry: 1, maxRetries: 5, delayMs: 500,
      failure: { message: 'overloaded', code: 'rate_limited' }, at: 3, started: true,
    }])
    expect(turn.toolRuns[0]).toMatchObject({
      status: 'failed', error: 'patch did not apply', summary: 'Patch failed', output: { path: 'Docs/a.md' },
    })
    expect(turn.steps[0].attemptError).toBe('stream closed')
    expect(turn.end).toEqual({ reason: 'failed', error: 'stream closed', at: 8 })
  })

  it('strips the table plan block from the reply', () => {
    const view = reduce([
      { seq: 1, at: 1, type: 'turn/start', turn: 1 },
      { seq: 2, at: 2, type: 'step/start', turn: 1, step: 1 },
      {
        seq: 3, at: 3, type: 'assistant/message', stopReason: 'completed', model: 'm',
        content: 'Ready.\n```table_plan\n{"summary":"Import"}\n```',
      },
      { seq: 4, at: 4, type: 'turn/end', turn: 1, reason: 'completed' },
    ])
    expect(view.turns[0].reply).toBe('Ready.')
  })
})

describe('applyAssistantStream', () => {
  const start = (revision: number, attemptId = 'agent:7#1.1'): AgentAssistantStreamFrame => ({
    type: 'start', attemptId, revision, turn: 1, step: 1,
  })
  const text = (revision: number, index: number, value: string): AgentAssistantStreamFrame => ({
    type: 'chunk', attemptId: 'agent:7#1.1', revision, index, time: revision,
    chunk: { type: 'text-delta', index: 0, text: value },
  })
  const opened = reduce(events(documentWriteTurn).slice(0, 5))

  it('accumulates text and tool arguments by call id', () => {
    const view = stream(opened, [
      start(1),
      text(2, 0, 'Hel'),
      text(3, 1, 'lo'),
      {
        type: 'chunk', attemptId: 'agent:7#1.1', revision: 4, index: 2, time: 4,
        chunk: { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'document_write', argumentsDelta: '{"pa' },
      },
      {
        type: 'chunk', attemptId: 'agent:7#1.1', revision: 5, index: 3, time: 5,
        chunk: { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: 'th":"a.md"}' },
      },
    ])
    expect(view.revision).toBe(5)
    expect(view.live).toEqual({
      attemptId: 'agent:7#1.1',
      turn: 1,
      step: 1,
      text: 'Hello',
      toolArgs: { call_1: { name: 'document_write', args: '{"path":"a.md"}' } },
    })
  })

  it('ignores frames whose revision is not newer, across turns', () => {
    const view = stream(opened, [start(1), text(2, 0, 'Hi'), text(2, 0, 'Hi'), text(1, 0, '!')])
    expect(view.live?.text).toBe('Hi')
    const ended = stream(view, [{
      type: 'end', attemptId: 'agent:7#1.1', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 },
    }])
    expect(ended.live).toBeNull()
    expect(stream(ended, [start(3, 'agent:7#2.1')]).live).toBeNull()
    expect(stream(ended, [start(4, 'agent:7#2.1')]).live?.attemptId).toBe('agent:7#2.1')
  })

  it('keeps the text of an attempt that settled without a message', () => {
    const view = stream(opened, [start(1), text(2, 0, 'Half an ans'), {
      type: 'end', attemptId: 'agent:7#1.1', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 6 },
    }])
    expect(view.live).toBeNull()
    expect(view.turns[0].partialReply).toBe('Half an ans')
  })

  it('drops chunks of another attempt', () => {
    const view = stream(opened, [start(1), {
      type: 'chunk', attemptId: 'agent:7#9.1', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: 'stale' },
    }])
    expect(view.live?.text).toBe('')
    expect(view.revision).toBe(2)
  })
})

describe('status and interruption', () => {
  it('tracks running and clears live text when idle', () => {
    const running = applyStatus(emptyAgentSessionView(), 'running')
    expect(running.running).toBe(true)
    const streaming = applyAssistantStream(running, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 })
    const idle = applyStatus(streaming, 'idle')
    expect(idle).toMatchObject({ running: false, live: null })
  })

  it('marks the open turn interrupted with its partial text', () => {
    const opened = applyStatus(reduce(events(documentWriteTurn).slice(0, 5)), 'running')
    const streaming = stream(opened, [
      { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 },
      { type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: 'Part' } },
    ])
    const view = markInterrupted(streaming)
    expect(view).toMatchObject({ running: false, live: null })
    expect(view.turns[0]).toMatchObject({ interrupted: true, partialReply: 'Part' })
    expect(view.turns[0].end).toBeUndefined()
  })

  it('leaves ended turns alone', () => {
    const ended = reduce(events(documentWriteTurn))
    expect(markInterrupted(ended).turns[0].interrupted).toBeUndefined()
  })
})
