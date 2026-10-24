import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'
import { useWorkspaceTabControllers } from './useWorkspaceTabControllers'

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const DESIGN: WorkspaceTab = { id: 'design:Poster.kidesign', type: 'design', title: 'Poster', path: 'Poster.kidesign' }

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTabControllers> | null = null
const closeWorkspaceTab = vi.fn()
const unregisters: Array<() => void> = []

/** An open editor of `path`, as the edit-session registry sees it. */
function openEditor(path: string, flush: () => Promise<void>) {
  const session = { flush: vi.fn(flush) }
  unregisters.push(registerWorkspaceEditSession(session.flush, path))
  return session
}

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
    openDocument: async () => {},
  })
  return null
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function closeTab(tabId: string) {
  await act(async () => {
    api!.handleCloseWorkspaceTabById(tabId)
  })
  await settle()
}

beforeEach(async () => {
  vi.clearAllMocks()
  closeWorkspaceTab.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Surface, { tabs: [DESIGN] }))
  })
})

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister()
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceTabControllers', () => {
  it('closes a Design tab once its pending save is written', async () => {
    const editor = openEditor(DESIGN.path, () => Promise.resolve())
    await closeTab(DESIGN.id)
    expect(editor.flush).toHaveBeenCalledTimes(1)
    expect(closeWorkspaceTab).toHaveBeenCalledWith(DESIGN.id)
  })

  it('keeps a Design tab open and shows the save failure when its save fails', async () => {
    const editor = openEditor(DESIGN.path, () => Promise.reject(new Error('disk full')))
    await closeTab(DESIGN.id)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
    expect(notify.error).toHaveBeenCalledTimes(1)
    expect(editor.flush).toHaveBeenCalledTimes(1)
  })
})
