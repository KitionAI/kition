import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowEnabled, type UseWorkflowEnabledResult } from './useWorkflowEnabled'

vi.mock('@/services/desktop', () => ({ resolveApiURL: (p: string) => `http://test${p}` }))

let container: HTMLDivElement
let root: Root | null = null

async function renderHook() {
  const ref: { current: UseWorkflowEnabledResult | null } = { current: null }
  function Harness() {
    ref.current = useWorkflowEnabled('auto_1')
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
    await Promise.resolve()
  })
  return ref
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('useWorkflowEnabled', () => {
  it('patches enabled state', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    const ref = await renderHook()
    await act(async () => {
      await ref.current?.setEnabled(true)
    })
    expect(ref.current?.enabled).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith('http://test/v1/workflows/auto_1/enabled', expect.objectContaining({ method: 'PATCH' }))
  })

  it('reverts on failure', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    const ref = await renderHook()
    await act(async () => {
      await ref.current?.setEnabled(true)
    })
    expect(ref.current?.enabled).toBe(false)
    expect(ref.current?.status).toBe('error')
    expect(ref.current?.error).toBe('nope')
  })
})
