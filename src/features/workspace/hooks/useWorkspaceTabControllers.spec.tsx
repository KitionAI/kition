import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import { flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import { useWorkspaceTabControllers } from './useWorkspaceTabControllers'

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/services/workspaceEditSessions', () => ({
  flushWorkspaceEditSessions: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const BOARD: WorkspaceTab = { id: 'board:Plan.kiboard', type: 'board', title: 'Plan', path: 'Plan.kiboard' }

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTabControllers> | null = null
const closeWorkspaceTab = vi.fn()

function Surface({ tabs }: { tabs: WorkspaceTab[] }) {
  api = useWorkspaceTabControllers({
    workspaceTabs: tabs,
    activeWorkspaceTab: tabs[0],
    activeWorkspaceTabId: tabs[0]?.id ?? '',
    closeWorkspaceTab,
    upsertWorkspaceTab: () => {},
    setActiveResourcePath: () => {},
    workflowOpen: false,
    openDesign: () => {},
    openKitableContainer: () => {},
    openBoard: () => {},
    openDocument: async () => {},
  })
  return null
}

async function closeTab(tabId: string) {
  await act(async () => {
    api!.handleCloseWorkspaceTabById(tabId)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Surface, { tabs: [BOARD] }))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceTabControllers', () => {
  it('closes a Board tab only after its pending save is written', async () => {
    let finish!: () => void
    vi.mocked(flushWorkspaceEditSessions).mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    await closeTab(BOARD.id)
    expect(flushWorkspaceEditSessions).toHaveBeenCalledWith(BOARD.path)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()

    await act(async () => {
      finish()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(closeWorkspaceTab).toHaveBeenCalledWith(BOARD.id)
  })

  it('keeps a Board tab open and shows the save failure when its save fails', async () => {
    vi.mocked(flushWorkspaceEditSessions).mockRejectedValue(new Error('disk full'))
    await closeTab(BOARD.id)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
    expect(notify.error).toHaveBeenCalledTimes(1)
  })
})
