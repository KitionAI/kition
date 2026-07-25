import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ScenarioBuildEvent,
  ScenarioBuildStatus,
  UseScenarioBuildResult,
} from '@/features/scenario/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock the hook before importing ScenarioRoute so the mock is in place
// when the module evaluates.
let mockState: {
  events: ScenarioBuildEvent[]
  status: ScenarioBuildStatus
  baseId: string | null
  baseName: string | null
  error: string | null
}
const submit = vi.fn<(prompt: string, files: File[]) => Promise<void>>(async () => {})
const abort = vi.fn()
const reset = vi.fn(() => {
  mockState = {
    events: [],
    status: 'idle',
    baseId: null,
    baseName: null,
    error: null,
  }
})

vi.mock('@/features/scenario/hooks/useScenarioBuild', () => ({
  useScenarioBuild: (): UseScenarioBuildResult => ({
    events: mockState.events,
    status: mockState.status,
    baseId: mockState.baseId,
    baseName: mockState.baseName,
    error: mockState.error,
    submit,
    abort,
    reset,
  }),
}))

import { ScenarioRoute } from './ScenarioRoute'

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

beforeEach(() => {
  mockState = {
    events: [],
    status: 'idle',
    baseId: null,
    baseName: null,
    error: null,
  }
  submit.mockClear()
  abort.mockClear()
  reset.mockClear()
})

afterEach(async () => {
  await unmount()
})

describe('ScenarioRoute', () => {
  it('renders ScenarioStartPage when status is idle', async () => {
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    expect(
      container.querySelector('[data-testid="scenario-heading"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="right-drawer"]')).toBeNull()
  })

  it('renders ScenarioBuildPage when status is streaming', async () => {
    mockState = {
      events: [{ kind: 'base.created', baseId: 'b1', baseName: 'Receipts' }],
      status: 'streaming',
      baseId: 'b1',
      baseName: 'Receipts',
      error: null,
    }
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    expect(
      container.querySelector('[data-testid="scenario-build-page"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="right-drawer"]'),
    ).not.toBeNull()
  })

  it('renders ScenarioBuildPage when status is submitting (no events yet)', async () => {
    mockState = {
      events: [],
      status: 'submitting',
      baseId: null,
      baseName: null,
      error: null,
    }
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    expect(
      container.querySelector('[data-testid="scenario-build-page"]'),
    ).not.toBeNull()
  })

  it('passes onSubmit through to ScenarioStartPage which calls hook.submit', async () => {
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    // Type into the prompt + click Start
    const ta = container.querySelector(
      '[data-testid="scenario-prompt-input"]',
    ) as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(ta, 'process receipts')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const btn = container.querySelector(
      '[data-testid="scenario-start-button"]',
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toBe('process receipts')
    expect(Array.isArray(submit.mock.calls[0][1])).toBe(true)
  })

  it('clicking Back on the build page resets the hook and calls onExit', async () => {
    mockState = {
      events: [{ kind: 'base.created', baseId: 'b1', baseName: 'Receipts' }],
      status: 'streaming',
      baseId: 'b1',
      baseName: 'Receipts',
      error: null,
    }
    const onExit = vi.fn()
    await mount(createElement(ScenarioRoute, { onExit }))
    const back = container.querySelector(
      '[data-testid="scenario-build-leave"]',
    ) as HTMLButtonElement
    await act(async () => {
      back.click()
    })
    expect(reset).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('renders ScenarioStartPage when status is aborted', async () => {
    mockState = {
      events: [],
      status: 'aborted',
      baseId: null,
      baseName: null,
      error: null,
    }
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    // Build view must NOT be shown — user is back to a clean slate.
    expect(container.querySelector('[data-testid="scenario-build-page"]')).toBeNull()
    // Start page heading should be present.
    expect(container.querySelector('[data-testid="scenario-heading"]')).not.toBeNull()
  })

  it('unmount calls reset (cleanup mid-build)', async () => {
    mockState = {
      events: [],
      status: 'streaming',
      baseId: null,
      baseName: null,
      error: null,
    }
    await mount(createElement(ScenarioRoute, { onExit: () => {} }))
    await unmount()
    expect(reset).toHaveBeenCalled()
  })
})
