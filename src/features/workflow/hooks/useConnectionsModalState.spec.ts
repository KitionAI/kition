import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useConnectionsModalState } from './useConnectionsModalState'

function HookSurface({ onResult }: { onResult: (r: ReturnType<typeof useConnectionsModalState>) => void }) {
  const result = useConnectionsModalState()
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

describe('useConnectionsModalState', () => {
  it('starts closed with no editing id', async () => {
    let captured: ReturnType<typeof useConnectionsModalState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    expect(captured!.isOpen).toBe(false)
    expect(captured!.editingId).toBeNull()
  })

  it('openCreate opens with editingId=null so the modal renders the create form', async () => {
    let captured: ReturnType<typeof useConnectionsModalState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    await act(async () => { captured!.openCreate() })
    expect(captured!.isOpen).toBe(true)
    expect(captured!.editingId).toBeNull()
  })

  it('openEdit opens with the supplied id so the modal pre-populates from the existing connection', async () => {
    let captured: ReturnType<typeof useConnectionsModalState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    await act(async () => { captured!.openEdit('conn_a') })
    expect(captured!.isOpen).toBe(true)
    expect(captured!.editingId).toBe('conn_a')
  })

  it('openEdit(null) is treated as "open in create-mode" — the failing-connection slot relies on this', async () => {
    let captured: ReturnType<typeof useConnectionsModalState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    await act(async () => { captured!.openEdit(null) })
    expect(captured!.isOpen).toBe(true)
    expect(captured!.editingId).toBeNull()
  })

  it('close clears both the open flag and the editing id', async () => {
    let captured: ReturnType<typeof useConnectionsModalState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    await act(async () => { captured!.openEdit('conn_a') })
    expect(captured!.isOpen).toBe(true)
    await act(async () => { captured!.close() })
    expect(captured!.isOpen).toBe(false)
    expect(captured!.editingId).toBeNull()
  })
})
