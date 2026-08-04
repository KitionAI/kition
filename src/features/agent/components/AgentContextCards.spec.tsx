import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentContextCards } from './AgentContextCards'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

function tablePlanEvent(data: Record<string, unknown>) {
  return {
    id: 1,
    session_id: 1,
    user_id: 1,
    event_type: 'table.plan.generated',
    stage: 'plan',
    status: 'completed',
    label: 'Table plan generated',
    message: '',
    data,
    created_at: '2026-08-04T00:00:00.000Z',
  } as any
}

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
        events: [tablePlanEvent({
          applied: true,
          actual_created: 0,
          actual_updated: 0,
          actual_skipped: 0,
        })],
        busy: false,
      }))
    })

    expect(container.innerHTML).toBe('')
  })

  it('keeps an applied table plan when it contains real result metrics', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(AgentContextCards, {
        events: [tablePlanEvent({
          applied: true,
          actual_created: 1,
          actual_updated: 2,
          actual_skipped: 0,
        })],
        busy: false,
      }))
    })

    expect(container.textContent).toContain('Write complete')
    expect(container.textContent).toContain('+1')
  })
})
