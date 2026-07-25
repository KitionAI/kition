import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkflowDefinition } from '@/features/workflow/api'

import { useWorkflowDraftState } from './useWorkflowDraftState'

function HookSurface({ onResult, selected }: {
  onResult: (r: ReturnType<typeof useWorkflowDraftState>) => void
  selected: WorkflowDefinition | null
}) {
  const result = useWorkflowDraftState(selected)
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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

function makeWorkflow(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf_a',
    name: 'Sample',
    description: '',
    enabled: false,
    trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' } as any,
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: { parts: [{ kind: 'text' as const, text: 'New lead' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    } as any,
    ...over,
  } as WorkflowDefinition
}

describe('useWorkflowDraftState', () => {
  it('initialises with empty draft + originalDraft when selected is null', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: null }))
    expect(captured!.draft.name).toBe('')
    expect(captured!.originalDraft.name).toBe('')
    expect(captured!.draftDirty).toBe(false)
    expect(captured!.draftDirtyFields).toEqual([])
  })

  it('seeds draft + originalDraft from selected workflow on mount', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    expect(captured!.draft.name).toBe('Sample')
    expect(captured!.draft.to).toBe('team@example.com')
    expect(captured!.originalDraft.name).toBe('Sample')
    expect(captured!.draftDirty).toBe(false)
  })

  it('re-syncs draft when selected swaps to a different workflow', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    const first = makeWorkflow({ id: 'wf_a', name: 'Alpha' })
    const second = makeWorkflow({ id: 'wf_b', name: 'Beta' })
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: first }))
    expect(captured!.draft.name).toBe('Alpha')
    await act(async () => {
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: second }))
      await Promise.resolve()
    })
    expect(captured!.draft.name).toBe('Beta')
    expect(captured!.originalDraft.name).toBe('Beta')
    expect(captured!.draftDirty).toBe(false)
  })

  it('setDraft marks the pair dirty without touching originalDraft', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    await act(async () => {
      captured!.setDraft((current) => ({ ...current, subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } }))
    })
    expect(captured!.draft.subject).toEqual({ parts: [{ kind: 'text', text: 'Updated' }] })
    expect(captured!.originalDraft.subject).toEqual({ parts: [{ kind: 'text', text: 'New lead' }] })
    expect(captured!.draftDirty).toBe(true)
    expect(captured!.draftDirtyFields).toContain('Subject')
  })

  it('setOriginalDraft to the post-save snapshot marks the pair clean', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    await act(async () => {
      captured!.setDraft((current) => ({ ...current, subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } }))
    })
    expect(captured!.draftDirty).toBe(true)
    // Simulate the page's saveDraft path: server confirmed the new
    // shape, both draft and originalDraft get re-seeded from it.
    const updated = makeWorkflow({ action: { ...makeWorkflow().action, subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } } as any })
    await act(async () => {
      captured!.setDraft({ ...captured!.draft, subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } })
      captured!.setOriginalDraft({ ...captured!.originalDraft, subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } })
      void updated
    })
    expect(captured!.draftDirty).toBe(false)
    expect(captured!.draftDirtyFields).toEqual([])
  })

  it('validation flags missing recipient on send_email drafts', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    await act(async () => {
      captured!.setDraft((current) => ({ ...current, to: '' }))
    })
    expect(captured!.validation.to).toMatch(/required/i)
  })

  it('switching to null clears the draft pair', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    expect(captured!.draft.name).toBe('Sample')
    await act(async () => {
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: null }))
      await Promise.resolve()
    })
    expect(captured!.draft.name).toBe('')
    expect(captured!.originalDraft.name).toBe('')
  })

  it('draftDirtyFields lists every changed slot in declaration order', async () => {
    let captured: ReturnType<typeof useWorkflowDraftState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    await act(async () => {
      captured!.setDraft((current) => ({ ...current, name: 'Renamed', to: 'new@x.com', subject: { parts: [{ kind: 'text' as const, text: 'Updated' }] } }))
    })
    expect(captured!.draftDirtyFields).toEqual(['Name', 'To', 'Subject'])
  })
})
