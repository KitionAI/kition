import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useWorkspaceTreeState, type UseWorkspaceTreeStateResult } from './useWorkspaceTreeState'

let container: HTMLDivElement
let root: Root | null = null
let treeState: UseWorkspaceTreeStateResult | null = null

function TreeStateProbe() {
  treeState = useWorkspaceTreeState()
  return null
}

function mountTreeState() {
  act(() => {
    root = createRoot(container)
    root.render(createElement(TreeStateProbe))
  })
  return treeState!
}

function loadTree(state: UseWorkspaceTreeStateResult) {
  act(() => {
    state.setRootPath('/Users/alice/workspace')
    state.setTreeItems([
      {
        type: 'folder',
        path: 'Articles',
        name: 'Articles',
        children: [
          {
            type: 'folder',
            path: 'Articles/Drafts',
            name: 'Drafts',
            children: [
              { type: 'file', path: 'Articles/Drafts/post.md', name: 'post.md', format: 'markdown' },
            ],
          },
        ],
      },
      { type: 'file', path: 'Data.kitable', name: 'Data.kitable', format: 'data' },
    ])
  })
}

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  treeState = null
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  treeState = null
  container.remove()
  window.localStorage.clear()
})

describe('useWorkspaceTreeState folder expansion', () => {
  it('starts every folder collapsed when a workspace is first opened', () => {
    const state = mountTreeState()
    loadTree(state)

    expect(treeState?.expandedPaths).toEqual(new Set())
  })

  it('persists only folders the user explicitly expands', () => {
    const state = mountTreeState()
    loadTree(state)

    act(() => treeState?.toggleFolder('Articles'))
    expect(treeState?.expandedPaths).toEqual(new Set(['Articles']))

    act(() => root?.unmount())
    root = null
    treeState = null

    const restored = mountTreeState()
    loadTree(restored)
    expect(treeState?.expandedPaths).toEqual(new Set(['Articles']))
  })

  it('keeps kitable files collapsed until explicitly toggled', () => {
    const state = mountTreeState()
    loadTree(state)

    expect(treeState?.expandedPaths.has('Data.kitable')).toBe(false)
    act(() => treeState?.toggleFolder('Data.kitable'))
    expect(treeState?.expandedPaths.has('Data.kitable')).toBe(true)
  })
})
