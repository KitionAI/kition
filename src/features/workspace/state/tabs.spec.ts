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

const doc = (path: string, extra: Partial<Extract<WorkspaceTab, { type: 'document' }>> = {}): WorkspaceTab =>
  ({ id: `document:${path}`, type: 'document', title: path, path, ...extra })
const board = (path: string): WorkspaceTab => ({ id: `board:${path}`, type: 'board', title: path, path })
const table = (kitablePath: string, tableId: number): WorkspaceTab =>
  ({ id: `table:${kitablePath}#${tableId}`, type: 'table', title: 'T', kitablePath, tableId, format: 'data' })
const workflow = (kitablePath: string, workflowId?: string): WorkspaceTab =>
  ({ id: `workflow:${kitablePath}${workflowId ? `:${workflowId}` : ''}`, type: 'workflow', title: 'W', kitablePath, workflowId })

const state = (tabs: WorkspaceTab[], activeTabId = tabs[0]?.id ?? ''): TabsState => ({ tabs, activeTabId })
const ids = (s: TabsState) => s.tabs.map((tab) => tab.id)

describe('upsertTab', () => {
  it('appends and activates a new tab by default', () => {
    const next = upsertTab(state([doc('a.md')]), doc('b.md'))
    expect(ids(next)).toEqual(['document:a.md', 'document:b.md'])
    expect(next.activeTabId).toBe('document:b.md')
  })

  it('can add without activating and insert after the active tab', () => {
    const next = upsertTab(state([doc('a.md'), doc('c.md')], 'document:a.md'), doc('b.md'), {
      activate: false,
      insertAfterActive: true,
    })
    expect(ids(next)).toEqual(['document:a.md', 'document:b.md', 'document:c.md'])
    expect(next.activeTabId).toBe('document:a.md')
  })

  it('replaces an existing tab in place and keeps a document uid the update lacks', () => {
    const next = upsertTab(state([doc('a.md', { uid: 'u1' }), doc('b.md')]), doc('a.md', { title: 'A!' }))
    expect(next.tabs[0]).toMatchObject({ title: 'A!', uid: 'u1' })
    expect(ids(next)).toEqual(['document:a.md', 'document:b.md'])
  })

  it('keeps one logical tab per .kitable file across table, workflow, and file views', () => {
    const start = state([doc('x.md'), table('Leads.kitable', 1)])
    const next = upsertTab(start, workflow('Leads.kitable', 'wf_1'))
    expect(ids(next)).toEqual(['document:x.md', 'workflow:Leads.kitable:wf_1'])
    const again = upsertTab(next, doc('Leads.kitable'))
    expect(ids(again)).toEqual(['document:x.md', 'document:Leads.kitable'])
  })
})

describe('updateTab', () => {
  it('returns the same state when the tab does not exist', () => {
    const start = state([doc('a.md')])
    expect(updateTab(start, 'missing', (tab) => ({ ...tab, title: 'x' }))).toBe(start)
    expect(updateTab(start, 'document:a.md', (tab) => ({ ...tab, title: 'x' })).tabs[0].title).toBe('x')
  })
})

describe('closeTab', () => {
  const start = state([doc('a.md'), doc('b.md'), doc('c.md')], 'document:b.md')

  it('activates the previous tab when the active one closes', () => {
    const { state: next, closed } = closeTab(start, 'document:b.md')
    expect(closed?.id).toBe('document:b.md')
    expect(ids(next)).toEqual(['document:a.md', 'document:c.md'])
    expect(next.activeTabId).toBe('document:a.md')
  })

  it('falls back to the first tab when the first tab was active, and keeps the active id otherwise', () => {
    expect(closeTab(state(start.tabs, 'document:a.md'), 'document:a.md').state.activeTabId).toBe('document:b.md')
    expect(closeTab(start, 'document:c.md').state.activeTabId).toBe('document:b.md')
    expect(closeTab(start, 'missing')).toEqual({ state: start, closed: null })
  })

  it('leaves no active tab when the last one closes', () => {
    expect(closeTab(state([doc('a.md')]), 'document:a.md').state).toEqual(EMPTY_TABS_STATE)
  })
})

describe('filterTabs', () => {
  it('picks a neighbour when the active tab is filtered out', () => {
    const start = state([doc('a.md'), doc('b.md'), doc('c.md')], 'document:c.md')
    const next = filterTabs(start, (tab) => tab.id !== 'document:c.md')
    expect(ids(next)).toEqual(['document:a.md', 'document:b.md'])
    expect(next.activeTabId).toBe('document:b.md')
    expect(filterTabs(start, () => true)).toBe(start)
  })
})

describe('remapTabPaths', () => {
  it('moves document, board, and browser-origin tabs under the renamed folder', () => {
    const browser: WorkspaceTab = {
      id: 'browser:1', type: 'browser', title: 'Web', provider: 'generic' as never,
      originDocumentPath: 'old/a.md', originTabId: 'document:old/a.md',
    }
    const start = state([doc('old/a.md'), board('old/b.kiboard'), doc('other/c.md'), browser], 'board:old/b.kiboard')
    const next = remapTabPaths(start, 'old', 'new')
    expect(ids(next)).toEqual(['document:new/a.md', 'board:new/b.kiboard', 'document:other/c.md', 'browser:1'])
    expect(next.tabs[1]).toMatchObject({ path: 'new/b.kiboard', title: 'b' })
    expect(next.tabs[3]).toMatchObject({ originDocumentPath: 'new/a.md', originTabId: 'document:new/a.md' })
    expect(next.activeTabId).toBe('board:new/b.kiboard')
    expect(remapTabPaths(start, 'x', 'x')).toBe(start)
  })
})

describe('renameTabPath', () => {
  it('collapses every view of a renamed .kitable onto its new file-level tab', () => {
    const start = state([table('Leads.kitable', 1), workflow('Leads.kitable', 'wf'), doc('n.md')], 'table:Leads.kitable#1')
    const next = renameTabPath(start, 'Leads.kitable', 'Customers.kitable')
    expect(ids(next)).toEqual(['kitable:Customers.kitable', 'document:n.md'])
    expect(next.tabs[0]).toMatchObject({ kitablePath: 'Customers.kitable', title: 'Customers' })
    expect(next.activeTabId).toBe('kitable:Customers.kitable')
  })

  it('renames an open document tab and leaves unrelated tabs alone', () => {
    const start = state([doc('a.md'), doc('b.md')], 'document:a.md')
    const next = renameTabPath(start, 'a.md', 'z.md')
    expect(ids(next)).toEqual(['document:z.md', 'document:b.md'])
    expect(next.activeTabId).toBe('document:z.md')
    expect(renameTabPath(start, 'nope.md', 'x.md')).toBe(start)
  })
})

describe('switchWorkspaceTabs', () => {
  it('drops the old workspace tabs but keeps tabs added in the same batch as the root change', () => {
    const committed = state([doc('old/a.md')])
    const current = state([doc('old/a.md'), doc('new/home.md')], 'document:new/home.md')
    const next = switchWorkspaceTabs(current, [doc('new/stored.md')], committed)
    expect(ids(next)).toEqual(['document:new/stored.md', 'document:new/home.md'])
    expect(next.activeTabId).toBe('document:new/home.md')
  })

  it('selects the first stored tab when the active id still points at the old workspace', () => {
    const committed = state([doc('old/a.md')])
    const next = switchWorkspaceTabs(committed, [doc('new/stored.md')], committed)
    expect(ids(next)).toEqual(['document:new/stored.md'])
    expect(next.activeTabId).toBe('document:new/stored.md')
  })
})

describe('bindInitialWorkspaceTabs', () => {
  it('merges stored tabs behind tabs opened before the root resolved', () => {
    const current = state([doc('home.md')])
    const next = bindInitialWorkspaceTabs(current, [doc('home.md'), doc('notes.md')])
    expect(ids(next)).toEqual(['document:notes.md', 'document:home.md'])
    expect(next.activeTabId).toBe('document:home.md')
    expect(bindInitialWorkspaceTabs(EMPTY_TABS_STATE, [doc('x.md')])).toEqual(state([doc('x.md')]))
  })
})
