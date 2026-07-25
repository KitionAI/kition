import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workflow/api', () => ({
  createWorkflow: vi.fn(),
}))
vi.mock('@/features/workflow/lib/createWorkflowFromTemplate', () => ({
  createWorkflowFromTemplate: vi.fn(),
}))

import { createWorkflow } from '@/features/workflow/api'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'

import { useWorkflowLauncherState } from './useWorkflowLauncherState'

function HookSurface({ onResult, deps }: {
  onResult: (r: ReturnType<typeof useWorkflowLauncherState>) => void
  deps: Parameters<typeof useWorkflowLauncherState>[0]
}) {
  const result = useWorkflowLauncherState(deps)
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(createWorkflow).mockReset()
  vi.mocked(createWorkflowFromTemplate).mockReset()
  window.sessionStorage.clear()
})
afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function settle(captured: { value: ReturnType<typeof useWorkflowLauncherState> | null }, until: () => boolean) {
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (until()) return
  }
}

describe('useWorkflowLauncherState', () => {
  it('starts idle with no busy / error fields', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    expect(captured.value!.busyAction).toBeNull()
    expect(captured.value!.busyTemplateId).toBeUndefined()
    expect(captured.value!.error).toBeNull()
  })

  it('runScratch creates a draft workflow, refreshes, and reports the new id via onCreated', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    vi.mocked(createWorkflow).mockResolvedValueOnce({ id: 'wf_new' } as any)
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    await act(async () => { await captured.value!.runScratch() })
    expect(vi.mocked(createWorkflow)).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith('wf_new')
    expect(captured.value!.busyAction).toBeNull()
    expect(captured.value!.error).toBeNull()
  })

  it('runScratch sets busyAction=scratch while the create call is in flight', async () => {
    let resolveCreate!: (def: any) => void
    vi.mocked(createWorkflow).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }) as any)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    let pending!: Promise<void>
    await act(async () => { pending = captured.value!.runScratch() })
    expect(captured.value!.busyAction).toBe('scratch')
    await act(async () => { resolveCreate({ id: 'wf_x' }); await pending })
    expect(captured.value!.busyAction).toBeNull()
  })

  it('runScratch surfaces a create error without leaving the busy flag set', async () => {
    vi.mocked(createWorkflow).mockRejectedValueOnce(new Error('boom'))
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    await act(async () => { await captured.value!.runScratch() })
    expect(captured.value!.error).toBe('boom')
    expect(captured.value!.busyAction).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('runTemplate threads through createWorkflowFromTemplate and stashes unresolved fields in sessionStorage', async () => {
    vi.mocked(createWorkflowFromTemplate).mockReturnValueOnce({
      input: { name: 't' } as any,
      unresolvedFieldNames: ['Name', 'Company'],
    })
    vi.mocked(createWorkflow).mockResolvedValueOnce({ id: 'wf_t' } as any)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const template = { id: 'tpl_a' } as any
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    await act(async () => { await captured.value!.runTemplate(template) })
    expect(onCreated).toHaveBeenCalledWith('wf_t')
    expect(window.sessionStorage.getItem('kition:workflow:template-unresolved:wf_t')).toBe(JSON.stringify(['Name', 'Company']))
  })

  it('runTemplate skips the sessionStorage handoff when every field resolved', async () => {
    vi.mocked(createWorkflowFromTemplate).mockReturnValueOnce({ input: { name: 't' } as any, unresolvedFieldNames: [] })
    vi.mocked(createWorkflow).mockResolvedValueOnce({ id: 'wf_t' } as any)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    await act(async () => { await captured.value!.runTemplate({ id: 'tpl_a' } as any) })
    expect(window.sessionStorage.getItem('kition:workflow:template-unresolved:wf_t')).toBeNull()
  })

  it('runTemplate marks busyTemplateId while the create call is in flight', async () => {
    vi.mocked(createWorkflowFromTemplate).mockReturnValueOnce({ input: { name: 't' } as any, unresolvedFieldNames: [] })
    let resolveCreate!: (def: any) => void
    vi.mocked(createWorkflow).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }) as any)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    let pending!: Promise<void>
    await act(async () => { pending = captured.value!.runTemplate({ id: 'tpl_a' } as any) })
    expect(captured.value!.busyAction).toBe('template')
    expect(captured.value!.busyTemplateId).toBe('tpl_a')
    await act(async () => { resolveCreate({ id: 'wf_t' }); await pending })
    expect(captured.value!.busyAction).toBeNull()
    expect(captured.value!.busyTemplateId).toBeUndefined()
  })

  it('clearError wipes the error message', async () => {
    vi.mocked(createWorkflow).mockRejectedValueOnce(new Error('boom'))
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    await act(async () => { await captured.value!.runScratch() })
    expect(captured.value!.error).toBe('boom')
    await act(async () => { captured.value!.clearError() })
    expect(captured.value!.error).toBeNull()
  })

  it('handleAgent dispatches the assistant-panel open event', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onCreated = vi.fn()
    const captured = { value: null as ReturnType<typeof useWorkflowLauncherState> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r }, deps: { refresh, onCreated } }))
    const listener = vi.fn()
    window.addEventListener('kition:assistant:open', listener)
    try {
      await act(async () => { captured.value!.handleAgent() })
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('kition:assistant:open', listener)
    }
  })
})
