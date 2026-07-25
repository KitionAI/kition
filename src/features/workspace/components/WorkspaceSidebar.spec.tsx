import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceSidebar } from './WorkspaceSidebar'

let container: HTMLDivElement
let root: Root | null = null

function defaultProps(overrides: Partial<Parameters<typeof WorkspaceSidebar>[0]> = {}): Parameters<typeof WorkspaceSidebar>[0] {
  return {
    loading: false,
    rootPath: '/tmp/test',
    workspaceDisplayName: 'test',
    privateExpanded: true,
    createMenuOpen: false,
    createMenuTriggerPath: '',
    treeContent: createElement('div', null, 'Tree'),
    onTogglePrivate: vi.fn(),
    onOpenCreateMenu: vi.fn(),
    onCloseCreateMenu: vi.fn(),
    onCreateFolder: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateTable: vi.fn(),
    ...overrides,
  }
}

async function mount(props: Parameters<typeof WorkspaceSidebar>[0]) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WorkspaceSidebar, props))
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('WorkspaceSidebar', () => {
  it('keeps the deferred Browser tab out of the sidebar', async () => {
    await mount(defaultProps({ showBrowserTab: true }))

    const tabs = Array.from(container.querySelectorAll('.workspace-sidebar-tabs button'))
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Files',
      'Search',
    ])
    expect(container.querySelector('[data-testid="workspace-sidebar-workflows-button"]')).toBeNull()
  })

  it('clicking the Search tab opens the search modal instead of hiding the tree', async () => {
    const onOpenSearch = vi.fn()
    await mount(defaultProps({
      treeContent: createElement('div', { 'data-testid': 'sentinel-tree' }, 'Tree'),
      onOpenSearch,
    }))

    // Files tab is the default → tree is visible.
    expect(container.querySelector('[data-testid="sentinel-tree"]')).not.toBeNull()

    const searchTab = container.querySelector('[data-testid="sidebar-tab-search"]') as HTMLButtonElement
    expect(searchTab).not.toBeNull()
    await act(async () => {
      searchTab.click()
      await Promise.resolve()
    })

    // Search is now an action button that opens the modal — the tree stays put.
    expect(onOpenSearch).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="sentinel-tree"]')).not.toBeNull()
    expect(container.querySelector('.document-private-heading')).not.toBeNull()
  })

  it('keeps the header create action available when the workspace tree is empty', async () => {
    const onOpenCreateMenu = vi.fn()
    await mount(defaultProps({
      treeContent: null,
      onOpenCreateMenu,
    }))

    expect(container.textContent).not.toContain('No documents yet')

    const createButton = container.querySelector('.document-private-create') as HTMLButtonElement
    expect(createButton).not.toBeNull()
    await act(async () => {
      createButton.click()
      await Promise.resolve()
    })

    expect(onOpenCreateMenu).toHaveBeenCalledTimes(1)
  })
})
