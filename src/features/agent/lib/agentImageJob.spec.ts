import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import cancelledImageTurn from './__fixtures__/cancelledImageTurn.json'
import hostedCallsTurn from './__fixtures__/hostedCallsTurn.json'
import imageComposerTurns from './__fixtures__/imageComposerTurns.json'
import { imageJobOf } from './agentImageJob'
import { applySessionEvent, emptyAgentSessionView } from './agentSessionView'

const events = (fixture: unknown) => fixture as AgentSessionEventsSessionEvent[]
const turnsOf = (list: AgentSessionEventsSessionEvent[]) => list.reduce(applySessionEvent, emptyAgentSessionView()).turns

const arguments_ = (index: number, count: number) => ({
  request_id: 'req-2', intent_sha256: 'f'.repeat(64), variant_index: index, variant_count: count,
  size: '1024x1024', quality: 'low', reference_count: 0,
})
const artifact = (index: number, count: number) => ({
  call_id: `img_abc_${index}`, path: `Agent/images/1/abc/variant-${index + 1}.png`, mime_type: 'image/png',
  variant_index: index, variant_count: count, created_at: '2026-10-11T00:00:00.000Z',
  provenance: { request_id: 'req-2' },
})

/** An image composer turn with `count` variants: `saved` succeed, then the events in `rest`. */
function composer(count: number, saved: number, rest: AgentSessionEventsSessionEvent[] = []) {
  let seq = 0
  const next = () => {
    seq += 1
    return seq
  }
  const list: AgentSessionEventsSessionEvent[] = [
    { seq: next(), at: seq, type: 'turn/start', turn: 1 },
    { seq: next(), at: seq, type: 'step/start', turn: 1, step: 1 },
    { seq: next(), at: seq, type: 'user/message', content: [{ type: 'text', text: 'Foxes' }], source: { kind: 'user' } },
  ]
  for (let index = 0; index < saved; index += 1) {
    list.push(
      { seq: next(), at: seq, type: 'tool/call', callId: `img_abc_${index}`, name: 'image_generation', arguments: arguments_(index, count) },
      {
        seq: next(), at: seq, type: 'tool/result', callId: `img_abc_${index}`, name: 'image_generation', isError: false,
        value: artifact(index, count), content: [{ type: 'text', text: `Generated image ${index + 1}` }],
        meta: { kind: 'image_generation.variant', request_id: 'req-2', artifact: artifact(index, count) },
      },
    )
  }
  for (const event of rest) list.push({ ...event, seq: next(), at: seq })
  return turnsOf(list)[0]
}

describe('imageJobOf', () => {
  it('reads a completed composer turn', () => {
    const [, turn] = turnsOf(events(imageComposerTurns))
    const job = imageJobOf(turn)
    expect(job).toMatchObject({ requestId: 'req-1', status: 'completed', progress: 1, error: null })
    expect(job?.artifacts.map((item) => item.path)).toEqual(['Agent/images/1/9456bdfa12ea76959c94a357/variant-1.png'])
  })

  it('has no job for turns without composer calls', () => {
    const turns = turnsOf(events(imageComposerTurns))
    expect(imageJobOf(turns[0])).toBeNull()
    expect(imageJobOf(turnsOf(events(hostedCallsTurn))[0])).toBeNull()
  })

  it('reports a cancelled request without an error', () => {
    const [turn] = turnsOf(events(cancelledImageTurn))
    expect(imageJobOf(turn)).toEqual({ requestId: 'req-1', status: 'canceled', progress: 1, artifacts: [], error: null })
  })

  it('reports progress while variants are generated and saved', () => {
    const generating = composer(3, 1, [
      { type: 'tool/call', callId: 'img_abc_1', name: 'image_generation', arguments: arguments_(1, 3) } as AgentSessionEventsSessionEvent,
    ])
    expect(imageJobOf(generating)).toMatchObject({ status: 'generating', progress: 1 / 3 })
    expect(imageJobOf(generating)?.artifacts).toHaveLength(1)
    expect(imageJobOf(composer(3, 2))).toMatchObject({ status: 'generating', progress: 2 / 3 })
    expect(imageJobOf(composer(3, 3))).toMatchObject({ status: 'saving', progress: 1 })
  })

  it('sorts artifacts by variant and reads the variant error of a failed request', () => {
    const turn = composer(3, 2, [
      { type: 'tool/call', callId: 'img_abc_2', name: 'image_generation', arguments: arguments_(2, 3) },
      {
        type: 'tool/result', callId: 'img_abc_2', name: 'image_generation', value: null, isError: true,
        content: [
          { type: 'text', text: 'provider down' },
          { type: 'text', text: '{"code":"image_provider_error","message":"provider down","retryable":true}' },
        ],
      },
      { type: 'step/end', turn: 1, step: 1 },
      { type: 'turn/end', turn: 1, reason: 'failed', error: 'provider down' },
    ] as AgentSessionEventsSessionEvent[])
    const job = imageJobOf(turn)
    expect(job).toMatchObject({
      status: 'failed', progress: 1,
      error: { code: 'image_provider_error', message: 'provider down', retryable: true },
    })
    expect(job?.artifacts.map((item) => item.variant_index)).toEqual([0, 1])
  })

  it('reports the turn error when no variant failed', () => {
    const turn = composer(1, 1, [
      { type: 'turn/end', turn: 1, reason: 'failed', error: 'could not save the reply' } as AgentSessionEventsSessionEvent,
    ])
    expect(imageJobOf(turn)).toMatchObject({
      status: 'failed',
      error: { code: 'image_generation_failed', message: 'could not save the reply', retryable: true },
    })
  })
})
