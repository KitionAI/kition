import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/dataDocuments'

import { useTableHistory } from './useTableHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

type HistoryArgs = Parameters<typeof useTableHistory>[0]
type HistoryActions = ReturnType<typeof useTableHistory>

let container: HTMLDivElement | null = null
let root: Root | null = null
let latest: HistoryActions | null = null

async function mountHistory(args: HistoryArgs) {
  function Harness(props: HistoryArgs) {
    latest = useTableHistory(props)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(Harness, args))
    await Promise.resolve()
  })
}

async function rerenderHistory(args: HistoryArgs) {
  function Harness(props: HistoryArgs) {
    latest = useTableHistory(props)
    return null
  }
  await act(async () => {
    root!.render(createElement(Harness, args))
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  latest = null
})

function makeEmptyChange(): api.TableChange {
  return {
    documentId: '1',
    origin: 'person:session:abc',
    tables: [],
    schema: [],
    views: [],
    recordsUpserted: [],
    recordsDeleted: [],
    recordsReordered: [],
    dashboards: false,
  }
}

describe('useTableHistory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the enabled state for the document on mount', async () => {
    vi.spyOn(api, 'getDataDocumentHistoryState').mockResolvedValue({ canUndo: true, canRedo: false })

    await mountHistory({ documentId: 1 })

    expect(api.getDataDocumentHistoryState).toHaveBeenCalledWith(1)
    expect(latest?.canUndo).toBe(true)
    expect(latest?.canRedo).toBe(false)
  })

  it('undo calls the server, applies the change, and refreshes the enabled state', async () => {
    vi.spyOn(api, 'getDataDocumentHistoryState')
      .mockResolvedValueOnce({ canUndo: true, canRedo: false })
      .mockResolvedValueOnce({ canUndo: false, canRedo: true })
    const change = { ...makeEmptyChange(), recordsUpserted: [[11, 'r1']] as Array<[number, string]> }
    const undoSpy = vi.spyOn(api, 'undoDataDocument').mockResolvedValue({ done: true, change })
    const onApplyChange = vi.fn().mockResolvedValue(undefined)

    await mountHistory({ documentId: 1, onApplyChange })

    await act(async () => {
      await latest!.undo()
    })

    expect(undoSpy).toHaveBeenCalledWith(1)
    expect(onApplyChange).toHaveBeenCalledWith(change)
    expect(latest?.canUndo).toBe(false)
    expect(latest?.canRedo).toBe(true)
    expect(latest?.historyBusy).toBe(false)
  })

  it('redo calls the server and skips applying the change when done is false', async () => {
    vi.spyOn(api, 'getDataDocumentHistoryState').mockResolvedValue({ canUndo: false, canRedo: false })
    const redoSpy = vi.spyOn(api, 'redoDataDocument').mockResolvedValue({ done: false, change: makeEmptyChange() })
    const onApplyChange = vi.fn()

    await mountHistory({ documentId: 1, onApplyChange })

    let result: boolean | undefined
    await act(async () => {
      result = await latest!.redo()
    })

    expect(redoSpy).toHaveBeenCalledWith(1)
    expect(onApplyChange).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('does nothing when there is no document id', async () => {
    const undoSpy = vi.spyOn(api, 'undoDataDocument')
    vi.spyOn(api, 'getDataDocumentHistoryState')

    await mountHistory({ documentId: null })

    let result: boolean | undefined
    await act(async () => {
      result = await latest!.undo()
    })

    expect(result).toBe(false)
    expect(undoSpy).not.toHaveBeenCalled()
  })

  it('resets the enabled state when the document id changes to null', async () => {
    vi.spyOn(api, 'getDataDocumentHistoryState').mockResolvedValue({ canUndo: true, canRedo: true })
    await mountHistory({ documentId: 1 })
    expect(latest?.canUndo).toBe(true)

    await rerenderHistory({ documentId: null })
    expect(latest?.canUndo).toBe(false)
    expect(latest?.canRedo).toBe(false)
  })
})
