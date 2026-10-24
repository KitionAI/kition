import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceTabs } from './useWorkspaceTabs'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', () => ({}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  vi.restoreAllMocks()
})

type HookResult = ReturnType<typeof useWorkspaceTabs>

type Harness = {
  ref: { current: HookResult }
  setRootPath: (next: string) => Promise<void>
  setRootPathSync: (next: string) => void
}

async function mountHarness(initialRootPath: string): Promise<Harness> {
  const ref: { current: HookResult } = {
    current: undefined as unknown as HookResult,
  }
  let setExternalRoot: ((next: string) => void) | null = null

  function Wrapper() {
    const [rootPath, setRootPath] = useState(initialRootPath)
    setExternalRoot = setRootPath
    const hook = useWorkspaceTabs({
      rootPath,
      onActivateGallery: () => {},
    })
    useEffect(() => {
      ref.current = hook
    })
    ref.current = hook
    return null
  }

  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Wrapper))
    await Promise.resolve()
  })

  return {
    ref,
    setRootPath: async (next: string) => {
      await act(async () => {
        setExternalRoot?.(next)
        await Promise.resolve()
      })
    },
    setRootPathSync: (next: string) => {
      setExternalRoot?.(next)
    },
  }
}

/** A design tab: the tabs a workspace keeps across windows (a kit's file tab reopens from the tree). */
function docTab(path: string): WorkspaceTab {
  const design = path.replace(/\.md$/, '.kidesign')
  return {
    id: `design:${design}`,
    type: 'design',
    title: design.split('/').pop() || design,
    path: design,
  }
}

describe('useWorkspaceTabs — atomic workspace switch', () => {
  it('wipes prior workspace tabs and reads target storage when rootPath changes between two real workspaces', async () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v2',
      JSON.stringify({
        '/B': [docTab('B-home.md'), docTab('B-notes.md')],
      }),
    )

    const { ref, setRootPath } = await mountHarness('/A')

    await act(async () => {
      ref.current.upsertWorkspaceTab(docTab('A-home.md'), { activate: true })
      await Promise.resolve()
    })
    expect(ref.current.workspaceTabs.map((t) => t.id)).toEqual(['design:A-home.kidesign'])
    expect(ref.current.activeWorkspaceTabId).toBe('design:A-home.kidesign')

    await setRootPath('/B')

    expect(ref.current.workspaceTabs.map((t) => t.id)).toEqual([
      'design:B-home.kidesign',
      'design:B-notes.kidesign',
    ])
    expect(ref.current.activeWorkspaceTabId).toBe('design:B-home.kidesign')
  })

  it('remaps durable Design paths and keeps a valid active tab after deletion', async () => {
    const { ref } = await mountHarness('/A')

    await act(async () => {
      ref.current.upsertWorkspaceTab({ id: 'file-viewer:Home.md', type: 'file-viewer', title: 'Home', path: 'Home.md', format: 'markdown' }, { activate: false })
      ref.current.upsertWorkspaceTab({
        id: 'design:Planning.kidesign',
        type: 'design',
        title: 'Planning',
        path: 'Planning.kidesign',
      }, { activate: true })
      await Promise.resolve()
    })

    await act(async () => {
      ref.current.remapWorkspaceTabPaths('Planning.kidesign', 'Roadmap.kidesign')
      await Promise.resolve()
    })
    expect(ref.current.workspaceTabs[1]).toEqual({
      id: 'design:Roadmap.kidesign',
      type: 'design',
      title: 'Roadmap',
      path: 'Roadmap.kidesign',
    })
    expect(ref.current.activeWorkspaceTabId).toBe('design:Roadmap.kidesign')

    await act(async () => {
      ref.current.filterWorkspaceTabs((tab) => tab.type !== 'design')
      await Promise.resolve()
    })
    expect(ref.current.workspaceTabs.map((tab) => tab.id)).toEqual(['file-viewer:Home.md'])
    expect(ref.current.activeWorkspaceTabId).toBe('file-viewer:Home.md')
  })

  it('does NOT clobber tabs already added during the empty → real first binding', async () => {
    const { ref, setRootPath } = await mountHarness('')

    expect(ref.current.workspaceTabs).toEqual([])

    await act(async () => {
      ref.current.upsertWorkspaceTab(docTab('A-home.md'), { activate: true })
      await Promise.resolve()
    })

    await setRootPath('/A')

    expect(ref.current.workspaceTabs.map((t) => t.id)).toEqual(['design:A-home.kidesign'])
    expect(ref.current.activeWorkspaceTabId).toBe('design:A-home.kidesign')
  })

  it('persists tabs under the new rootPath only after the switch settles', async () => {
    const { ref, setRootPath } = await mountHarness('/A')

    await act(async () => {
      ref.current.upsertWorkspaceTab(docTab('A-home.md'), { activate: true })
      await Promise.resolve()
    })

    await setRootPath('/B')

    await act(async () => {
      ref.current.upsertWorkspaceTab(docTab('B-home.md'), { activate: true })
      await Promise.resolve()
    })

    const stored = JSON.parse(window.localStorage.getItem('kition.document.workspace-tabs.v2') || '{}')
    expect(stored['/A'].map((t: any) => t.id)).toEqual(['design:A-home.kidesign'])
    expect(stored['/B'].map((t: any) => t.id)).toEqual(['design:B-home.kidesign'])
  })

  it('production flow: setRootPath then async upsertWorkspaceTab in one batch', async () => {
    const { ref, setRootPathSync } = await mountHarness('/A')

    await act(async () => {
      ref.current.upsertWorkspaceTab(docTab('A-home.md'), { activate: true })
      await Promise.resolve()
    })
    expect(ref.current.workspaceTabs.map((t) => t.id)).toEqual(['design:A-home.kidesign'])

    // Emulate refreshWorkspaceDocuments() landing on the new vault. The real
    // sequence is: setRootPath(B); await readWorkspaceDocument; applyWorkspaceDocument(B-home).
    // The await is a microtask boundary that React 18 batches across — both
    // updates land in the SAME render pass.
    await act(async () => {
      setRootPathSync('/B')
      await Promise.resolve()
      ref.current.upsertWorkspaceTab(docTab('B-home.md'), { activate: true })
      await Promise.resolve()
    })

    expect(ref.current.workspaceTabs.map((t) => t.id)).toEqual(['design:B-home.kidesign'])
    expect(ref.current.activeWorkspaceTabId).toBe('design:B-home.kidesign')
  })
})
