import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocument, WorkspaceDocumentListResponse } from '@/services/desktop'
import { useWorkspaceTreeLoader } from './useWorkspaceTreeLoader'

const desktop = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }))
vi.mock('@/services/desktop', () => ({
  listWorkspaceDocuments: desktop.list,
  readWorkspaceDocument: desktop.read,
  chooseWorkspaceFolder: vi.fn(),
  isDesktopRuntime: () => false,
  revealWorkspaceFolder: vi.fn(),
  setWorkspaceFolder: vi.fn(),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const welcome: WorkspaceDocument = { path: 'Welcome.md', name: 'Welcome', content: 'Welcome' }
const listing: WorkspaceDocumentListResponse = {
  root_path: '/workspace',
  items: [{ type: 'file', path: welcome.path, name: welcome.name, format: 'markdown' }],
}
const apply = vi.fn()
const clear = vi.fn()
const treeState = {
  rootPath: '/workspace',
  setLoading: vi.fn(),
  setRecentWorkspacePaths: vi.fn(),
  setRootPath: vi.fn(),
  setTreeItems: vi.fn(),
}
const setError = vi.fn()
const setFeedback = vi.fn()
let root: Root
let container: HTMLDivElement

function Surface({ activePath }: { activePath: string }) {
  useWorkspaceTreeLoader({
    activeDocumentPath: activePath,
    applyWorkspaceDocument: apply,
    clearActiveDocumentSession: clear,
    setError,
    setFeedback,
    treeState,
  })
  return null
}

async function render(activePath: string) {
  await act(async () => root.render(createElement(Surface, { activePath })))
}

async function reload(onlyWhenEmpty = true) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kition:workspace-reload', {
      detail: { preferredPath: welcome.path, onlyWhenEmpty },
    }))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetAllMocks()
  localStorage.clear()
  desktop.list.mockResolvedValue({ root_path: '/workspace', items: [] })
  desktop.read.mockResolvedValue(welcome)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await render('')
  vi.clearAllMocks()
  desktop.list.mockResolvedValue(listing)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('automatic welcome document activation', () => {
  it('refreshes the tree without replacing an open kit or its unsaved edits', async () => {
    await render('Keynote.kslide')
    await reload()
    expect(treeState.setTreeItems).toHaveBeenCalledWith(listing.items)
    expect(desktop.read).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('preserves a kit opened while the file list is loading', async () => {
    const pending = deferred<WorkspaceDocumentListResponse>()
    desktop.list.mockReturnValueOnce(pending.promise)
    await reload()
    await render('Keynote.kslide')
    await act(async () => pending.resolve(listing))
    expect(treeState.setTreeItems).toHaveBeenCalledWith(listing.items)
    expect(desktop.read).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('preserves a kit opened while the welcome document is being read', async () => {
    const pending = deferred<WorkspaceDocument>()
    desktop.read.mockReturnValueOnce(pending.promise)
    await reload()
    expect(desktop.read).toHaveBeenCalledWith(welcome.path)
    await render('Keynote.kslide')
    await act(async () => pending.resolve(welcome))
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('opens the welcome document when no document has been selected', async () => {
    await reload()
    expect(desktop.read).toHaveBeenCalledWith(welcome.path)
    expect(apply).toHaveBeenCalledExactlyOnceWith(welcome)
  })

  it('still honors an explicit request to open the welcome document', async () => {
    await render('Keynote.kslide')
    await reload(false)
    expect(desktop.read).toHaveBeenCalledWith(welcome.path)
    expect(apply).toHaveBeenCalledExactlyOnceWith(welcome)
  })
})
