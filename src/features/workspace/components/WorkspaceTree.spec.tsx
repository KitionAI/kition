import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { WorkspaceTree } from './WorkspaceTree'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

function makeFileNode(overrides: Partial<WorkspaceTreeNode> = {}): WorkspaceTreeNode {
  return {
    type: 'file',
    path: 'notes/a.md',
    name: 'a.md',
    title: 'a',
    format: 'markdown',
    parentPath: 'notes',
    children: [],
    ...overrides,
  }
}

function makeProps(overrides: Record<string, any> = {}) {
  return {
    nodes: [],
    activePath: '',
    onOpen: vi.fn(),
    expandedPaths: new Set<string>(),
    modifiedPaths: new Set<string>(),
    icons: {},
    moveTargets: [],
    onToggleFolder: vi.fn(),
    onCreateInside: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onRename: vi.fn(),
    onMoveToFolder: vi.fn(),
    onSetIcon: vi.fn(),
    onDropNode: vi.fn(),
    ...overrides,
  }
}

function findRow(name: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll('.document-tree-row')) as HTMLElement[]
  const match = rows.find((row) => row.textContent?.includes(name))
  if (!match) {
    throw new Error(`Could not find row with text "${name}"`)
  }
  return match
}

describe('WorkspaceTree click behavior', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('clicking an inactive file calls onOpen, not startRename', async () => {
    const node = makeFileNode({ path: 'notes/a.md', name: 'a.md' })
    const onOpen = vi.fn()
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [node],
        activePath: 'notes/other.md',
        onOpen,
      })),
    )

    const row = findRow('a.md')
    await act(async () => {
      row.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('notes/a.md')
    expect(container.querySelector('input.document-tree-rename-input')).toBeNull()
  })

  it('clicking the active editable markdown file does NOT enter rename mode (rename only via context menu)', async () => {
    const node = makeFileNode({ path: 'notes/a.md', name: 'a.md', title: 'a', format: 'markdown' })
    const onOpen = vi.fn()
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [node],
        activePath: 'notes/a.md',
        onOpen,
      })),
    )

    const row = findRow('a.md')
    await act(async () => {
      row.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('notes/a.md')
    expect(container.querySelector('input.document-tree-rename-input')).toBeNull()
  })

  it('clicking an active virtual file does NOT enter rename mode (onOpen called instead)', async () => {
    const node = makeFileNode({ path: 'notes/a.md', name: 'a.md', format: 'markdown', virtual: true })
    const onOpen = vi.fn()
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [node],
        activePath: 'notes/a.md',
        onOpen,
      })),
    )

    const row = findRow('a.md')
    await act(async () => {
      row.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('notes/a.md')
    expect(container.querySelector('input.document-tree-rename-input')).toBeNull()
  })

  it('clicking an active non-editable file (pdf) does NOT enter rename mode', async () => {
    const node = makeFileNode({ path: 'notes/doc.pdf', name: 'doc.pdf', title: 'doc', format: 'pdf' })
    const onOpen = vi.fn()
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [node],
        activePath: 'notes/doc.pdf',
        onOpen,
      })),
    )

    const row = findRow('doc.pdf')
    await act(async () => {
      row.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('notes/doc.pdf')
    expect(container.querySelector('input.document-tree-rename-input')).toBeNull()
  })

  it('clicking an active file with undefined format does NOT enter rename mode (onOpen called instead)', async () => {
    const node = makeFileNode({ path: 'notes/unknown', name: 'unknown', title: 'unknown', format: undefined })
    const onOpen = vi.fn()
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [node],
        activePath: 'notes/unknown',
        onOpen,
      })),
    )

    const row = findRow('unknown')
    await act(async () => {
      row.click()
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('notes/unknown')
    expect(container.querySelector('input.document-tree-rename-input')).toBeNull()
  })
})

describe('WorkspaceTree drag feedback', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('marks only the dragged row with is-dragging so the source is visually lifted', async () => {
    const dragged = makeFileNode({ path: 'notes/a.md', name: 'a.md', parentPath: 'notes' })
    const other = makeFileNode({ path: 'notes/b.md', name: 'b.md', title: 'b', parentPath: 'notes' })
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [dragged, other],
        draggingPath: 'notes/a.md',
        // Supplying drag callbacks makes this instance a controlled subtree that
        // reads draggingPath from props rather than local state.
        onDragNodeStart: vi.fn(),
        onDragNodeOver: vi.fn(),
        onDragNodeEnd: vi.fn(),
      })),
    )

    expect(findRow('a.md').classList.contains('is-dragging')).toBe(true)
    expect(findRow('b.md').classList.contains('is-dragging')).toBe(false)
  })

  it('opens an insertion slot at the drop position so the target gap is visible', async () => {
    const dragged = makeFileNode({ path: 'notes/a.md', name: 'a.md', parentPath: 'notes' })
    const other = makeFileNode({ path: 'notes/b.md', name: 'b.md', title: 'b', parentPath: 'notes' })
    await mount(
      createElement(WorkspaceTree, makeProps({
        nodes: [dragged, other],
        draggingPath: 'notes/a.md',
        dropIndicator: { path: 'notes/b.md', position: 'before' },
        onDragNodeStart: vi.fn(),
        onDragNodeOver: vi.fn(),
        onDragNodeEnd: vi.fn(),
      })),
    )

    const slots = container.querySelectorAll('.document-tree-drop-slot')
    expect(slots.length).toBe(1)
    const bWrap = findRow('b.md').closest('.document-tree-row-wrap')!
    // The slot renders as the first child of b.md's wrap (a 'before' gap).
    expect(bWrap.firstElementChild?.classList.contains('document-tree-drop-slot')).toBe(true)
  })
})
