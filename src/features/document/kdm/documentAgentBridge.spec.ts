import { describe, expect, it, vi } from 'vitest'
import type { BridgeChannel, BridgeTransport } from '@/services/runtimeBridge'
import { createDocumentAgentBridge, type OpenDocumentHandlers } from './documentAgentBridge'

const shared = vi.hoisted(() => ({ opened: 0, notes: [] as Array<{ method: string; params: unknown }> }))
vi.mock('@/services/runtimeBridge', () => ({
  runtimeBridge: {
    open: () => {
      shared.opened += 1
      return () => undefined
    },
    notify: (method: string, params: unknown) => shared.notes.push({ method, params }),
  },
}))

function fakeTransport() {
  const state = { channel: null as BridgeChannel | null, opens: 0, closes: 0, notes: [] as Array<{ method: string; params: Record<string, unknown> }> }
  const transport: BridgeTransport = {
    open(channel) {
      state.opens += 1
      state.channel = channel
      return () => {
        state.closes += 1
        state.channel = null
      }
    },
    notify: (method, params) => state.notes.push({ method, params }),
  }
  const request = async (method: string, params: Record<string, unknown>) => {
    if (!state.channel?.handles(method)) throw new Error(`no channel answers ${method}`)
    return state.channel.handle(method, params)
  }
  const announced = () => state.notes.filter((note) => note.method === 'documents.open').map((note) => note.params.paths)
  return { transport, state, request, announced }
}

function handlers(text: string, apply: OpenDocumentHandlers['apply'] = async (content) => ({ applied: true, content })): OpenDocumentHandlers {
  return { read: () => text, apply }
}

describe('documentAgentBridge', () => {
  it('announces open documents and keeps the channel open while any is registered', () => {
    const { transport, state, announced } = fakeTransport()
    const bridge = createDocumentAgentBridge(transport)
    const closeA = bridge.registerOpenDocument('./Notes/a.md', handlers('a'))
    const closeB = bridge.registerOpenDocument('/b.md', handlers('b'))
    expect(state.opens).toBe(1)
    closeA()
    closeA()
    expect(state.closes).toBe(0)
    // A reconnected stream hears the list again.
    state.channel?.ready?.()
    closeB()
    expect(state.closes).toBe(1)
    expect(announced()).toEqual([['Notes/a.md'], ['Notes/a.md', 'b.md'], ['b.md'], ['b.md'], []])
  })

  it('routes reads and edits to the session that has the document open', async () => {
    const { transport, request } = fakeTransport()
    const bridge = createDocumentAgentBridge(transport)
    const apply = vi.fn(async (content: string) => ({ applied: true, content: `${content}\n` }))
    bridge.registerOpenDocument('Notes/a.md', handlers('live text', apply))
    expect(await request('document/read', { path: 'Notes/a.md' })).toEqual({ open: true, content: 'live text' })
    expect(await request('document/read', { path: 'Other.md' })).toEqual({ open: false })
    expect(await request('document/apply', { path: '/Notes/a.md', content: 'new', tool: 'apply_patch', turnId: 't1' })).toEqual({ applied: true, content: 'new\n' })
    expect(apply).toHaveBeenCalledWith('new', { tool: 'apply_patch', turnId: 't1' })
    expect(await request('document/apply', { path: 'Other.md', content: 'new', tool: 'document_write' })).toEqual({ applied: false, reason: 'not-open' })
    expect(await request('document/apply', { path: 'Notes/a.md', tool: 'document_write' })).toEqual({ applied: false, reason: 'the edit has no content' })
    await expect(request('document/unknown', {})).rejects.toThrow('unknown bridge method document/unknown')
    await expect(request('kit/documents', {})).rejects.toThrow('no channel answers kit/documents')
  })

  it('reports a refused or failed edit as not applied', async () => {
    const { transport, request } = fakeTransport()
    const bridge = createDocumentAgentBridge(transport)
    bridge.registerOpenDocument('refuses.md', handlers('', async () => ({ applied: false, reason: 'conflict' })))
    bridge.registerOpenDocument('silent.md', handlers('', async () => ({ applied: false })))
    bridge.registerOpenDocument(
      'fails.md',
      handlers('', async () => {
        throw new Error('save failed')
      }),
    )
    bridge.registerOpenDocument('unsaved.md', handlers('the live text', async () => ({ applied: true })))
    expect(await request('document/apply', { path: 'refuses.md', content: 'x', tool: 't' })).toEqual({ applied: false, reason: 'conflict' })
    expect(await request('document/apply', { path: 'silent.md', content: 'x', tool: 't' })).toEqual({ applied: false, reason: 'refused' })
    expect(await request('document/apply', { path: 'fails.md', content: 'x', tool: 't' })).toEqual({ applied: false, reason: 'save failed' })
    expect(await request('document/apply', { path: 'unsaved.md', content: 'x', tool: 't' })).toEqual({ applied: true, content: 'the live text' })
  })

  it('keeps the newer session when an older one for the same path withdraws', async () => {
    const { transport, request, state } = fakeTransport()
    const bridge = createDocumentAgentBridge(transport)
    const closeOld = bridge.registerOpenDocument('a.md', handlers('old'))
    bridge.registerOpenDocument('a.md', handlers('new'))
    closeOld()
    expect(state.closes).toBe(0)
    expect(await request('document/read', { path: 'a.md' })).toEqual({ open: true, content: 'new' })
  })

  it('answers only for the documents open in its own window', async () => {
    // Two windows, each with its own stream; the runtime sends an edit to the window that announced the path.
    const first = fakeTransport()
    const second = fakeTransport()
    const firstWindow = createDocumentAgentBridge(first.transport)
    const secondWindow = createDocumentAgentBridge(second.transport)
    const applied = vi.fn(async (content: string) => ({ applied: true, content }))
    firstWindow.registerOpenDocument('a.md', handlers('first window', applied))
    const closeSecond = secondWindow.registerOpenDocument('b.md', handlers('second window'))
    expect(first.announced()).toEqual([['a.md']])
    expect(second.announced()).toEqual([['b.md']])
    expect(await second.request('document/read', { path: 'a.md' })).toEqual({ open: false })
    expect(await second.request('document/apply', { path: 'a.md', content: 'x', tool: 'document_write' })).toEqual({ applied: false, reason: 'not-open' })
    expect(applied).not.toHaveBeenCalled()
    expect(await first.request('document/apply', { path: 'a.md', content: 'x', tool: 'document_write' })).toEqual({ applied: true, content: 'x' })
    // A window that closed its document no longer takes edits: the runtime writes the file instead.
    closeSecond()
    expect(second.state.channel).toBeNull()
    expect(second.announced().at(-1)).toEqual([])
  })

  it('uses the window bridge stream by default', async () => {
    const { registerOpenDocument } = await import('./documentAgentBridge')
    const close = registerOpenDocument('Notes/a.md', handlers('a'))
    expect(shared.opened).toBe(1)
    expect(shared.notes).toEqual([{ method: 'documents.open', params: { paths: ['Notes/a.md'] } }])
    close()
    expect(shared.notes.at(-1)).toEqual({ method: 'documents.open', params: { paths: [] } })
  })
})
