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
  it('shows the Files and Search tabs', async () => {
    await mount(defaultProps())

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

  it('omits file import from the header create menu', async () => {
    await mount(defaultProps({
      createMenuOpen: true,
      createMenuTriggerPath: '',
    }))

    const options = Array.from(document.body.querySelectorAll('.document-create-option'))
      .map((option) => option.textContent?.trim())
    expect(options).toEqual(['Folder'])
    expect(document.body.textContent).not.toContain('Import file')
  })

  it('imports OS files dropped on the tree area into the workspace root', async () => {
    const onPasteFiles = vi.fn()
    await mount(defaultProps({ onPasteFiles }))
    const zone = container.querySelector<HTMLElement>('[data-testid="document-tree-drop-zone"]')!
    const file = new File(['8BPS'], 'Poster.psd', { type: 'image/vnd.adobe.photoshop' })
    const transfer = { types: ['Files'], files: [file], items: [], dropEffect: 'none' }
    const dragEvent = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      return event
    }

    const over = dragEvent('dragover')
    await act(async () => { zone.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(true)
    expect(transfer.dropEffect).toBe('copy')
    expect(zone.className).toContain('ring-primary/40')

    const drop = dragEvent('drop')
    await act(async () => { zone.dispatchEvent(drop); await Promise.resolve() })
    expect(drop.defaultPrevented).toBe(true)
    expect(onPasteFiles).toHaveBeenCalledWith([{ file, relativePath: 'Poster.psd' }])
    expect(zone.className).not.toContain('ring-primary/40')
  })

  it('ignores drags that carry no files', async () => {
    const onPasteFiles = vi.fn()
    await mount(defaultProps({ onPasteFiles }))
    const zone = container.querySelector<HTMLElement>('[data-testid="document-tree-drop-zone"]')!
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], files: [], items: [] } })
    await act(async () => { zone.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  })
})
