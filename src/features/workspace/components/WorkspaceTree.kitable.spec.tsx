import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceTree } from './WorkspaceTree'
import {
  buildKitableTableVirtualPath,
} from '@/features/workspace/lib/workspaceTree'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

const kitablePath = 'Leads.kitable'

function tableChild(id: number, title: string): WorkspaceTreeNode {
  return {
    type: 'file',
    virtual: true,
    path: buildKitableTableVirtualPath(kitablePath, id),
    name: title,
    title,
    format: 'data',
    parentPath: kitablePath,
    children: [],
  }
}

const kitableNode: WorkspaceTreeNode = {
  type: 'file',
  path: kitablePath,
  filePath: kitablePath,
  name: 'Leads.kitable',
  title: 'Leads',
  format: 'data',
  parentPath: '',
  children: [
    tableChild(7, 'Leads'),
    tableChild(8, 'Companies'),
  ],
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

function renderTree(props: Partial<Parameters<typeof WorkspaceTree>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onToggleFolder: vi.fn(),
    onCreateInside: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onRename: vi.fn(),
    onMoveToFolder: vi.fn(),
    onSetIcon: vi.fn(),
    onDropNode: vi.fn(),
    ...props,
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(WorkspaceTree, {
      nodes: [kitableNode],
      activePath: '',
      expandedPaths: new Set([kitablePath]),
      modifiedPaths: new Set<string>(),
      icons: {},
      moveTargets: [],
      ...handlers,
    }))
  })
  return handlers
}

describe('WorkspaceTree — kitable row', () => {
  it('clicking the row body selects the kitable without expanding virtual table rows', () => {
    const handlers = renderTree()
    const row = container.querySelector('.document-tree-page') as HTMLElement
    expect(row).toBeTruthy()
    act(() => { row.click() })
    expect(handlers.onToggleFolder).not.toHaveBeenCalled()
    expect(handlers.onOpen).toHaveBeenCalledWith(kitablePath)
    expect(container.textContent).not.toContain('Companies')
  })

  it('does not render a disclosure toggle when the kitable only has virtual children', () => {
    renderTree()
    const row = container.querySelector('.document-tree-page') as HTMLElement
    expect(row.querySelector('.document-tree-lead-toggle')).toBeNull()
  })

  it('the "Show workflows" action is not present in the ... menu', () => {
    const handlers = renderTree()
    const moreButton = container.querySelector(
      '.document-tree-row.document-tree-page .document-tree-menu-wrap .document-tree-action',
    ) as HTMLElement | null
    expect(moreButton).toBeTruthy()
    act(() => { moreButton!.click() })
    const showWorkflows = container.querySelector(
      '[data-testid="kitable-action-show-workflows"]',
    )
    expect(showWorkflows).toBeNull()
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it('the inline + on the kitable row calls onCreateInside with the kitable node', () => {
    const handlers = renderTree()
    const plus = container.querySelector('.document-tree-row.document-tree-page .document-tree-action') as HTMLElement
    expect(plus).toBeTruthy()
    act(() => { plus.click() })
    expect(handlers.onCreateInside).toHaveBeenCalled()
    expect(vi.mocked(handlers.onCreateInside).mock.calls[0][0].path).toBe(kitablePath)
  })
})
