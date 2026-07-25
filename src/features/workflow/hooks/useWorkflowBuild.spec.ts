import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowBuild } from './useWorkflowBuild'
import type { WorkflowBuildEvent } from '../types'

vi.mock('@/services/desktop', () => ({ resolveApiURL: (path: string) => `http://test${path}` }))
const portalAccountMock = vi.hoisted(() => ({
  ensurePortalAccountSessionRestored: vi.fn(),
}))
vi.mock('@/services/portalAccount', () => ({
  ensurePortalAccountSessionRestored: portalAccountMock.ensurePortalAccountSessionRestored,
}))

let container: HTMLDivElement
let root: Root | null = null

function mockFetchSSE(frames: string[]) {
  const encoded = frames.map((f) => `data: ${f}\n\n`).join('')
  const encoder = new TextEncoder()
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(encoded)); c.close() },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    ),
  ) as unknown as typeof fetch
}

async function renderHook<T>(setup: () => T): Promise<{ current: T }> {
  const ref: { current: T } = { current: undefined as unknown as T }
  function Wrapper() {
    const value = setup()
    useEffect(() => { ref.current = value })
    ref.current = value
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Wrapper))
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
  portalAccountMock.ensurePortalAccountSessionRestored.mockReset()
})

const STUB_MODEL = {
  provider_type: 'openai' as const,
  provider_label: 'stub',
  model_name: 'stub-1',
  base_url: '',
  api_key: '',
}

describe('useWorkflowBuild', () => {
  it('starts idle', async () => {
    const ref = await renderHook(() => useWorkflowBuild())
    expect(ref.current.status).toBe('idle')
    expect(ref.current.events).toEqual([])
  })

  it('streams events and transitions status', async () => {
    mockFetchSSE([
      JSON.stringify({ kind: 'workflow.generated', workflowId: 'auto_1', name: 'N', description: 'D' }),
      JSON.stringify({ kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl', config: {} }),
      JSON.stringify({ kind: 'action.generated', nodeId: 'n2', actionType: 'send_email', config: {} }),
      JSON.stringify({ kind: 'workflow.created', workflowId: 'auto_1' }),
      JSON.stringify({ kind: 'done' }),
    ])
    const ref = await renderHook(() => useWorkflowBuild())
    await act(async () => { await ref.current.submit({ prompt: 'p', baseId: 'b', documentId: 'd', tableId: 'tbl', model: STUB_MODEL }) })
    expect(ref.current.status).toBe('done')
    expect(ref.current.workflowId).toBe('auto_1')
    const kinds: string[] = ref.current.events.map((e: WorkflowBuildEvent) => e.kind)
    expect(kinds).toEqual(['workflow.generated', 'trigger.generated', 'action.generated', 'workflow.created', 'done'])
  })

  it('reports error on server error event', async () => {
    mockFetchSSE([
      JSON.stringify({ kind: 'error', code: 'model_failed', message: 'bad json' }),
      JSON.stringify({ kind: 'done' }),
    ])
    const ref = await renderHook(() => useWorkflowBuild())
    await act(async () => { await ref.current.submit({ prompt: 'p', baseId: 'b', documentId: 'd', tableId: 'tbl', model: STUB_MODEL }) })
    expect(ref.current.status).toBe('error')
    expect(ref.current.error).toContain('bad json')
  })

  it('includes documentId + model in POST body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('data: {"kind":"done"}\n\n')); c.close() },
        }), { headers: { 'content-type': 'text/event-stream' } }),
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const ref = await renderHook(() => useWorkflowBuild())
    await act(async () => {
      await ref.current.submit({
        prompt: 'p',
        baseId: 'b',
        documentId: 'doc_42',
        tableId: 'tbl',
        model: {
          provider_type: 'openai',
          provider_label: 'OpenAI',
          model_name: 'gpt-4o',
          base_url: '',
          api_key: 'sk-x',
        },
      })
    })
    expect(fetchMock).toHaveBeenCalled()
    const call = (fetchMock.mock.calls as unknown as [string, RequestInit][]).at(-1)!
    const init = call[1]
    const body = JSON.parse(init.body as string)
    expect(body.documentId).toBe('doc_42')
    expect(body.model).toEqual({
      provider_type: 'openai',
      provider_label: 'OpenAI',
      model_name: 'gpt-4o',
      base_url: '',
      api_key: 'sk-x',
    })
  })

  it('restores the portal session before building with Kition Console', async () => {
    portalAccountMock.ensurePortalAccountSessionRestored.mockResolvedValue({ user_email: 'lee@example.com' })
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('data: {"kind":"done"}\n\n')); c.close() },
        }), { headers: { 'content-type': 'text/event-stream' } }),
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const ref = await renderHook(() => useWorkflowBuild())
    await act(async () => {
      await ref.current.submit({
        prompt: 'p',
        baseId: 'b',
        documentId: 'doc_42',
        tableId: 'tbl',
        model: {
          provider_type: 'kition_console',
          provider_label: 'KitionAI Console',
          model_name: 'gpt-5.5',
          base_url: '',
          api_key: '',
        },
      })
    })
    expect(portalAccountMock.ensurePortalAccountSessionRestored).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not build with Kition Console when portal restore fails', async () => {
    portalAccountMock.ensurePortalAccountSessionRestored.mockRejectedValue(new Error('Sign in required'))
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const ref = await renderHook(() => useWorkflowBuild())
    await act(async () => {
      await ref.current.submit({
        prompt: 'p',
        baseId: 'b',
        documentId: 'doc_42',
        tableId: 'tbl',
        model: {
          provider_type: 'kition_console',
          provider_label: 'KitionAI Console',
          model_name: 'gpt-5.5',
          base_url: '',
          api_key: '',
        },
      })
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ref.current.status).toBe('error')
    expect(ref.current.error).toBe('Sign in required')
  })
})
