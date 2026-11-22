import { describe, expect, it } from 'vitest'
import type { KitsOutlineItem } from '@/api/kits'
import { kitExtensions, kitEditingExtension } from '@/lib/kitCatalog'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { expandedOutlineFiles, kitPartPath, parseKitPartPath, withOutlineChildren } from './kitOutlineChildren'

function file(path: string, children: WorkspaceTreeNode[] = [], folderPath?: string): WorkspaceTreeNode {
  const name = path.split('/').pop()!
  return { type: 'file', path, filePath: path, folderPath, name, title: name.replace(/\.\w+$/, ''), parentPath: '', children }
}

// An extension of a kit whose manifest names an outline command, and one of a kit without one
// (the manifests the test setup installs): the test names no kit.
const outlined = kitExtensions().find((extension) => kitEditingExtension(extension)?.outline)
const plain = kitExtensions().find((extension) => kitEditingExtension(extension) && !kitEditingExtension(extension)?.outline)

const parts: KitsOutlineItem[] = [
  { id: '1', title: 'Leads', kind: 'table', view: { path: 'tables/1' } },
  { id: 'over/view', title: 'Overview', kind: 'dashboard', view: { path: 'dashboards/over/view' } },
]

describe('a file’s outline in the tree', () => {
  it('has a kit with an outline and a kit without one to test with', () => {
    expect(outlined, 'a shipped kit declares an outline').toBeTruthy()
    expect(plain, 'a shipped kit declares none').toBeTruthy()
  })

  it('names a part by a path that opens the file at the view its kit gave', () => {
    const path = kitPartPath(`crm/Leads.${outlined}`, parts[1])
    expect(parseKitPartPath(path)).toEqual({ filePath: `crm/Leads.${outlined}`, id: 'over/view', view: { path: 'dashboards/over/view' } })
    expect(parseKitPartPath(kitPartPath('Deck.any', { id: '3', view: { slide: 3 } }))).toEqual({ filePath: 'Deck.any', id: '3', view: { slide: 3 } })
    expect(parseKitPartPath('crm/Leads.md')).toBeNull()
    expect(parseKitPartPath('kit-part://1/not-json/Leads.any')).toBeNull()
    expect(parseKitPartPath(`kit-part://1/${encodeURIComponent('"tables/1"')}/Leads.any`)).toBeNull()
    expect(parseKitPartPath('kit-part://1/')).toBeNull()
  })

  it('lists the expanded files whose kit has an outline, under the key their rows expand by', () => {
    const nodes = [
      file(`Leads.${outlined}`),
      file(`Plan.${outlined}`, [], 'Plan'),
      { ...file('crm'), type: 'folder' as const, children: [file(`crm/Deals.${outlined}`), file(`crm/Other.${plain}`), file('crm/archive.zip')] },
    ]
    const expanded = new Set([`Leads.${outlined}`, 'Plan', `crm/Deals.${outlined}`, `crm/Other.${plain}`, 'crm/archive.zip'])
    expect(expandedOutlineFiles(nodes, expanded)).toEqual([`Leads.${outlined}`, `Plan.${outlined}`, `crm/Deals.${outlined}`])
    expect(expandedOutlineFiles(nodes, new Set([`Plan.${outlined}`]))).toEqual([])
  })

  it('puts the parts, in the kit’s order, before the file’s own child pages', () => {
    const leads = `crm/Leads.${outlined}`
    const page = file('crm/Leads/Notes.md')
    const nodes = [{ ...file('crm'), type: 'folder' as const, children: [file(leads, [page], 'crm/Leads'), file(`crm/Other.${outlined}`)] }]
    const [crm] = withOutlineChildren(nodes, { [leads]: parts })
    const [withChildren, other] = crm.children
    expect(withChildren.children.map((child) => [child.title, child.virtual, child.path])).toEqual([
      ['Leads', true, kitPartPath(leads, parts[0])],
      ['Overview', true, kitPartPath(leads, parts[1])],
      ['Notes', undefined, 'crm/Leads/Notes.md'],
    ])
    expect(withChildren.children.slice(0, 2).map((child) => parseKitPartPath(child.path)?.view)).toEqual([{ path: 'tables/1' }, { path: 'dashboards/over/view' }])
    expect(other.children).toEqual([])
    expect(withOutlineChildren(nodes, {})).toBe(nodes)
  })
})
