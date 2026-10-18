/**
 * Tree operations keep Markdown documents' identities: renames and moves of files (with their child pages) and of
 * folders remap the replica store's path index, deletes forget entries (their replicas are kept until the next
 * workspace open prunes them), and a duplicate gets no entry. Store failures never block the file operation. The store is the real browser-preview backend.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import * as desktop from '@/services/desktop'
import { useWorkspaceTreeNodeActions } from './useWorkspaceTreeNodeActions'

vi.mock('@/services/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/desktop')>()
  return {
    ...actual,
    moveWorkspaceDocument: vi.fn(),
    moveWorkspaceFolder: vi.fn(),
    deleteWorkspaceDocument: vi.fn(),
    deleteWorkspaceFolder: vi.fn(),
    readWorkspaceDocument: vi.fn(),
    writeWorkspaceDocument: vi.fn(),
    readDocumentIndex: vi.fn(actual.readDocumentIndex),
    writeDocumentIndex: vi.fn(actual.writeDocumentIndex),
  }
})

vi.mock('@/services/workspaceEditSessions', () => ({
  flushWorkspaceEditSessions: vi.fn(async () => {}),
}))

vi.mock('@/api/dataDocuments', () => ({
  deleteDataDocumentByPath: vi.fn(),
  renameDataDocumentByPath: vi.fn(async () => ({ renamed: true })),
}))

vi.mock('@kition/app-ui/confirm', () => ({
  useConfirm: () => async () => true,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'browser-local-workspace'
const EMPTY_LIST = { root_path: ROOT, items: [] }

function fileNode(path: string): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return { type: 'file', format: 'markdown', path, filePath: path, title: name.replace(/\.md$/, ''), name, virtual: false, parentPath, children: [] }
}

function folderNode(path: string): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return { type: 'folder', path, title: name, name, virtual: false, parentPath, children: [] }
}

const nodes = [
  fileNode('Notes/Plan.md'),
  fileNode('Notes/Plan/Child.md'),
  fileNode('Notes/Other.md'),
  folderNode('Notes'),
  folderNode('Archive'),
  folderNode('Team'),
  fileNode('Team/Sub/Deep.md'),
]
const node = (path: string) => nodes.find((item) => item.path === path)!

const IDS = {
  'Notes/Plan.md': 'doc-plan',
  'Notes/Plan/Child.md': 'doc-child',
  'Notes/Other.md': 'doc-other',
  'Team/Sub/Deep.md': 'doc-deep',
}

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTreeNodeActions> | null = null
const setError = vi.fn()
const refreshWorkspaceDocuments = vi.fn(async () => true)

function Surface() {
  api = useWorkspaceTreeNodeActions({
    activeDocumentPath: '',
    activeResourcePath: '',
    applyWorkspaceDocumentList: async () => {},
    filterWorkspaceTabs: () => {},
    hasUnsavedChanges: false,
    persistActiveDocument: async () => true,
    forgetOpenedDocuments: () => {},
    refreshWorkspaceDocuments,
    remapWorkspaceTabPaths: () => {},
    renameWorkspaceTabPath: () => {},
    rootPath: ROOT,
    setActiveResourcePath: () => {},
    setActiveWorkspaceTabId: () => {},
    setAgentModifiedDocumentPaths: () => {},
    setError,
    setFeedback: () => {},
    setSaving: () => {},
    treeState: { expandFolders: () => {}, flatTreeNodes: nodes, updateTreeMetadata: () => {} },
  })
  return null
}

/** Where the desktop shell moves `path`: into `target_folder` (default: its own folder) as `target_name` (default: its name). */
function movedPath({ path, target_folder, target_name }: { path: string; target_folder?: string; target_name?: string }) {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const folder = target_folder === undefined ? parent : target_folder
  const name = target_name || path.split('/').pop()!
  return folder ? `${folder}/${name}` : name
}

const index = async () => (await desktop.readDocumentIndex()).entries
const errors = () => setError.mock.calls.map(([message]) => message).filter(Boolean)

async function storeEntry(docId: string) {
  await desktop.writeDocumentStore(docId, {
    meta: { docId, kit: 'kit.document', path: '', fileHash: '', fileStamp: null, exported: '', style: { eol: '\n', bom: false, finalNewline: true } },
    snapshot: new Uint8Array([1]),
  })
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action()
  })
}

beforeEach(async () => {
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await desktop.writeDocumentIndex({ ...IDS }, null)
  for (const docId of Object.values(IDS)) await storeEntry(docId)
  vi.mocked(desktop.moveWorkspaceDocument).mockImplementation(async (request) => {
    const target = movedPath(request)
    return { path: target, name: target.split('/').pop()!, content: '' }
  })
  vi.mocked(desktop.moveWorkspaceFolder).mockImplementation(async (request) => ({ ...EMPTY_LIST, moved_path: movedPath(request) }))
  vi.mocked(desktop.deleteWorkspaceDocument).mockResolvedValue(EMPTY_LIST)
  vi.mocked(desktop.deleteWorkspaceFolder).mockResolvedValue(EMPTY_LIST)
  vi.mocked(desktop.writeWorkspaceDocument).mockImplementation(async (path, content) => ({ path, name: path, content }))
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

describe('useWorkspaceTreeNodeActions — document identity', () => {
  it('keeps ids on a renamed file and its child pages', async () => {
    await run(() => api!.renameWorkspaceNode(node('Notes/Plan.md'), 'Roadmap'))
    expect(await index()).toEqual({
      'Notes/Roadmap.md': 'doc-plan',
      'Notes/Roadmap/Child.md': 'doc-child',
      'Notes/Other.md': 'doc-other',
      'Team/Sub/Deep.md': 'doc-deep',
    })
    expect(errors()).toEqual([])
  })

  it('updates the index before the tree refresh reopens the renamed file', async () => {
    let seen: Record<string, string> | null = null
    refreshWorkspaceDocuments.mockImplementationOnce(async () => {
      seen = await index()
      return true
    })
    await run(() => api!.renameWorkspaceNode(node('Notes/Plan.md'), 'Roadmap'))
    expect(seen).toMatchObject({ 'Notes/Roadmap.md': 'doc-plan' })
  })

  it('keeps ids of nested documents on a renamed folder', async () => {
    await run(() => api!.renameWorkspaceNode(node('Team'), 'Crew'))
    expect(await index()).toMatchObject({ 'Crew/Sub/Deep.md': 'doc-deep', 'Notes/Plan.md': 'doc-plan' })
    expect(await index()).not.toHaveProperty('Team/Sub/Deep.md')
  })

  it('keeps ids on a file dragged into another folder', async () => {
    await run(() => api!.dropWorkspaceNode('Notes/Plan.md', 'Archive', 'inside'))
    expect(await index()).toMatchObject({ 'Archive/Plan.md': 'doc-plan', 'Archive/Plan/Child.md': 'doc-child' })
    expect(await index()).not.toHaveProperty('Notes/Plan.md')
  })

  it('keeps ids on a folder dragged into another folder', async () => {
    await run(() => api!.dropWorkspaceNode('Team', 'Archive', 'inside'))
    expect(await index()).toMatchObject({ 'Archive/Team/Sub/Deep.md': 'doc-deep' })
  })

  it('keeps ids on a file and a folder moved with "Move to"', async () => {
    await run(() => api!.moveWorkspaceNodeToFolder(node('Notes/Other.md'), node('Archive')))
    await run(() => api!.moveWorkspaceNodeToFolder(node('Team'), null))
    expect(await index()).toMatchObject({ 'Archive/Other.md': 'doc-other', 'Team/Sub/Deep.md': 'doc-deep' })
    expect(await index()).not.toHaveProperty('Notes/Other.md')
  })

  /** The index entries on workspace paths (deleted documents wait for the next prune under `.kition/`). */
  const livePaths = async () => Object.fromEntries(Object.entries(await index()).filter(([path]) => !path.startsWith('.kition/')))

  it('forgets a deleted file with its child pages and keeps their replicas until the next prune', async () => {
    await run(() => api!.deleteDocumentNode(node('Notes/Plan.md')))
    expect(await livePaths()).toEqual({ 'Notes/Other.md': 'doc-other', 'Team/Sub/Deep.md': 'doc-deep' })
    expect(await desktop.readDocumentStore('doc-plan')).not.toBeNull()
    expect(await desktop.readDocumentStore('doc-child')).not.toBeNull()
    expect(await desktop.readDocumentStore('doc-other')).not.toBeNull()
  })

  it('forgets the documents of a deleted folder', async () => {
    await run(() => api!.deleteDocumentNode(node('Team')))
    expect(await livePaths()).not.toHaveProperty('Team/Sub/Deep.md')
    expect(await desktop.readDocumentStore('doc-deep')).not.toBeNull()
  })

  it('leaves a duplicate without an entry so that it opens as a new document', async () => {
    // A stale entry at the copy's path (its file was deleted outside Kition) is dropped.
    await desktop.writeDocumentIndex({ ...IDS, 'Notes/Plan copy.md': 'doc-stale' }, (await desktop.readDocumentIndex()).version)
    vi.mocked(desktop.readWorkspaceDocument).mockResolvedValue({ path: 'Notes/Plan.md', name: 'Plan.md', content: '# Plan\n' })
    await run(() => api!.duplicateDocumentNode(node('Notes/Plan.md')))
    expect(desktop.writeWorkspaceDocument).toHaveBeenCalledWith('Notes/Plan copy.md', '# Plan\n')
    expect(await index()).toEqual(IDS)
    expect(errors()).toEqual([])
  })

  it('completes the file operation when the store cannot be updated', async () => {
    vi.mocked(desktop.writeDocumentIndex)
      .mockRejectedValueOnce(new Error('read-only store'))
      .mockRejectedValueOnce(new Error('read-only store'))
    await run(() => api!.renameWorkspaceNode(node('Notes/Plan.md'), 'Roadmap'))
    await run(() => api!.deleteDocumentNode(node('Notes/Other.md')))
    expect(desktop.moveWorkspaceDocument).toHaveBeenCalled()
    expect(desktop.deleteWorkspaceDocument).toHaveBeenCalled()
    expect(refreshWorkspaceDocuments).toHaveBeenCalledWith('Notes/Roadmap.md')
    expect(errors()).toEqual([])
    expect(console.warn).toHaveBeenCalled()
    expect(await index()).toEqual(IDS)
  })
})
