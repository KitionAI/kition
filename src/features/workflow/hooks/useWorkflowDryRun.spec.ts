import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowDryRun } from './useWorkflowDryRun'

const trackProductEventOnce = vi.hoisted(() => vi.fn())

vi.mock('@/services/desktop', () => ({ resolveApiURL: (p: string) => `http://test${p}` }))
vi.mock('@/features/analytics/lib/productAnalytics', () => ({ trackProductEventOnce }))

let container: HTMLDivElement; let root: Root | null = null

async function renderHook<T>(setup: () => T): Promise<{ current: T }> {
  const ref: { current: T } = { current: undefined as unknown as T }
  function Wrapper() { const v = setup(); useEffect(() => { ref.current = v }); ref.current = v; return null }
  await act(async () => { root = createRoot(container); root.render(createElement(Wrapper)); await Promise.resolve() })
  return ref
}

beforeEach(() => { trackProductEventOnce.mockReset(); container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove(); vi.restoreAllMocks() })

describe('useWorkflowDryRun', () => {
  it('starts idle', async () => {
    const ref = await renderHook(() => useWorkflowDryRun())
    expect(ref.current.status).toBe('idle')
    expect(ref.current.result).toBeNull()
  })

  it('returns successful input on ok response', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, input: { to: 'a@b', subject: { parts: [{ kind: 'text' as const, text: 'S' }] }, body: 'rendered body' } }), { headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    const ref = await renderHook(() => useWorkflowDryRun())
    await act(async () => { await ref.current.run('auto_1') })
    expect(ref.current.status).toBe('done')
    expect(ref.current.result?.input.body).toBe('rendered body')
    expect(trackProductEventOnce).toHaveBeenCalledWith('workflow_first_run_completed', { result: 'success' })
  })

  it('captures error on failure', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'bad' }), { status: 502, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    const ref = await renderHook(() => useWorkflowDryRun())
    await act(async () => { await ref.current.run('auto_1') })
    expect(ref.current.status).toBe('error')
    expect(ref.current.error).toContain('bad')
    expect(trackProductEventOnce).not.toHaveBeenCalled()
  })
})
