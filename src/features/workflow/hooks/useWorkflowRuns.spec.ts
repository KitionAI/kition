import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowRuns, type UseWorkflowRunsResult } from './useWorkflowRuns'

vi.mock('@/services/desktop', () => ({ resolveApiURL: (p: string) => `http://test${p}` }))

let container: HTMLDivElement
let root: Root | null = null

async function renderHook(active = false) {
  const ref: { current: UseWorkflowRunsResult | null } = { current: null }
  function Harness() {
    ref.current = useWorkflowRuns('auto_1', active)
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

describe('useWorkflowRuns', () => {
  it('loads run records', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      runs: [{ id: 'run_1', workflowId: 'auto_1', triggerEvent: 'record.created', recordId: 'rec_1', startedAt: '', finishedAt: '', status: 'ok', to: 'sales@x.com', subject: { parts: [{ kind: 'text' as const, text: 'S' }] }, body: 'B' }],
    }), { headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    const ref = await renderHook()
    await act(async () => {
      await ref.current?.refresh()
    })
    expect(ref.current?.runs).toHaveLength(1)
    expect(ref.current?.runs[0].to).toBe('sales@x.com')
  })
})
