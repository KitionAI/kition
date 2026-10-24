/**
 * Deleting a table file (or a folder, or a page with child pages, that may hold some) tells the
 * runtime, which removes the workflows, form syncs, and email syncs bound to it; moves are followed
 * the same way. A failed report never blocks the file operation.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import * as desktop from '@/services/desktop'
import * as kitTables from '@/api/kitTables'
import { useWorkspaceTreeNodeActions } from './useWorkspaceTreeNodeActions'

vi.mock('@/services/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/desktop')>()
  return {
    ...actual,
    deleteWorkspaceDocument: vi.fn(),
    deleteWorkspaceFolder: vi.fn(),
  }
})

vi.mock('@/api/kitTables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/kitTables')>()),
  reportTableFileDeleted: vi.fn(async () => ({ removed: 1 })),
  reportTableFileRenamed: vi.fn(async () => ({ updated: 0 })),
}))

vi.mock('@/services/workspaceEditSessions', () => ({
  flushWorkspaceEditSessions: vi.fn(async () => {}),
}))

vi.mock('@kition/app-ui/confirm', () => ({
  useConfirm: () => async () => true,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'browser-local-workspace'
const EMPTY_LIST = { root_path: ROOT, items: [] }

function node(type: 'file' | 'folder', path: string, folderPath?: string): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const format = path.endsWith('.ktable') ? 'ktable' : 'markdown'
  return type === 'folder'
    ? { type, path, title: name, name, virtual: false, parentPath, children: [] }
    : { type, format, path, filePath: path, folderPath, title: name.replace(/\.\w+$/, ''), name, virtual: false, parentPath, children: [] } as WorkspaceTreeNode
}

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTreeNodeActions> | null = null
const setError = vi.fn()

function Surface() {
  api = useWorkspaceTreeNodeActions({
    activeDocumentPath: '',
    activeResourcePath: '',
    applyWorkspaceDocumentList: async () => {},
    filterWorkspaceTabs: () => {},
    refreshWorkspaceDocuments: async () => true,
    remapWorkspaceTabPaths: () => {},
    renameWorkspaceTabPath: () => {},
    rootPath: ROOT,
    setActiveResourcePath: () => {},
    setActiveWorkspaceTabId: () => {},
    setAgentModifiedDocumentPaths: () => {},
    setError,
    setFeedback: () => {},
    setSaving: () => {},
    treeState: { expandFolders: () => {}, flatTreeNodes: [], updateTreeMetadata: () => {} },
  })
  return null
}

const deleted = () => vi.mocked(kitTables.reportTableFileDeleted).mock.calls.map(([path]) => path)

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(desktop.deleteWorkspaceDocument).mockResolvedValue(EMPTY_LIST)
  vi.mocked(desktop.deleteWorkspaceFolder).mockResolvedValue(EMPTY_LIST)
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Surface))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceTreeNodeActions — table files', () => {
  it('reports a deleted table file', async () => {
    await act(() => api!.deleteDocumentNode(node('file', 'crm/Leads.ktable')))
    expect(desktop.deleteWorkspaceDocument).toHaveBeenCalledWith('crm/Leads.ktable')
    expect(deleted()).toEqual(['crm/Leads.ktable'])
  })

  it('reports a deleted folder, and a deleted page with child pages, for the table files in them', async () => {
    await act(() => api!.deleteDocumentNode(node('folder', 'crm')))
    await act(() => api!.deleteDocumentNode(node('file', 'Plan.md', 'Plan')))
    expect(deleted()).toEqual(['crm', 'Plan'])
  })

  it('reports nothing for a page without child pages', async () => {
    await act(() => api!.deleteDocumentNode(node('file', 'Notes.md')))
    expect(desktop.deleteWorkspaceDocument).toHaveBeenCalledWith('Notes.md')
    expect(deleted()).toEqual([])
  })

  it('deletes the file when the report fails', async () => {
    vi.mocked(kitTables.reportTableFileDeleted).mockRejectedValueOnce(new Error('runtime down'))
    await act(() => api!.deleteDocumentNode(node('file', 'Leads.ktable')))
    await act(async () => {})
    expect(desktop.deleteWorkspaceDocument).toHaveBeenCalledWith('Leads.ktable')
    expect(setError.mock.calls.map(([message]) => message).filter(Boolean)).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })
})
