import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BoardCommandRegistry } from '../lib/boardCommands'
import { createBoardRecordsFromElements } from '../lib/boardRecords'
import { BoardStore } from '../lib/boardStore'
import { useWhiteboardAgentPatch } from './useWhiteboardAgentPatch'

type HookResult = ReturnType<typeof useWhiteboardAgentPatch>

let container: HTMLDivElement
let root: Root | null = null
let latest: HookResult | null = null

function HookSurface({ commands, store }: { commands: BoardCommandRegistry; store: BoardStore }) {
  const result = useWhiteboardAgentPatch({ commands, store })
  useEffect(() => {
    latest = result
  }, [result])
  return null
}

function createElementOperation(id: string, x: number) {
  return {
    op: 'element.create',
    element: { id, kind: 'sticky', text: id, bounds: { x, y: 0, width: 120, height: 90 } },
  }
}

function patch(summary: string, operations: unknown[]) {
  return { type: 'whiteboard.patch', schema_version: 1, summary, operations }
}

async function mount() {
  const store = new BoardStore(createBoardRecordsFromElements([
    { id: 'existing', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'Existing' },
  ]))
  const commands = new BoardCommandRegistry(store)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(HookSurface, { commands, store }))
    await Promise.resolve()
  })
  return { commands, store }
}

function addedElementIds() {
  return latest!.state.diff!.added
    .filter((record) => record.record_type === 'element')
    .map((record) => record.id)
}

describe('useWhiteboardAgentPatch', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    latest = null
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
  })

  it('keeps preview ids stable when two streamed chunks arrive before a render', async () => {
    await mount()
    const { receivePatch } = latest!
    await act(async () => {
      receivePatch(patch('Stream', [createElementOperation('n1', 200)]), true)
      receivePatch(patch('Stream', [createElementOperation('n2', 400)]), true)
    })
    const streamed = latest!.state
    expect(streamed.status).toBe('streaming')
    expect([...streamed.createdIds.keys()]).toEqual(['n1', 'n2'])
    const ids = [streamed.createdIds.get('n1'), streamed.createdIds.get('n2')]

    await act(async () => {
      latest!.receivePatch(patch('Stream', [
        createElementOperation('n1', 200),
        createElementOperation('n2', 400),
      ]), false)
    })
    expect(latest!.state.status).toBe('ready')
    expect(latest!.state.createdIds).toBe(streamed.createdIds)
    expect(addedElementIds().sort()).toEqual([...ids].sort())
  })

  it('resolves names from accepted patches in later turns', async () => {
    const { store } = await mount()
    await act(async () => {
      latest!.receivePatch(patch('Add a note', [createElementOperation('n2', 200)]), false)
    })
    const noteId = latest!.state.createdIds.get('n2')!
    await act(async () => {
      expect(latest!.accept()).toBe(true)
    })
    expect(store.getElementRecord(noteId)).toBeTruthy()
    expect([...latest!.getRenamedIds()]).toEqual([['n2', noteId]])

    await act(async () => {
      latest!.receivePatch(patch('Edit the note', [
        { op: 'element.update', element_id: 'n2', changes: { text: 'Edited' } },
      ]), false)
    })
    expect(latest!.state.status).toBe('ready')
    expect(latest!.state.diff!.updated).toEqual([expect.objectContaining({
      after: expect.objectContaining({ id: noteId, text: 'Edited' }),
    })])

    await act(async () => {
      latest!.receivePatch(patch('Create n2 again', [createElementOperation('n2', 600)]), false)
    })
    expect(latest!.state.status).toBe('error')
    expect(latest!.state.error).toBe('AI Board patch reuses an existing id: n2')
  })
})
