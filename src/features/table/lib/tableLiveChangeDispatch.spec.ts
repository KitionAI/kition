import { describe, expect, it, vi } from 'vitest'

import { buildTableLiveChangeHandlers } from './tableLiveChangeDispatch'

function makeCallbacks() {
  return {
    loadRecords: vi.fn(),
    refreshDocument: vi.fn(),
    refreshHistoryState: vi.fn(),
  }
}

describe('buildTableLiveChangeHandlers', () => {
  it('onRecords refetches records only when the change touches the active table', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onRecords?.([[11, 'r1']], [])
    expect(callbacks.loadRecords).toHaveBeenCalledTimes(1)
    expect(callbacks.refreshHistoryState).toHaveBeenCalledTimes(1)

    handlers.onRecords?.([[99, 'r2']], [])
    expect(callbacks.loadRecords).toHaveBeenCalledTimes(1)
    expect(callbacks.refreshHistoryState).toHaveBeenCalledTimes(2)
  })

  it('onRecords refetches when the active table only appears in the deleted refs', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onRecords?.([], [[11, 'r1']])
    expect(callbacks.loadRecords).toHaveBeenCalledTimes(1)
  })

  it('onSchema reloads the document only for the active table', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onSchema?.([99])
    expect(callbacks.refreshDocument).not.toHaveBeenCalled()

    handlers.onSchema?.([11, 99])
    expect(callbacks.refreshDocument).toHaveBeenCalledTimes(1)
  })

  it('onViews reloads the document only for the active view', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onViews?.([999])
    expect(callbacks.refreshDocument).not.toHaveBeenCalled()

    handlers.onViews?.([201])
    expect(callbacks.refreshDocument).toHaveBeenCalledTimes(1)
  })

  it('onReorder refetches records only for the active table', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onReorder?.([99])
    expect(callbacks.loadRecords).not.toHaveBeenCalled()

    handlers.onReorder?.([11])
    expect(callbacks.loadRecords).toHaveBeenCalledTimes(1)
  })

  it('onResync always does a full reload', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onResync?.()
    expect(callbacks.refreshDocument).toHaveBeenCalledTimes(1)
    expect(callbacks.loadRecords).toHaveBeenCalledTimes(1)
    expect(callbacks.refreshHistoryState).toHaveBeenCalledTimes(1)
  })

  it('onDashboards only refreshes the history state', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: 11, activeViewId: 201, ...callbacks })

    handlers.onDashboards?.()
    expect(callbacks.refreshHistoryState).toHaveBeenCalledTimes(1)
    expect(callbacks.loadRecords).not.toHaveBeenCalled()
    expect(callbacks.refreshDocument).not.toHaveBeenCalled()
  })

  it('does nothing when there is no active table', () => {
    const callbacks = makeCallbacks()
    const handlers = buildTableLiveChangeHandlers({ activeTableId: null, activeViewId: null, ...callbacks })

    handlers.onRecords?.([[11, 'r1']], [])
    handlers.onSchema?.([11])
    handlers.onReorder?.([11])
    expect(callbacks.loadRecords).not.toHaveBeenCalled()
    expect(callbacks.refreshDocument).not.toHaveBeenCalled()
  })
})
