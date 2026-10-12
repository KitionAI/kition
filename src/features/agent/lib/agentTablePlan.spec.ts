import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import documentWriteTurn from './__fixtures__/documentWriteTurn.json'
import { applySessionEvent, emptyAgentSessionView } from './agentSessionView'
import { deriveTablePlan, replyWithoutTablePlan } from './agentTablePlan'

type Call = { name: string; output: unknown; args?: unknown; isError?: boolean }

/** One completed turn in `preset` whose tools ran `calls` and whose final reply is `reply`. */
function turnOf(reply: string, preset: 'research' | 'preview' | 'apply', calls: Call[], reason: 'completed' | 'failed' = 'completed') {
  let seq = -1
  const next = () => {
    seq += 1
    return seq
  }
  const list: AgentSessionEventsSessionEvent[] = [
    { seq: next(), at: seq, type: 'turn/start', turn: 1 },
    { seq: next(), at: seq, type: 'step/start', turn: 1, step: 1 },
    { seq: next(), at: seq, type: 'permission/preset', preset },
  ]
  calls.forEach((call, index) => {
    const callId = `call_${index}`
    list.push({ seq: next(), at: seq, type: 'tool/call', callId, name: call.name, arguments: call.args ?? {} })
    list.push(call.isError
      ? {
        seq: next(), at: seq, type: 'tool/result', callId, name: call.name, value: null, isError: true,
        content: [
          { type: 'text', text: 'failed' },
          { type: 'text', text: JSON.stringify({ name: call.name, summary: '', output: call.output, failed: true }) },
        ],
      }
      : {
        seq: next(), at: seq, type: 'tool/result', callId, name: call.name, isError: false, content: [],
        value: { name: call.name, summary: '', output: call.output },
      })
  })
  list.push(
    { seq: next(), at: seq, type: 'assistant/message', content: reply, stopReason: 'completed', model: 'm' },
    { seq: next(), at: seq, type: 'turn/end', turn: 1, reason },
  )
  return list.reduce(applySessionEvent, emptyAgentSessionView()).turns[0]
}

describe('deriveTablePlan', () => {
  it('extracts and merges plans', () => {
    const content = 'Done.\n```table_plan\n{"summary":"Import posts","estimated_counts":{"create":3}}\n```'
    const turn = turnOf(content, 'apply', [
      { name: 'data_table_add_records', output: { created: 2, updated: 1, skipped: 0, unique_by: ['url'] } },
    ])
    expect(turn.reply).toBe('Done.')
    expect(deriveTablePlan(turn)).toEqual({
      summary: 'Import posts',
      estimated_create: 3,
      actual_created: 2,
      actual_updated: 1,
      actual_skipped: 0,
      final_unique_by: ['url'],
      recommended_unique_by: ['url'],
      execution_mode: 'apply',
      event_source: 'table_plan',
      applied: true,
    })
    expect(deriveTablePlan(turnOf('plain', 'apply', []))).toBeNull()
  })

  it('drafts a preview plan from the record draft and asks to apply it', () => {
    const turn = turnOf('Here is the draft.', 'preview', [{
      name: 'data_table_record_draft',
      output: {
        missing_fields: [{ title: 'Author' }, { title: ' ' }, { title: 'Title' }],
        recommended_unique_by: 'url',
        record_draft_count: '4',
      },
    }])
    expect(deriveTablePlan(turn)).toEqual({
      proposed_fields: ['Author', 'Title'],
      recommended_unique_by: ['url'],
      estimated_create: 4,
      summary: 'Drafted 4 table-ready records from current source',
      execution_mode: 'preview',
      event_source: 'table_plan',
      requires_apply_confirmation: true,
    })
  })

  it('normalizes the plan block and summarizes what the tools did', () => {
    const block = JSON.stringify({
      source_scope: ' Posts folder ',
      entity_name: 'Post',
      proposed_fields: ['Title', null, 7, ''],
      risks: 'Duplicates',
      unique_by: ['url'],
      estimated_update: 2.9,
      estimated_skip: '1',
      estimated_counts: { skip: 3 },
    })
    const turn = turnOf(`Applied.\n\`\`\`table_plan\n${block}\n\`\`\``, 'apply', [
      { name: 'data_table_add_fields', output: { created: [{ title: 'Summary' }, { title: 'Title' }] } },
      { name: 'table_upsert_records', args: { unique_by: ['slug'] }, output: { created: 1, updated: 0, skipped: 0 } },
    ])
    expect(deriveTablePlan(turn)).toEqual({
      source_scope: 'Posts folder',
      entity_name: 'Post',
      proposed_fields: ['Title', '7', 'Summary'],
      risks: ['Duplicates'],
      recommended_unique_by: ['url'],
      estimated_update: 2,
      estimated_skip: 3,
      created_field_titles: ['Summary', 'Title'],
      final_unique_by: ['slug'],
      actual_created: 1,
      actual_updated: 0,
      actual_skipped: 0,
      summary: 'Added fields: Summary, Title; Record changes: created 1, updated 0, skipped 0',
      execution_mode: 'apply',
      event_source: 'table_plan',
      applied: true,
    })
  })

  it('keeps a malformed block in the reply and reads failed tool output', () => {
    const content = 'Oops\n```table_plan\n{not json}\n```'
    const turn = turnOf(content, 'research', [
      { name: 'data_table_add_records', isError: true, output: { created: 0, updated: 0, skipped: 2 } },
    ])
    expect(turn.reply).toBe(content)
    expect(deriveTablePlan(turn)).toEqual({
      actual_skipped: 2,
      summary: 'Record changes: created 0, updated 0, skipped 2',
      execution_mode: 'research',
      event_source: 'table_plan',
    })
  })

  it('only reads completed turns', () => {
    const content = 'Done.\n```table_plan\n{"summary":"Import posts"}\n```'
    expect(deriveTablePlan(turnOf(content, 'apply', [], 'failed'))).toBeNull()
    const [turn] = (documentWriteTurn as unknown as AgentSessionEventsSessionEvent[])
      .reduce(applySessionEvent, emptyAgentSessionView()).turns
    expect(deriveTablePlan(turn)).toBeNull()
  })
})

describe('replyWithoutTablePlan', () => {
  it('removes every plan block and trims', () => {
    expect(replyWithoutTablePlan(' A\n```table_plan\n{"a":1}\n```\nB\n```table_plan {"b":2} ```\n')).toBe('A\n\nB')
    expect(replyWithoutTablePlan('  plain  ')).toBe('plain')
  })
})
