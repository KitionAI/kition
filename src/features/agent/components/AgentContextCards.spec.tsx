import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { applySessionEvent, emptyAgentSessionView } from '../lib/agentSessionView'
import { AgentContextCards } from './AgentContextCards'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

type Body = { type: string } & Record<string, unknown>

/** A one-turn session log in `preset`, numbered from seq 1. */
function viewOf(preset: string, bodies: Body[]) {
  const list = [
    { type: 'turn/start', turn: 1 },
    { type: 'step/start', turn: 1, step: 1 },
    { type: 'permission/preset', preset },
    ...bodies,
    { type: 'turn/end', turn: 1, reason: 'completed' },
  ].map((body, index) => ({ seq: index + 1, at: index + 1, ...body }) as AgentSessionEventsSessionEvent)
  return list.reduce(applySessionEvent, emptyAgentSessionView())
}

const planReply = (plan: Record<string, unknown>): Body => ({
  type: 'assistant/message', stopReason: 'stop', model: 'm',
  content: `Here is the plan.\n\`\`\`table_plan\n${JSON.stringify(plan)}\n\`\`\``,
})

const wrote = (created: number, updated: number): Body[] => [
  { type: 'tool/call', callId: 'c1', name: 'data_table_add_records', arguments: { unique_by: ['url'] } },
  {
    type: 'tool/result', callId: 'c1', name: 'data_table_add_records', isError: false, content: [],
    value: { name: 'data_table_add_records', summary: 'Wrote', output: { created, updated, skipped: 0 } },
  },
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('AgentContextCards', () => {
  it('hides an applied table plan that reports no actual changes', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentContextCards, {
        view: viewOf('apply', [...wrote(0, 0), planReply({ summary: 'Import' })]),
        busy: false,
      }))
    })

    expect(container.innerHTML).toBe('')
  })

  it('hides an applied table plan even when it contains result metrics', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentContextCards, {
        view: viewOf('apply', [...wrote(1, 2), planReply({ summary: 'Import' })]),
        busy: false,
      }))
    })

    expect(container.innerHTML).toBe('')
  })

  it('keeps a previewed table plan available for confirmation', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentContextCards, {
        view: viewOf('preview', [planReply({ summary: 'Import five rows', estimated_create: 5 })]),
        busy: false,
        onApplyPlan: () => {},
      }))
    })

    expect(container.textContent).toContain('Write plan')
    expect(container.textContent).toContain('+5')
    expect(container.textContent).toContain('Write to table')
  })
})
