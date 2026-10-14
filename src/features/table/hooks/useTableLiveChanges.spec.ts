import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (params: Record<string, unknown>) => void

const shared = vi.hoisted(() => ({
  listeners: new Set<Listener>(),
  subscribeCalls: 0,
  unsubscribeCalls: 0,
  resyncListeners: new Set<() => void>(),
  resyncSubscribeCalls: 0,
  resyncUnsubscribeCalls: 0,
}))

vi.mock('@/services/runtimeBridge', () => ({
  onTableChanged: (listener: Listener) => {
    shared.listeners.add(listener)
    shared.subscribeCalls += 1
    return () => {
      shared.listeners.delete(listener)
      shared.unsubscribeCalls += 1
    }
  },
  onTableChangedResync: (listener: () => void) => {
    shared.resyncListeners.add(listener)
    shared.resyncSubscribeCalls += 1
    return () => {
      shared.resyncListeners.delete(listener)
      shared.resyncUnsubscribeCalls += 1
    }
  },
}))

vi.mock('@/api/windowSession', () => ({
  windowSessionOrigin: () => 'person:session:this-window',
}))

import { useTableLiveChanges, type TableLiveChangeHandlers } from './useTableLiveChanges'

function emit(overrides: Record<string, unknown> = {}) {
  const event = {
    documentId: '1',
    origin: 'person:session:other-window',
    tables: [],
    schema: [],
    views: [],
    recordsUpserted: [],
    recordsDeleted: [],
    recordsReordered: [],
    dashboards: false,
    documentPath: 'a.kitable',
    ...overrides,
  }
  for (const listener of [...shared.listeners]) listener(event)
}

function emitResync() {
  for (const listener of [...shared.resyncListeners]) listener()
}

let container: HTMLDivElement
let root: Root | null = null

function Harness({ documentId, handlers }: { documentId: number | string | null; handlers: TableLiveChangeHandlers }) {
  useTableLiveChanges(documentId, handlers)
  return null
}

async function mount(documentId: number | string | null, handlers: TableLiveChangeHandlers) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness, { documentId, handlers }))
  })
}

async function update(documentId: number | string | null, handlers: TableLiveChangeHandlers) {
  await act(async () => {
    root?.render(createElement(Harness, { documentId, handlers }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  shared.listeners.clear()
  shared.subscribeCalls = 0
  shared.unsubscribeCalls = 0
  shared.resyncListeners.clear()
  shared.resyncSubscribeCalls = 0
  shared.resyncUnsubscribeCalls = 0
})

afterEach(() => {
  root?.unmount()
  container.remove()
  root = null
  vi.restoreAllMocks()
})

describe('useTableLiveChanges', () => {
  it('does not subscribe while documentId is null', async () => {
    await mount(null, {})
    expect(shared.subscribeCalls).toBe(0)
  })

  it('dispatches records, schema, views, reorder, and dashboards to their own handlers', async () => {
    const onRecords = vi.fn()
    const onSchema = vi.fn()
    const onViews = vi.fn()
    const onReorder = vi.fn()
    const onDashboards = vi.fn()
    await mount(1, { onRecords, onSchema, onViews, onReorder, onDashboards })

    emit({ recordsUpserted: [[11, 'r1']], recordsDeleted: [[11, 'r2']] })
    expect(onRecords).toHaveBeenCalledWith([[11, 'r1']], [[11, 'r2']])

    emit({ tables: [11], schema: [11, 12] })
    expect(onSchema).toHaveBeenCalledWith([11, 12])

    emit({ views: [201] })
    expect(onViews).toHaveBeenCalledWith([201])

    emit({ recordsReordered: [11] })
    expect(onReorder).toHaveBeenCalledWith([11])

    emit({ dashboards: true })
    expect(onDashboards).toHaveBeenCalledTimes(1)

    expect(onRecords).toHaveBeenCalledTimes(1)
    expect(onSchema).toHaveBeenCalledTimes(1)
    expect(onViews).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledTimes(1)
  })

  it('does not call a handler when its part of the change is empty', async () => {
    const onRecords = vi.fn()
    const onSchema = vi.fn()
    const onDashboards = vi.fn()
    await mount(1, { onRecords, onSchema, onDashboards })

    emit({})
    expect(onRecords).not.toHaveBeenCalled()
    expect(onSchema).not.toHaveBeenCalled()
    expect(onDashboards).not.toHaveBeenCalled()
  })

  it('filters events to the given document id, comparing as a string', async () => {
    const onRecords = vi.fn()
    await mount(1, { onRecords })

    emit({ documentId: '2', recordsUpserted: [[1, 'x']] })
    expect(onRecords).not.toHaveBeenCalled()

    emit({ documentId: '1', recordsUpserted: [[1, 'x']] })
    expect(onRecords).toHaveBeenCalledTimes(1)
  })

  it("ignores events whose origin is this window's own session", async () => {
    const onRecords = vi.fn()
    await mount(1, { onRecords })

    emit({ origin: 'person:session:this-window', recordsUpserted: [[1, 'x']] })
    expect(onRecords).not.toHaveBeenCalled()

    emit({ origin: 'agent:turn-1', recordsUpserted: [[1, 'x']] })
    expect(onRecords).toHaveBeenCalledTimes(1)
  })

  it('survives a handler change without resubscribing', async () => {
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    await mount(1, { onRecords: firstHandler })
    await update(1, { onRecords: secondHandler })

    expect(shared.subscribeCalls).toBe(1)
    expect(shared.unsubscribeCalls).toBe(0)

    emit({ recordsUpserted: [[1, 'x']] })
    expect(firstHandler).not.toHaveBeenCalled()
    expect(secondHandler).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes when documentId becomes null and resubscribes for a new document', async () => {
    await mount(1, {})
    expect(shared.subscribeCalls).toBe(1)
    expect(shared.resyncSubscribeCalls).toBe(1)

    await update(null, {})
    expect(shared.unsubscribeCalls).toBe(1)
    expect(shared.resyncUnsubscribeCalls).toBe(1)

    await update(2, {})
    expect(shared.subscribeCalls).toBe(2)
    expect(shared.resyncSubscribeCalls).toBe(2)
  })

  it('calls onResync after the bridge stream resyncs', async () => {
    const onResync = vi.fn()
    await mount(1, { onResync })

    emitResync()
    expect(onResync).toHaveBeenCalledTimes(1)
  })

  it('does not call onResync once documentId becomes null', async () => {
    const onResync = vi.fn()
    await mount(1, { onResync })
    await update(null, { onResync })

    emitResync()
    expect(onResync).not.toHaveBeenCalled()
  })

  it('calls the latest onResync handler without resubscribing', async () => {
    const firstResync = vi.fn()
    const secondResync = vi.fn()
    await mount(1, { onResync: firstResync })
    await update(1, { onResync: secondResync })

    expect(shared.resyncSubscribeCalls).toBe(1)

    emitResync()
    expect(firstResync).not.toHaveBeenCalled()
    expect(secondResync).toHaveBeenCalledTimes(1)
  })
})
