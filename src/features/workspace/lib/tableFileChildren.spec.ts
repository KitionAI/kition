import { describe, expect, it } from 'vitest'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { expandedTableFiles, parseTableFileChildPath, tableFileChildPath, withTableFileChildren } from './tableFileChildren'

function file(path: string, children: WorkspaceTreeNode[] = [], folderPath?: string): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  return { type: 'file', path, filePath: path, folderPath, name, title: name.replace(/\.\w+$/, ''), parentPath: '', children }
}

const leads = { path: 'crm/Leads.ktable', documentId: null, tables: [{ id: '1', name: 'leads', title: 'Leads', meta: {}, fields: [] }, { id: '2', name: 'people', title: '', meta: {}, fields: [] }], dashboards: [{ id: 'overview', name: 'Overview' }] }

describe('a table file’s children in the tree', () => {
  it('names a table or dashboard by a path that opens the file at it', () => {
    const path = tableFileChildPath('crm/Leads.ktable', 'dashboards', 'over/view')
    expect(parseTableFileChildPath(path)).toEqual({ filePath: 'crm/Leads.ktable', kind: 'dashboards', view: { path: 'dashboards/over/view' } })
    expect(parseTableFileChildPath(tableFileChildPath('Leads.ktable', 'tables', '3'))).toEqual({ filePath: 'Leads.ktable', kind: 'tables', view: { path: 'tables/3' } })
    expect(parseTableFileChildPath('ktable-view://records/1/Leads.ktable')).toBeNull()
    expect(parseTableFileChildPath('ktable-view://tables/1/notes.md')).toBeNull()
    expect(parseTableFileChildPath('workflows://Leads.ktable')).toBeNull()
  })

  it('lists the expanded table files, under the key their rows expand by', () => {
    const nodes = [file('Leads.ktable'), file('Plan.ktable', [], 'Plan'), { ...file('crm'), type: 'folder' as const, children: [file('crm/Deals.ktable'), file('crm/notes.md')] }]
    expect(expandedTableFiles(nodes, new Set(['Leads.ktable', 'Plan', 'crm/Deals.ktable', 'crm/notes.md']))).toEqual(['Leads.ktable', 'Plan.ktable', 'crm/Deals.ktable'])
    expect(expandedTableFiles(nodes, new Set(['Plan.ktable']))).toEqual([])
  })

  it('puts the tables, then the dashboards, before the file’s own child pages', () => {
    const page = file('crm/Leads/Notes.md')
    const nodes = [{ ...file('crm'), type: 'folder' as const, children: [file('crm/Leads.ktable', [page], 'crm/Leads'), file('crm/Other.ktable')] }]
    const [crm] = withTableFileChildren(nodes, { 'crm/Leads.ktable': leads })
    const [withChildren, other] = crm.children
    expect(withChildren.children.map((child) => [child.title, child.virtual, child.path])).toEqual([
      ['Leads', true, 'ktable-view://tables/1/crm/Leads.ktable'],
      ['people', true, 'ktable-view://tables/2/crm/Leads.ktable'],
      ['Overview', true, 'ktable-view://dashboards/overview/crm/Leads.ktable'],
      ['Notes', undefined, 'crm/Leads/Notes.md'],
    ])
    expect(other.children).toEqual([])
    expect(withTableFileChildren(nodes, {})).toBe(nodes)
  })
})
