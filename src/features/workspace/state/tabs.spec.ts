import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import {
  bindInitialWorkspaceTabs,
  closeTab,
  EMPTY_TABS_STATE,
  filterTabs,
  remapTabPaths,
  renameTabPath,
  switchWorkspaceTabs,
  updateTab,
  upsertTab,
  type TabsState,
} from './tabs'

const doc = (path: string, extra: Partial<Extract<WorkspaceTab, { type: 'file-viewer' }>> = {}): WorkspaceTab =>
  ({ id: `file-viewer:${path}`, type: 'file-viewer', title: path, path, format: 'markdown', ...extra })
const workflow = (tablePath: string, workflowId?: string): WorkspaceTab =>
  ({ id: `workflow:${tablePath}`, type: 'workflow', title: 'W', tablePath, workflowId })

const state = (tabs: WorkspaceTab[], activeTabId = tabs[0]?.id ?? ''): TabsState => ({ tabs, activeTabId })
const ids = (s: TabsState) => s.tabs.map((tab) => tab.id)

describe('upsertTab', () => {
  it('appends and activates a new tab by default', () => {
    const next = upsertTab(state([doc('a.md')]), doc('b.md'))
    expect(ids(next)).toEqual(['file-viewer:a.md', 'file-viewer:b.md'])
    expect(next.activeTabId).toBe('file-viewer:b.md')
  })

  it('can add without activating and insert after the active tab', () => {
    const next = upsertTab(state([doc('a.md'), doc('c.md')], 'file-viewer:a.md'), doc('b.md'), {
      activate: false,
      insertAfterActive: true,
    })
    expect(ids(next)).toEqual(['file-viewer:a.md', 'file-viewer:b.md', 'file-viewer:c.md'])
    expect(next.activeTabId).toBe('file-viewer:a.md')
  })

  it('replaces an existing tab in place', () => {
    const next = upsertTab(state([doc('a.md'), doc('b.md')]), doc('a.md', { title: 'A!' }))
    expect(next.tabs[0]).toMatchObject({ title: 'A!' })
    expect(ids(next)).toEqual(['file-viewer:a.md', 'file-viewer:b.md'])
  })

  it('keeps one workflow tab per table file, showing the workflow last opened', () => {
    const start = state([doc('x.md'), workflow('Leads.ktable', 'wf_1')])
    const next = upsertTab(start, workflow('Leads.ktable', 'wf_2'))
    expect(ids(next)).toEqual(['file-viewer:x.md', 'workflow:Leads.ktable'])
    expect(next.tabs[1]).toMatchObject({ workflowId: 'wf_2' })
  })

})

describe('updateTab', () => {
  it('returns the same state when the tab does not exist', () => {
    const start = state([doc('a.md')])
    expect(updateTab(start, 'missing', (tab) => ({ ...tab, title: 'x' }))).toBe(start)
    expect(updateTab(start, 'file-viewer:a.md', (tab) => ({ ...tab, title: 'x' })).tabs[0].title).toBe('x')
  })
})

describe('closeTab', () => {
  const start = state([doc('a.md'), doc('b.md'), doc('c.md')], 'file-viewer:b.md')

  it('activates the previous tab when the active one closes', () => {
    const { state: next, closed } = closeTab(start, 'file-viewer:b.md')
    expect(closed?.id).toBe('file-viewer:b.md')
    expect(ids(next)).toEqual(['file-viewer:a.md', 'file-viewer:c.md'])
    expect(next.activeTabId).toBe('file-viewer:a.md')
  })

  it('falls back to the first tab when the first tab was active, and keeps the active id otherwise', () => {
    expect(closeTab(state(start.tabs, 'file-viewer:a.md'), 'file-viewer:a.md').state.activeTabId).toBe('file-viewer:b.md')
    expect(closeTab(start, 'file-viewer:c.md').state.activeTabId).toBe('file-viewer:b.md')
    expect(closeTab(start, 'missing')).toEqual({ state: start, closed: null })
  })

  it('leaves no active tab when the last one closes', () => {
    expect(closeTab(state([doc('a.md')]), 'file-viewer:a.md').state).toEqual(EMPTY_TABS_STATE)
  })
})

describe('filterTabs', () => {
  it('picks a neighbour when the active tab is filtered out', () => {
    const start = state([doc('a.md'), doc('b.md'), doc('c.md')], 'file-viewer:c.md')
    const next = filterTabs(start, (tab) => tab.id !== 'file-viewer:c.md')
    expect(ids(next)).toEqual(['file-viewer:a.md', 'file-viewer:b.md'])
    expect(next.activeTabId).toBe('file-viewer:b.md')
    expect(filterTabs(start, () => true)).toBe(start)
  })
})

describe('remapTabPaths', () => {
  it('moves file tabs under the renamed folder', () => {
    const start = state([doc('old/a.md'), doc('old/b.kdesign', { format: 'design' }), doc('other/c.md')], 'file-viewer:old/b.kdesign')
    const next = remapTabPaths(start, 'old', 'new')
    expect(ids(next)).toEqual(['file-viewer:new/a.md', 'file-viewer:new/b.kdesign', 'file-viewer:other/c.md'])
    expect(next.tabs[1]).toMatchObject({ path: 'new/b.kdesign', title: 'b' })
    expect(next.activeTabId).toBe('file-viewer:new/b.kdesign')
    expect(remapTabPaths(start, 'x', 'x')).toBe(start)
  })
})

describe('renameTabPath', () => {
  it('moves a renamed table file\'s workflow tab with it', () => {
    const start = state([workflow('Leads.ktable', 'wf'), doc('n.md')], 'workflow:Leads.ktable')
    const next = renameTabPath(start, 'Leads.ktable', 'Customers.ktable')
    expect(ids(next)).toEqual(['workflow:Customers.ktable', 'file-viewer:n.md'])
    expect(next.tabs[0]).toMatchObject({ tablePath: 'Customers.ktable' })
    expect(next.activeTabId).toBe('workflow:Customers.ktable')
  })


  it('renames an open file tab and leaves unrelated tabs alone', () => {
    const start = state([doc('a.md'), doc('b.md')], 'file-viewer:a.md')
    const next = renameTabPath(start, 'a.md', 'z.md')
    expect(ids(next)).toEqual(['file-viewer:z.md', 'file-viewer:b.md'])
    expect(next.activeTabId).toBe('file-viewer:z.md')
    expect(renameTabPath(start, 'nope.md', 'x.md')).toBe(start)
  })
})

describe('switchWorkspaceTabs', () => {
  it('drops the old workspace tabs but keeps tabs added in the same batch as the root change', () => {
    const committed = state([doc('old/a.md')])
    const current = state([doc('old/a.md'), doc('new/home.md')], 'file-viewer:new/home.md')
    const next = switchWorkspaceTabs(current, [doc('new/stored.md')], committed)
    expect(ids(next)).toEqual(['file-viewer:new/stored.md', 'file-viewer:new/home.md'])
    expect(next.activeTabId).toBe('file-viewer:new/home.md')
  })

  it('selects the first stored tab when the active id still points at the old workspace', () => {
    const committed = state([doc('old/a.md')])
    const next = switchWorkspaceTabs(committed, [doc('new/stored.md')], committed)
    expect(ids(next)).toEqual(['file-viewer:new/stored.md'])
    expect(next.activeTabId).toBe('file-viewer:new/stored.md')
  })
})

describe('bindInitialWorkspaceTabs', () => {
  it('merges stored tabs behind tabs opened before the root resolved', () => {
    const current = state([doc('home.md')])
    const next = bindInitialWorkspaceTabs(current, [doc('home.md'), doc('notes.md')])
    expect(ids(next)).toEqual(['file-viewer:notes.md', 'file-viewer:home.md'])
    expect(next.activeTabId).toBe('file-viewer:home.md')
    expect(bindInitialWorkspaceTabs(EMPTY_TABS_STATE, [doc('x.md')])).toEqual(state([doc('x.md')]))
  })
})
