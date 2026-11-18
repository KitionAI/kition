import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UnsavedCloseChoice, UnsavedCloseScope } from '@/features/workspace/components/UnsavedCloseDialog'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { useWorkspaceTabControllers } from './useWorkspaceTabControllers'

const kits = vi.hoisted(() => ({ unsaved: new Set<string>(), saves: [] as string[], saved: true }))
vi.mock('@/features/kits/public', () => ({
  openWithUnsavedEdits: (path: string) => kits.unsaved.has(path),
  saveOpenEditor: async (path: string) => {
    kits.saves.push(path)
    return kits.saved
  },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const FILE: WorkspaceTab = { id: 'file-viewer:Notes.md', type: 'file-viewer', title: 'Notes', path: 'Notes.md', format: 'markdown' }

let container: HTMLDivElement | null = null
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTabControllers> | null = null

function Surface({ tabs, closeWorkspaceTab, askUnsavedClose }: {
  tabs: WorkspaceTab[]
  closeWorkspaceTab: (tabId: string) => void
  askUnsavedClose: (scope: UnsavedCloseScope) => Promise<UnsavedCloseChoice>
}) {
  api = useWorkspaceTabControllers({
    workspaceTabs: tabs,
    activeWorkspaceTabId: tabs[0]?.id ?? '',
    closeWorkspaceTab,
    upsertWorkspaceTab: () => {},
    openDocument: async () => {},
    askUnsavedClose,
  })
  return null
}

async function mount(tabs: WorkspaceTab[], choice: UnsavedCloseChoice = 'cancel') {
  const closeWorkspaceTab = vi.fn()
  const askUnsavedClose = vi.fn(async () => choice)
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(Surface, { tabs, closeWorkspaceTab, askUnsavedClose }))
  })
  return { closeWorkspaceTab, askUnsavedClose }
}

afterEach(async () => {
  kits.unsaved.clear()
  kits.saves.length = 0
  kits.saved = true
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('useWorkspaceTabControllers', () => {
  it('closes a kit tab without unsaved edits without asking', async () => {
    const { closeWorkspaceTab, askUnsavedClose } = await mount([FILE])
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(askUnsavedClose).not.toHaveBeenCalled()
    expect(closeWorkspaceTab).toHaveBeenCalledWith(FILE.id)
  })

  it('keeps a kit tab with unsaved edits open when the person cancels', async () => {
    kits.unsaved.add(FILE.path)
    const { closeWorkspaceTab, askUnsavedClose } = await mount([FILE], 'cancel')
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(askUnsavedClose).toHaveBeenCalledWith({ kind: 'tab', names: ['Notes'] })
    expect(kits.saves).toEqual([])
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
  })

  it('saves a kit tab with unsaved edits before closing it, and keeps it open when the save fails', async () => {
    kits.unsaved.add(FILE.path)
    const { closeWorkspaceTab } = await mount([FILE], 'save')
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(kits.saves).toEqual([FILE.path])
    expect(closeWorkspaceTab).toHaveBeenCalledWith(FILE.id)

    kits.saved = false
    closeWorkspaceTab.mockClear()
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
  })

  it('closes a kit tab without saving when the person chooses not to save', async () => {
    kits.unsaved.add(FILE.path)
    const { closeWorkspaceTab } = await mount([FILE], 'discard')
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(kits.saves).toEqual([])
    expect(closeWorkspaceTab).toHaveBeenCalledWith(FILE.id)
  })
})
