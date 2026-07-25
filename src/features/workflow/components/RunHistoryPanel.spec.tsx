import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunHistoryPanel } from './RunHistoryPanel'

vi.mock('@/services/desktop', () => ({ resolveApiURL: (p: string) => `http://test${p}` }))

let container: HTMLDivElement
let root: Root | null = null
async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve(); await Promise.resolve() })
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove(); vi.restoreAllMocks() })

describe('RunHistoryPanel', () => {
  it('renders run rows', async () => {
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      runs: [{ id: 'run_1', workflowId: 'auto_1', triggerEvent: 'record.created', recordId: 'rec_1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', status: 'ok', to: 'sales@x.com', subject: 'New Lead', body: 'Bieber' }],
    }), { headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
    await mount(createElement(RunHistoryPanel, { workflowId: 'auto_1', onClose: () => {} }))
    expect(container.querySelectorAll('[data-testid="run-history-row"]').length).toBe(1)
    expect(container.textContent).toContain('sales@x.com')
  })

  it('paginates: shows 20 rows initially and a Load more button when more runs exist', async () => {
    // Server returned 50 rows (the hook's default page size). The panel
    // must render only INITIAL_PAGE_SIZE (20) and a Load more affordance.
    const runs = Array.from({ length: 50 }, (_, i) => ({
      id: `run_${i}`,
      workflowId: 'auto_1',
      triggerEvent: 'record.created',
      recordId: `rec_${i}`,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      status: 'ok' as const,
      to: `r${i}@x.com`,
      subject: `Lead ${i}`,
      body: 'b',
    }))
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runs }), {
      headers: { 'content-type': 'application/json' },
    }))) as unknown as typeof fetch
    await mount(createElement(RunHistoryPanel, { workflowId: 'auto_1', onClose: () => {} }))
    expect(container.querySelectorAll('[data-testid="run-history-row"]').length).toBe(20)
    const loadMore = container.querySelector('[data-testid="run-history-load-more"]') as HTMLButtonElement
    expect(loadMore).not.toBeNull()
    expect(loadMore.textContent).toMatch(/Load 20 more \(30 hidden\)/)
  })

  it('Load more reveals the next page increment', async () => {
    const runs = Array.from({ length: 50 }, (_, i) => ({
      id: `run_${i}`,
      workflowId: 'auto_1',
      triggerEvent: 'record.created',
      recordId: `rec_${i}`,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      status: 'ok' as const,
      to: `r${i}@x.com`,
      subject: `Lead ${i}`,
      body: 'b',
    }))
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runs }), {
      headers: { 'content-type': 'application/json' },
    }))) as unknown as typeof fetch
    await mount(createElement(RunHistoryPanel, { workflowId: 'auto_1', onClose: () => {} }))
    const loadMore = container.querySelector('[data-testid="run-history-load-more"]') as HTMLButtonElement
    await act(async () => { loadMore.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelectorAll('[data-testid="run-history-row"]').length).toBe(40)
    // Still 10 hidden → button still rendered with new count.
    const loadMore2 = container.querySelector('[data-testid="run-history-load-more"]') as HTMLButtonElement
    expect(loadMore2.textContent).toMatch(/Load 10 more/)
  })

  it('does not render Load more when total runs fit within the initial page', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `run_${i}`,
      workflowId: 'auto_1',
      triggerEvent: 'record.created',
      recordId: `rec_${i}`,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      status: 'ok' as const,
      to: 'a@b',
      subject: 's',
      body: 'b',
    }))
    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runs }), {
      headers: { 'content-type': 'application/json' },
    }))) as unknown as typeof fetch
    await mount(createElement(RunHistoryPanel, { workflowId: 'auto_1', onClose: () => {} }))
    expect(container.querySelector('[data-testid="run-history-load-more"]')).toBeNull()
  })
})
