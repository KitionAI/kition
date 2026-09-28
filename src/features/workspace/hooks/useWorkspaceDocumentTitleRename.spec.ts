import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockMoveWorkspaceDocument = vi.fn()
const mockRenameDataDocumentByPath = vi.fn()

vi.mock('@/services/desktop', () => ({
  moveWorkspaceDocument: (...args: unknown[]) => mockMoveWorkspaceDocument(...args),
}))
vi.mock('@/api/dataDocuments', () => ({
  renameDataDocumentByPath: (...args: unknown[]) => mockRenameDataDocumentByPath(...args),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import type { WorkspaceDocumentTreeItem } from '@/services/desktop'

import { useWorkspaceDocumentTitleRename } from './useWorkspaceDocumentTitleRename'

type Options = Parameters<typeof useWorkspaceDocumentTitleRename>[0]
type Api = ReturnType<typeof useWorkspaceDocumentTitleRename>

let container: HTMLDivElement
let root: Root | null = null

function Harness({ options, onReady }: { options: Options; onReady: (api: Api) => void }) {
  const api = useWorkspaceDocumentTitleRename(options)
  useEffect(() => onReady(api), [api, onReady])
  return null
}

async function mount(overrides: Partial<Options> = {}) {
  const treeItems: WorkspaceDocumentTreeItem[] = [
    { type: 'file', path: 'notes/old.md', name: 'old.md', format: 'markdown' } as WorkspaceDocumentTreeItem,
  ]
  const calls = {
    setTreeItems: vi.fn((updater: unknown) => { if (typeof updater === 'function') updater(treeItems) }),
    updateSnapshots: vi.fn(),
    setAgentModifiedDocumentPaths: vi.fn(),
    remapWorkspaceTabPaths: vi.fn(),
    remapOpenedDocumentDrafts: vi.fn(),
    setActiveResourcePath: vi.fn(),
    renameKitableChildrenIndexPath: vi.fn(),
    setSaving: vi.fn(),
    setError: vi.fn(),
    setFeedback: vi.fn(),
    ensureActiveDocumentSaved: vi.fn(async () => true),
  }
  const options: Options = {
    rootPath: '/vault',
    activeDocument: { path: 'notes/old.md', name: 'old.md', content: 'body' },
    activeDocumentFormat: 'markdown',
    activeResourcePath: '',
    treeState: {
      flatTreeNodes: [{ type: 'file', path: 'notes/old.md', name: 'old.md', title: 'old', format: 'markdown', parentPath: 'notes', children: [] }],
      setTreeItems: calls.setTreeItems as never,
      updateTreeMetadata: vi.fn(),
    },
    snapshots: [{ path: 'notes/old.md', name: 'old.md' }],
    ...calls,
    ...overrides,
  }
  let api: Api | null = null
  await act(async () => {
    root!.render(createElement(Harness, { options, onReady: (value) => { api = value } }))
  })
  return { api: api!, calls }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockMoveWorkspaceDocument.mockReset()
  mockRenameDataDocumentByPath.mockReset()
  mockRenameDataDocumentByPath.mockResolvedValue({ renamed: true })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceDocumentTitleRename', () => {
  it('moves the file and remaps snapshots, tabs, drafts, and modified paths', async () => {
    mockMoveWorkspaceDocument.mockResolvedValue({ path: 'notes/new.md', name: 'new.md', content: 'body' })
    const { api, calls } = await mount()

    await act(async () => { await api.saveDocumentTitle('new') })

    expect(mockMoveWorkspaceDocument).toHaveBeenCalledWith({ path: 'notes/old.md', target_folder: 'notes', target_name: 'new.md' })
    expect(calls.updateSnapshots).toHaveBeenCalledWith([{ path: 'notes/new.md', name: 'new.md' }])
    expect(calls.remapWorkspaceTabPaths).toHaveBeenCalledWith('notes/old.md', 'notes/new.md')
    expect(calls.remapOpenedDocumentDrafts).toHaveBeenCalledWith('notes/old.md', 'notes/new.md')
    expect(calls.setAgentModifiedDocumentPaths).toHaveBeenCalledTimes(1)
    expect(calls.setFeedback).toHaveBeenLastCalledWith('feedback.nameUpdated')
    expect(calls.setSaving.mock.calls.map(([value]) => value)).toEqual([true, false])
    expect(mockRenameDataDocumentByPath).not.toHaveBeenCalled()
    // Optimistic update, then the moved item replaces it; no rollback.
    expect(calls.setTreeItems).toHaveBeenCalledTimes(2)
  })

  it('syncs the runtime index for a .kitable rename', async () => {
    mockMoveWorkspaceDocument.mockResolvedValue({ path: 'crm.kitable', name: 'crm.kitable', content: '' })
    const { api, calls } = await mount({
      activeDocument: { path: 'leads.kitable', name: 'leads.kitable', content: '' },
      treeState: { flatTreeNodes: [], setTreeItems: vi.fn() as never, updateTreeMetadata: vi.fn() },
    })

    await act(async () => { await api.saveDocumentTitle('crm') })

    expect(calls.renameKitableChildrenIndexPath).toHaveBeenCalledWith('leads.kitable', 'crm.kitable')
    expect(mockRenameDataDocumentByPath).toHaveBeenCalledWith({ path: 'leads.kitable', target_path: 'crm.kitable', workspace_root: '/vault' })
  })

  it('rolls the tree back and reports the error when the move fails', async () => {
    mockMoveWorkspaceDocument.mockRejectedValue(new Error('disk full'))
    const { api, calls } = await mount()

    await act(async () => { await api.saveDocumentTitle('new') })

    expect(calls.setError).toHaveBeenCalledWith('disk full')
    // Optimistic update, then the rollback.
    expect(calls.setTreeItems).toHaveBeenCalledTimes(2)
    expect(calls.remapWorkspaceTabPaths).not.toHaveBeenCalled()
  })

  it('does nothing for data documents, unchanged titles, or when the save before rename fails', async () => {
    const unchanged = await mount()
    await act(async () => { await unchanged.api.saveDocumentTitle('old') })
    expect(mockMoveWorkspaceDocument).not.toHaveBeenCalled()

    const data = await mount({ activeDocumentFormat: 'data' })
    await act(async () => { await data.api.saveDocumentTitle('new') })
    expect(mockMoveWorkspaceDocument).not.toHaveBeenCalled()

    const unsaved = await mount({ ensureActiveDocumentSaved: vi.fn(async () => false) })
    await act(async () => { await unsaved.api.saveDocumentTitle('new') })
    expect(mockMoveWorkspaceDocument).not.toHaveBeenCalled()
    expect(unsaved.calls.setTreeItems).toHaveBeenCalledTimes(2)
  })
})
