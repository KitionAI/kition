import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KitableChildrenIndex } from './useKitableChildrenIndex'
import { useWorkspaceKitableOpeners } from './useWorkspaceKitableOpeners'
import type { WorkspaceTab } from '../lib/workspace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Index = Pick<KitableChildrenIndex, 'tablesByKitablePath' | 'status' | 'refresh'>

let container: HTMLDivElement
let root: Root | null = null
let openers: ReturnType<typeof useWorkspaceKitableOpeners> | null = null
const tabs: WorkspaceTab[] = []

function Harness({ index }: { index: Index }) {
  // A fresh callback each render, as WorkspaceScreen's are: every render re-runs the pending open.
  openers = useWorkspaceKitableOpeners({
    activeWorkspaceTab: undefined,
    kitableChildrenIndex: index,
    upsertWorkspaceTab: (tab) => void tabs.push(tab),
    setActiveResourcePath: () => undefined,
    workflowOpen: false,
  })
  return null
}

function render(index: Index) {
  return act(async () => root!.render(createElement(Harness, { index })))
}

const TABLES = { 'Shared/Tasks.kitable': [{ id: 11, title: 'Tasks', order: 0, primaryFieldId: 101 }] }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  tabs.length = 0
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceKitableOpeners', () => {
  it('opens a table file the index does not list yet on its table once the refresh it asked for is done', async () => {
    let finish!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await render({ status: 'done', tablesByKitablePath: {}, refresh })

    await act(async () => openers!.openKitableContainer('Shared/Tasks.kitable'))
    expect(refresh).toHaveBeenCalledTimes(1)
    // Renders before the refresh lands still show the old index: nothing opens yet.
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    expect(tabs).toEqual([])

    await render({ status: 'done', tablesByKitablePath: TABLES, refresh })
    await act(async () => finish())
    expect(tabs.map((tab) => tab.type)).toContain('table')
    expect(tabs.map((tab) => tab.type)).not.toContain('workflow')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting when a caller holding the callback from before the refresh opens the file again', async () => {
    let finish!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    // An effect that captured this callback (a "show this file" listener) calls it twice.
    const stale = openers!.openKitableContainer
    await act(async () => stale('Shared/Tasks.kitable'))
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    await act(async () => stale('Shared/Tasks.kitable'))
    expect(tabs).toEqual([])

    await render({ status: 'done', tablesByKitablePath: TABLES, refresh })
    await act(async () => finish())
    expect(tabs.map((tab) => tab.type)).toEqual(['table'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('opens the workflow view of a table file that still has no tables after the refresh', async () => {
    const refresh = vi.fn(async () => undefined)
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    await act(async () => openers!.openKitableContainer('Empty.kitable'))
    await render({ status: 'done', tablesByKitablePath: {}, refresh })
    expect(tabs.map((tab) => tab.type)).toEqual(['workflow'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
