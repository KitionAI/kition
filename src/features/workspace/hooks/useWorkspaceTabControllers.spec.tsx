import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { useWorkspaceTabControllers } from './useWorkspaceTabControllers'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const FILE: WorkspaceTab = { id: 'file-viewer:Notes.md', type: 'file-viewer', title: 'Notes', path: 'Notes.md', format: 'markdown' }
const WORKFLOW: WorkspaceTab = { id: 'workflow:Leads.ktable', type: 'workflow', title: 'Leads', tablePath: 'Leads.ktable' }

let container: HTMLDivElement | null = null
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTabControllers> | null = null

function Surface({ tabs, closeWorkspaceTab, onCloseWorkflow }: {
  tabs: WorkspaceTab[]
  closeWorkspaceTab: (tabId: string) => void
  onCloseWorkflow: () => void
}) {
  api = useWorkspaceTabControllers({
    workspaceTabs: tabs,
    activeWorkspaceTab: tabs[0],
    activeWorkspaceTabId: tabs[0]?.id ?? '',
    closeWorkspaceTab,
    upsertWorkspaceTab: () => {},
    setActiveResourcePath: () => {},
    workflowOpen: true,
    onCloseWorkflow,
    openDocument: async () => {},
  })
  return null
}

async function mount(tabs: WorkspaceTab[]) {
  const closeWorkspaceTab = vi.fn()
  const onCloseWorkflow = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(Surface, { tabs, closeWorkspaceTab, onCloseWorkflow }))
  })
  return { closeWorkspaceTab, onCloseWorkflow }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('useWorkspaceTabControllers', () => {
  it('closes a file tab and leaves the workflow workbench open', async () => {
    const { closeWorkspaceTab, onCloseWorkflow } = await mount([FILE, WORKFLOW])
    await act(async () => api!.handleCloseWorkspaceTabById(FILE.id))
    expect(closeWorkspaceTab).toHaveBeenCalledWith(FILE.id)
    expect(onCloseWorkflow).not.toHaveBeenCalled()
  })

  it('closes the workflow workbench with its last workflow tab', async () => {
    const { closeWorkspaceTab, onCloseWorkflow } = await mount([WORKFLOW, FILE])
    await act(async () => api!.handleCloseWorkspaceTabById(WORKFLOW.id))
    expect(closeWorkspaceTab).toHaveBeenCalledWith(WORKFLOW.id)
    expect(onCloseWorkflow).toHaveBeenCalledOnce()
  })
})
