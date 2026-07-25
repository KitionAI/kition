import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workflow/lib/openWorkflowRoute', () => ({
  openWorkflowRoute: vi.fn(),
}))

import { openWorkflowRoute } from '@/features/workflow/lib/openWorkflowRoute'

import { useWorkflowModeDialogState } from './useWorkflowModeDialogState'

function HookSurface({ onResult, options = {} }: {
  onResult: (r: ReturnType<typeof useWorkflowModeDialogState>) => void
  options?: Parameters<typeof useWorkflowModeDialogState>[0]
}) {
  const result = useWorkflowModeDialogState(options)
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(openWorkflowRoute).mockReset()
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

describe('useWorkflowModeDialogState', () => {
  it('starts closed with no context, busy or error', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    expect(captured!.open).toBe(false)
    expect(captured!.context).toBeNull()
    expect(captured!.busyKind).toBeNull()
    expect(captured!.busyTemplateId).toBeUndefined()
    expect(captured!.error).toBeNull()
  })

  it('honours initialOpen so deep-linking to /workflow/new mounts already-open', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    expect(captured!.open).toBe(true)
  })

  it('openDialog clears stale error/busy and fires the onBeforeOpen hook', async () => {
    const onBeforeOpen = vi.fn()
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { onBeforeOpen } }))
    await act(async () => { captured!.openDialog() })
    expect(captured!.open).toBe(true)
    expect(captured!.error).toBeNull()
    expect(captured!.busyKind).toBeNull()
    expect(captured!.busyTemplateId).toBeUndefined()
    expect(captured!.context).toBeNull()
    expect(onBeforeOpen).toHaveBeenCalledTimes(1)
  })

  it('closeDialog resets every field back to the empty state', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    expect(captured!.open).toBe(true)
    await act(async () => { captured!.closeDialog() })
    expect(captured!.open).toBe(false)
    expect(captured!.context).toBeNull()
    expect(captured!.error).toBeNull()
    expect(captured!.busyKind).toBeNull()
    expect(captured!.busyTemplateId).toBeUndefined()
  })

  it('handleSelect kind=chat with no context navigates to /workflow/new?mode=ai instead of silently creating a draft', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    const runTemplate = vi.fn()
    const runScratch = vi.fn().mockResolvedValue(undefined)
    const assistantEvents: CustomEvent[] = []
    const listener = (e: Event) => { assistantEvents.push(e as CustomEvent) }
    window.addEventListener('kition:assistant:open', listener)
    try {
      await act(async () => {
        captured!.handleSelect({ kind: 'chat' } as any, { runTemplate, runScratch })
      })
      for (let i = 0; i < 8; i++) {
        await act(async () => { await Promise.resolve() })
        if (!captured!.open) break
      }
      // The old behaviour silently runScratch'd + popped the assistant
      // panel, conjuring a workflow row the user hadn't asked for.
      // Now the click just navigates and lets WorkflowRoute's
      // ai-no-context branch render the AI prompt page.
      expect(runScratch).not.toHaveBeenCalled()
      expect(runTemplate).not.toHaveBeenCalled()
      expect(vi.mocked(openWorkflowRoute)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(openWorkflowRoute)).toHaveBeenCalledWith(null, { mode: 'ai' })
      expect(captured!.open).toBe(false)
      expect(assistantEvents).toHaveLength(0)
    } finally {
      window.removeEventListener('kition:assistant:open', listener)
    }
  })

  it('handleSelect kind=template awaits the runTemplate fn then closes', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    const runTemplate = vi.fn().mockResolvedValue(undefined)
    const runScratch = vi.fn()
    const template = { id: 'tpl_a', name: 'Demo' } as any
    await act(async () => {
      captured!.handleSelect({ kind: 'template', template } as any, { runTemplate, runScratch })
    })
    // Allow the async chain inside handleSelect to settle.
    for (let i = 0; i < 8; i++) {
      await act(async () => { await Promise.resolve() })
      if (!captured!.open) break
    }
    expect(runTemplate).toHaveBeenCalledWith(template)
    expect(runScratch).not.toHaveBeenCalled()
    expect(captured!.open).toBe(false)
  })

  it('handleSelect kind=template surfaces an error message without closing the dialog', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    const runTemplate = vi.fn().mockRejectedValue(new Error('boom'))
    const runScratch = vi.fn()
    const template = { id: 'tpl_a', name: 'Demo' } as any
    await act(async () => {
      captured!.handleSelect({ kind: 'template', template } as any, { runTemplate, runScratch })
    })
    for (let i = 0; i < 8; i++) {
      await act(async () => { await Promise.resolve() })
      if (captured!.error) break
    }
    expect(captured!.open).toBe(true)
    expect(captured!.error).toBe('boom')
    expect(captured!.busyKind).toBeNull()
    expect(captured!.busyTemplateId).toBeUndefined()
  })

  it('marks busy / template id while the template runner is in flight', async () => {
    let captured: ReturnType<typeof useWorkflowModeDialogState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, options: { initialOpen: true } }))
    let resolveRun!: () => void
    const runTemplate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveRun = resolve }))
    const runScratch = vi.fn()
    const template = { id: 'tpl_a', name: 'Demo' } as any
    await act(async () => {
      captured!.handleSelect({ kind: 'template', template } as any, { runTemplate, runScratch })
    })
    // Inside the async IIFE — busy fields should already be set.
    expect(captured!.busyKind).toBe('template')
    expect(captured!.busyTemplateId).toBe('tpl_a')
    await act(async () => { resolveRun() })
    for (let i = 0; i < 8; i++) {
      await act(async () => { await Promise.resolve() })
      if (!captured!.open) break
    }
    expect(captured!.busyKind).toBeNull()
    expect(captured!.busyTemplateId).toBeUndefined()
  })
})
