import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ScenarioBuildEvent } from '@/features/scenario/types'

import { BuildProgressCard } from './BuildProgressCard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

async function rerender(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root!.render(node)
    await Promise.resolve()
  })
}

function render(events: ScenarioBuildEvent[], title?: string) {
  return createElement(BuildProgressCard, { events, title })
}

// Helper: get all data-status values for the 4 rows
function getRowStatuses(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="progress-row-"]')).map(
    (el) => el.getAttribute('data-status') ?? '',
  )
}

function getPercentText(): string | null {
  return container.querySelector('[data-testid="progress-percent"]')?.textContent ?? null
}

function hasRunningSpinner(): boolean {
  return (
    container.querySelector(
      '[data-testid="progress-card-header-spinner"], [data-testid="progress-step-spinner"]',
    ) !== null
  )
}

describe('BuildProgressCard', () => {
  beforeEach(async () => {
    await unmount()
  })

  // 1. Empty events → all pending, 0%
  it('renders all 4 subtask labels when events is empty', async () => {
    await mount(render([]))
    expect(container.textContent).toContain('Generate fields')
    expect(container.textContent).toContain('Generate AI fields')
    expect(container.textContent).toContain('Generate records')
    expect(container.textContent).toContain('Generate views')
  })

  it('shows 0% when events is empty', async () => {
    await mount(render([]))
    expect(getPercentText()).toBe('0%')
  })

  it('has all rows as pending when events is empty', async () => {
    await mount(render([]))
    const statuses = getRowStatuses()
    expect(statuses).toHaveLength(4)
    expect(statuses.every((s) => s === 'pending')).toBe(true)
  })

  it('shows no running spinner when events is empty', async () => {
    await mount(render([]))
    expect(hasRunningSpinner()).toBe(false)
  })

  // 2. First event triggers running on first pending subtask
  it('sets Generate fields to running when first event arrives (base.created)', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
    ]
    await mount(render(events))
    const statuses = getRowStatuses()
    expect(statuses[0]).toBe('running')
    expect(statuses[1]).toBe('pending')
    expect(statuses[2]).toBe('pending')
    expect(statuses[3]).toBe('pending')
  })

  it('progress is still 0% when only base.created received', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
    ]
    await mount(render(events))
    expect(getPercentText()).toBe('0%')
  })

  // 3. fields.generated stage='fields' marks Generate fields done
  it('marks Generate fields done and Generate AI fields running', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
      { kind: 'fields.generated', stage: 'fields', count: 3 },
    ]
    await mount(render(events))
    const statuses = getRowStatuses()
    expect(statuses[0]).toBe('done')
    expect(statuses[1]).toBe('running')
    expect(statuses[2]).toBe('pending')
    expect(statuses[3]).toBe('pending')
  })

  it('shows 25% when Generate fields is done', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
      { kind: 'fields.generated', stage: 'fields', count: 3 },
    ]
    await mount(render(events))
    expect(getPercentText()).toBe('25%')
  })

  // 4. All 4 subtasks done at 100%
  it('marks all rows done at 100% when all 4 events received', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
      { kind: 'fields.generated', stage: 'fields', count: 3 },
      { kind: 'fields.generated', stage: 'ai-fields', count: 2 },
      { kind: 'records.generated', count: 10 },
      { kind: 'views.generated', viewKind: 'grid', viewId: 'v1', viewName: 'Grid' },
    ]
    await mount(render(events))
    const statuses = getRowStatuses()
    expect(statuses.every((s) => s === 'done')).toBe(true)
  })

  it('shows 100% when all 4 subtasks done', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'fields.generated', stage: 'fields', count: 3 },
      { kind: 'fields.generated', stage: 'ai-fields', count: 2 },
      { kind: 'records.generated', count: 10 },
      { kind: 'views.generated', viewKind: 'grid', viewId: 'v1', viewName: 'Grid' },
    ]
    await mount(render(events))
    expect(getPercentText()).toBe('100%')
  })

  it('shows no running spinner when all 4 subtasks are done', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'fields.generated', stage: 'fields', count: 3 },
      { kind: 'fields.generated', stage: 'ai-fields', count: 2 },
      { kind: 'records.generated', count: 10 },
      { kind: 'views.generated', viewKind: 'grid', viewId: 'v1', viewName: 'Grid' },
    ]
    await mount(render(events))
    expect(hasRunningSpinner()).toBe(false)
  })

  // 5. Title prop is rendered
  it('renders the title prop in the header', async () => {
    await mount(render([], 'Receipt Management'))
    expect(container.textContent).toContain('Receipt Management')
  })

  // 6. Title fallback
  it('renders "Building base..." when no title prop is provided', async () => {
    await mount(render([]))
    expect(container.textContent).toContain('Building base...')
  })

  // 7. Stable derivation
  it('produces identical status markers when rerendered with the same events', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b1', baseName: 'X' },
      { kind: 'fields.generated', stage: 'fields', count: 3 },
    ]
    await mount(render(events))
    const before = getRowStatuses()
    await rerender(render(events))
    const after = getRowStatuses()
    expect(after).toEqual(before)
  })

  // 8. Out-of-order events still work
  it('correctly handles out-of-order events', async () => {
    const events: ScenarioBuildEvent[] = [
      { kind: 'views.generated', viewKind: 'grid', viewId: 'v1', viewName: 'Grid' },
      { kind: 'fields.generated', stage: 'fields', count: 3 },
      { kind: 'records.generated', count: 10 },
      { kind: 'fields.generated', stage: 'ai-fields', count: 2 },
    ]
    await mount(render(events))
    const statuses = getRowStatuses()
    expect(statuses.every((s) => s === 'done')).toBe(true)
    expect(getPercentText()).toBe('100%')
  })
})
