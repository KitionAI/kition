import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceTabs } from './useWorkspaceTabs'

vi.mock('@/services/desktop', () => ({}))

// The real hook requires more props than just rootPath, so we provide minimal
// stubs. The rename path doesn't exercise onOpenDocument / onActivateGallery.
function Surface({ apiRef }: { apiRef: { current: ReturnType<typeof useWorkspaceTabs> | null } }) {
  const api = useWorkspaceTabs({
    rootPath: '/ws',
    activeDocumentPath: '',
    onOpenDocument: async () => {},
    onActivateGallery: () => {},
  })
  useEffect(() => {
    apiRef.current = api
  })
  apiRef.current = api
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.localStorage.clear()
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

describe('useWorkspaceTabs rename remap', () => {
  it('keeps one file-level tab while switching views and remaps it on rename', () => {
    const apiRef: { current: ReturnType<typeof useWorkspaceTabs> | null } = { current: null }
    act(() => {
      root = createRoot(container)
      root.render(createElement(Surface, { apiRef }))
    })
    act(() => {
      apiRef.current!.upsertWorkspaceTab({
        id: 'kitable:Leads.kitable',
        type: 'table',
        title: 'Leads',
        kitablePath: 'Leads.kitable',
        tableId: 42,
        format: 'data',
      }, { activate: true })
      apiRef.current!.upsertWorkspaceTab({
        id: 'kitable:Leads.kitable',
        type: 'workflow',
        title: 'Leads',
        kitablePath: 'Leads.kitable',
        workflowId: 'auto_1',
      }, { activate: false })
    })
    expect(apiRef.current!.workspaceTabs).toHaveLength(1)
    expect(apiRef.current!.workspaceTabs[0]).toMatchObject({
      id: 'kitable:Leads.kitable',
      type: 'workflow',
      title: 'Leads',
      workflowId: 'auto_1',
    })
    act(() => {
      apiRef.current!.renameWorkspaceTabPath('Leads.kitable', 'Customers.kitable')
    })
    expect(apiRef.current!.workspaceTabs).toEqual([{
      id: 'kitable:Customers.kitable',
      type: 'workflow',
      title: 'Customers',
      kitablePath: 'Customers.kitable',
      workflowId: 'auto_1',
    }])
  })
})
