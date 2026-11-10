/**
 * Kit files (a sheet, a slide deck, a PDF) rename and move from the tree like notes. One open in
 * its kit with unsaved edits is left where it is: the kit would open again from the new path
 * without them.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import * as desktop from '@/services/desktop'
import * as kits from '@/features/kits/public'
import { useWorkspaceTreeNodeActions } from './useWorkspaceTreeNodeActions'

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop')>()),
  moveWorkspaceDocument: vi.fn(),
}))

vi.mock('@/features/kits/public', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/kits/public')>()),
  openWithUnsavedEdits: vi.fn(() => false),
}))

vi.mock('@kition/tessera-ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@kition/tessera-ui')>()), useConfirm: () => async () => true }))

vi.mock('@/services/workspaceEditSessions', () => ({
  flushWorkspaceEditSessions: vi.fn(async () => {}),
}))

vi.mock('@/api/kitTables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/kitTables')>()),
  reportTableFileRenamed: vi.fn(async () => ({ updated: 0 })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'browser-local-workspace'

function file(path: string, format: WorkspaceTreeNode['format']): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return { type: 'file', format, path, filePath: path, title: name.replace(/\.\w+$/, ''), name, virtual: false, parentPath, children: [] } as WorkspaceTreeNode
}

const folder: WorkspaceTreeNode = { type: 'folder', path: 'finance', title: 'finance', name: 'finance', virtual: false, parentPath: '', children: [] } as WorkspaceTreeNode

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTreeNodeActions> | null = null
const setError = vi.fn()
const remapWorkspaceTabPaths = vi.fn()

function Surface() {
  api = useWorkspaceTreeNodeActions({
    activeDocumentPath: '',
    activeResourcePath: '',
    applyWorkspaceDocumentList: async () => {},
    filterWorkspaceTabs: () => {},
    refreshWorkspaceDocuments: async () => true,
    remapWorkspaceTabPaths,
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

const errors = () => setError.mock.calls.map(([message]) => message).filter(Boolean)

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(desktop.moveWorkspaceDocument).mockImplementation(async (request) => {
    const name = request.target_name || request.path.split('/').pop()!
    // A rename names no folder: the file stays in its own.
    const folder = request.target_folder ?? (request.path.includes('/') ? request.path.slice(0, request.path.lastIndexOf('/')) : '')
    const path = folder ? `${folder}/${name}` : name
    return { path, name, content: '', format: 'binary', updated_at: '', size: 0, mtime_ms: 0 } as never
  })
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

describe('useWorkspaceTreeNodeActions — kit files', () => {
  it('renames a slide deck, keeping its extension, and its tab follows', async () => {
    await act(() => api!.renameWorkspaceNode(file('talks/Deck.kslide', 'slide'), 'Pitch'))
    expect(errors()).toEqual([])
    expect(desktop.moveWorkspaceDocument).toHaveBeenCalledWith({ path: 'talks/Deck.kslide', target_name: 'Pitch.kslide' })
    expect(remapWorkspaceTabPaths).toHaveBeenCalledWith('talks/Deck.kslide', 'talks/Pitch.kslide')
  })

  it('moves a workbook into a folder', async () => {
    await act(() => api!.moveWorkspaceNodeToFolder(file('Budget.xlsx', 'xlsx'), folder))
    expect(errors()).toEqual([])
    expect(desktop.moveWorkspaceDocument).toHaveBeenCalledWith({ path: 'Budget.xlsx', target_folder: 'finance' })
  })

  it('leaves a file open with unsaved edits where it is, and says why', async () => {
    vi.mocked(kits.openWithUnsavedEdits).mockReturnValue(true)
    await act(() => api!.renameWorkspaceNode(file('Report.pdf', 'pdf'), 'Final'))
    await act(() => api!.moveWorkspaceNodeToFolder(file('Budget.xlsx', 'xlsx'), folder))
    expect(desktop.moveWorkspaceDocument).not.toHaveBeenCalled()
    expect(errors()).toHaveLength(2)
  })
})
