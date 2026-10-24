import { describe, expect, it } from 'vitest'

import {
  buildPrivateSectionTreeNodes,
  insertWorkspaceTreeDocumentItem,
  renameWorkspaceTreeBranchMetadata,
  replaceWorkspaceTreeDocumentItem,
} from './workspaceTree'
import type { WorkspaceDocumentTreeItem, WorkspaceDocumentFormat } from '@/services/desktop'
import type { WorkspaceTreeMetadata } from './workspacePersistence'

const emptyMetadata: WorkspaceTreeMetadata = { order: {}, icons: {}, collapsed: [], expandedFolders: [] }

function file(path: string, name = path): WorkspaceDocumentTreeItem {
  return { type: 'file', path, name, format: 'md' as never, size: 0, updated_at: '' } as WorkspaceDocumentTreeItem
}

describe('buildPrivateSectionTreeNodes hidden workflow storage', () => {
  it('hides workflow.json and workflow_runs.json from the root tree', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [
        file('workflow.json'),
        file('workflow_runs.json'),
        file('inbox.md'),
      ],
      emptyMetadata,
    )
    // The raw workflow.json / workflow_runs.json storage files stay
    // hidden from the tree. The global Workflows entry point has been
    // moved out of the tree into a sidebar-header lightning-bolt icon,
    // so we only expect the surviving real files here.
    expect(nodes.map((n) => n.name)).toEqual(['inbox.md'])
  })

  it('does not hide raw workflow files that live inside subfolders (devmode path)', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [
        {
          type: 'folder',
          path: 'debug',
          name: 'debug',
          children: [file('debug/workflow.json', 'workflow.json')],
        } as WorkspaceDocumentTreeItem,
      ],
      emptyMetadata,
    )
    // The folder survives and the nested file is preserved — the
    // root-only filter is intentional so subdirectories can be used
    // for backups / debug dumps without disappearing.
    expect(nodes[0].name).toBe('debug')
    expect(nodes[0].children.map((c) => c.name)).toEqual(['workflow.json'])
  })
})

describe('buildPrivateSectionTreeNodes Board files', () => {
  it('lists a .kboard file as a Board, the Board kit opens it', () => {
    const nodes = buildPrivateSectionTreeNodes([{
      type: 'file',
      path: 'Planning.kboard',
      name: 'Planning.kboard',
    }], emptyMetadata)

    expect(nodes).toEqual([
      expect.objectContaining({
        path: 'Planning.kboard',
        title: 'Planning',
        format: 'board',
      }),
    ])
  })
})

describe('insertWorkspaceTreeDocumentItem', () => {
  const doc = (path: string, name: string) => ({
    path,
    name,
    content: '',
    format: 'markdown' as WorkspaceDocumentFormat,
  })

  it('inserts a new file at the root', () => {
    const items = [file('inbox.md')]
    const next = insertWorkspaceTreeDocumentItem(items, doc('Untitled.md', 'Untitled.md'))
    expect(next.map((i) => i.path).sort()).toEqual(['Untitled.md', 'inbox.md'])
    // original array is not mutated
    expect(items).toHaveLength(1)
  })

  it('inserts into the matching parent folder without touching siblings', () => {
    const items: WorkspaceDocumentTreeItem[] = [
      file('inbox.md'),
      { type: 'folder', path: 'outputs', name: 'outputs', children: [file('outputs/a.md', 'a.md')] },
    ]
    const next = insertWorkspaceTreeDocumentItem(items, doc('outputs/b.md', 'b.md'))
    const outputs = next.find((i) => i.path === 'outputs')
    expect(outputs?.children?.map((c) => c.path).sort()).toEqual(['outputs/a.md', 'outputs/b.md'])
    // root-level siblings untouched
    expect(next.find((i) => i.path === 'inbox.md')).toBeTruthy()
  })

  it('inserts into a deeply nested folder', () => {
    const items: WorkspaceDocumentTreeItem[] = [
      {
        type: 'folder',
        path: 'a',
        name: 'a',
        children: [{ type: 'folder', path: 'a/b', name: 'b', children: [] }],
      },
    ]
    const next = insertWorkspaceTreeDocumentItem(items, doc('a/b/c.md', 'c.md'))
    const b = next[0].children?.find((i) => i.path === 'a/b')
    expect(b?.children?.map((c) => c.path)).toEqual(['a/b/c.md'])
  })

  it('replaces an existing entry with the same path (idempotent)', () => {
    const items = [file('outputs/a.md', 'a.md'), file('note.md', 'note.md')]
    const next = insertWorkspaceTreeDocumentItem(items, doc('note.md', 'note.md'))
    expect(next.filter((i) => i.path === 'note.md')).toHaveLength(1)
    expect(next).toHaveLength(2)
  })
})

describe('replaceWorkspaceTreeDocumentItem', () => {
  const document = (path: string, name: string) => ({
    path,
    name,
    content: 'Body',
    format: 'markdown' as WorkspaceDocumentFormat,
    size: 4,
    updated_at: '2026-08-14T00:00:00Z',
  })

  it('replaces the previous path and name after a document rename', () => {
    const items = [file('Untitled note 2.md')]
    const next = replaceWorkspaceTreeDocumentItem(
      items,
      'Untitled note 2.md',
      document('Untitled444 note 2.md', 'Untitled444 note 2.md'),
    )

    expect(next).toEqual([expect.objectContaining({
      path: 'Untitled444 note 2.md',
      name: 'Untitled444 note 2.md',
      size: 4,
    })])
    expect(items[0].path).toBe('Untitled note 2.md')
  })

  it('updates a nested document without disturbing sibling files', () => {
    const items: WorkspaceDocumentTreeItem[] = [
      {
        type: 'folder',
        path: 'notes',
        name: 'notes',
        children: [file('notes/a.md', 'a.md'), file('notes/b.md', 'b.md')],
      },
    ]
    const next = replaceWorkspaceTreeDocumentItem(
      items,
      'notes/a.md',
      document('notes/renamed.md', 'renamed.md'),
    )

    expect(next[0].children?.map((item) => item.path)).toEqual([
      'notes/renamed.md',
      'notes/b.md',
    ])
  })

  it('finalizes an optimistic rename when the tree already has the new path', () => {
    const items = [file('renamed.md', 'renamed.md')]
    const next = replaceWorkspaceTreeDocumentItem(
      items,
      'original.md',
      document('renamed.md', 'renamed.md'),
    )

    expect(next).toEqual([expect.objectContaining({
      path: 'renamed.md',
      name: 'renamed.md',
      size: 4,
      updated_at: '2026-08-14T00:00:00Z',
    })])
  })
})

describe('renameWorkspaceTreeBranchMetadata', () => {
  const renamedDocument = {
    path: 'aardvark.md',
    name: 'aardvark.md',
    content: 'Renamed',
    format: 'markdown' as WorkspaceDocumentFormat,
    size: 7,
    updated_at: '2026-08-15T00:00:00Z',
  }

  it('keeps a renamed document at its current visible sibling position', () => {
    const items = [file('alpha.md'), file('middle.md'), file('zulu.md')]
    const initialNodes = buildPrivateSectionTreeNodes(items, emptyMetadata)
    const middleNode = initialNodes.find((node) => node.path === 'middle.md')!
    const metadata = renameWorkspaceTreeBranchMetadata(
      emptyMetadata,
      initialNodes,
      middleNode,
      renamedDocument.path,
    )
    const renamedItems = replaceWorkspaceTreeDocumentItem(items, middleNode.path, renamedDocument)
    const nextNodes = buildPrivateSectionTreeNodes(renamedItems, metadata)

    expect(nextNodes.map((node) => node.path)).toEqual([
      'alpha.md',
      'aardvark.md',
      'zulu.md',
    ])
    expect(metadata.order['']).toEqual(['alpha.md', 'aardvark.md', 'zulu.md'])
  })

  it('preserves an existing custom sibling order while replacing the renamed path', () => {
    const metadata: WorkspaceTreeMetadata = {
      ...emptyMetadata,
      order: { '': ['zulu.md', 'middle.md', 'alpha.md'] },
    }
    const items = [file('alpha.md'), file('middle.md'), file('zulu.md')]
    const initialNodes = buildPrivateSectionTreeNodes(items, metadata)
    const middleNode = initialNodes.find((node) => node.path === 'middle.md')!
    const nextMetadata = renameWorkspaceTreeBranchMetadata(
      metadata,
      initialNodes,
      middleNode,
      renamedDocument.path,
    )

    expect(nextMetadata.order['']).toEqual(['zulu.md', 'aardvark.md', 'alpha.md'])
  })
})
