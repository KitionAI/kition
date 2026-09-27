import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/desktop', () => ({
  getDesktopBackendStatus: vi.fn(),
}))
vi.mock('@/features/whiteboard/public', () => ({
  runtimeSupportsWhiteboard: (capabilities?: string[]) => Boolean(capabilities?.includes('whiteboard')),
}))

import { getDesktopBackendStatus } from '@/services/desktop'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/public'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

import { useWorkspaceWhiteboardAgentBridge } from './useWorkspaceWhiteboardAgentBridge'

type Result = ReturnType<typeof useWorkspaceWhiteboardAgentBridge>

function Harness({ onResult }: { onResult: (result: Result) => void }) {
  const result = useWorkspaceWhiteboardAgentBridge({ rootPath: '/ws' })
  useEffect(() => onResult(result), [result, onResult])
  return null
}

function fakeBridge() {
  const cancelPreview = vi.fn<WhiteboardAgentBridge['cancelPreview']>()
  const receivePatch = vi.fn<WhiteboardAgentBridge['receivePatch']>()
  const bridge: WhiteboardAgentBridge = {
    available: true,
    buildContext: () => ({ board: 'ctx' } as never),
    cancelPreview,
    receivePatch,
  }
  return Object.assign(bridge, { cancelPreview, receivePatch })
}

const patch = { operations: [] } as unknown as AgentWhiteboardPatch

let container: HTMLDivElement
let root: Root | null = null

async function mount(capabilities: string[]) {
  vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities } as never)
  let latest: Result | null = null
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness, { onResult: (result) => { latest = result } }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return () => latest!
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  container.remove()
  vi.mocked(getDesktopBackendStatus).mockReset()
})

describe('useWorkspaceWhiteboardAgentBridge', () => {
  it('reports availability from the runtime capabilities', async () => {
    const read = await mount(['whiteboard'])
    expect(read().available).toBe(true)
  })

  it('routes patches to the named board, falling back to the active board, and drops them when unavailable', async () => {
    const read = await mount(['whiteboard'])
    const boardA = fakeBridge()
    const boardB = fakeBridge()
    act(() => {
      read().handleBridgeChange('a.kiboard', boardA)
      read().handleBridgeChange('b.kiboard', boardB)
      read().setActiveBoardPath('b.kiboard')
    })

    read().receivePatch({ boardPath: 'a.kiboard', patch, provisional: true })
    expect(boardA.receivePatch).toHaveBeenCalledWith(patch, true)

    read().receivePatch({ boardPath: 'missing.kiboard', patch, provisional: false })
    expect(boardB.receivePatch).toHaveBeenCalledWith(patch, false)

    expect(read().buildActiveContext()).toEqual({ board: 'ctx' })
    read().cancelPreview({ boardPath: 'a.kiboard' })
    expect(boardA.cancelPreview).toHaveBeenCalledTimes(1)

    act(() => { read().handleBridgeChange('a.kiboard', null) })
    read().receivePatch({ boardPath: 'a.kiboard', patch, provisional: false })
    expect(boardB.receivePatch).toHaveBeenCalledTimes(2)
  })

  it('ignores patches when the runtime lacks whiteboard support', async () => {
    const read = await mount([])
    const board = fakeBridge()
    act(() => { read().handleBridgeChange('a.kiboard', board) })
    read().receivePatch({ boardPath: 'a.kiboard', patch, provisional: false })
    expect(board.receivePatch).not.toHaveBeenCalled()
  })
})
