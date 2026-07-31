import { describe, expect, it } from 'vitest'

import {
  KITABLE_WORKFLOWS_PREFIX,
  KITABLE_WORKFLOW_PREFIX,
  KITABLE_DASHBOARD_PREFIX,
  KITABLE_TABLE_PREFIX,
  buildKitableDashboardVirtualPath,
  buildKitableWorkflowsVirtualPath,
  buildKitableWorkflowVirtualPath,
  buildKitableTableVirtualPath,
  buildPrivateSectionTreeNodes,
  insertWorkspaceTreeDocumentItem,
  parseKitableWorkflowsVirtualPath,
  parseKitableDashboardVirtualPath,
  parseKitableWorkflowVirtualPath,
  parseKitableTableVirtualPath,
} from './workspaceTree'
import type { KitableDashboardSummary, KitableWorkflowSummary, KitableTableSummary } from './workspaceTree'
import type { WorkspaceDocumentTreeItem, WorkspaceDocumentFormat } from '@/services/desktop'
import type { WorkspaceTreeMetadata } from './workspacePersistence'

const emptyMetadata: WorkspaceTreeMetadata = { order: {}, icons: {}, collapsed: [] }

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

describe('buildPrivateSectionTreeNodes kitable Workflows entry point', () => {
  it('does not synthesize a virtual Workflows child node on .kitable files', () => {
    // Keeps the kitable subtree compact — the Workflows home tab is
    // reached from the sidebar header lightning-bolt icon, not from the
    // tree.
    const nodes = buildPrivateSectionTreeNodes([file('Leads.kitable')], emptyMetadata)
    const leads = nodes.find((n) => n.name === 'Leads.kitable')
    expect(leads, 'kitable node should exist').toBeTruthy()
    expect(leads!.children).toHaveLength(0)
  })

  it('preserves existing sibling-folder children as the only kitable children', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [
        file('Leads.kitable'),
        {
          type: 'folder',
          path: 'Leads',
          name: 'Leads',
          children: [file('Leads/Records.md', 'Records.md')],
        } as WorkspaceDocumentTreeItem,
      ],
      emptyMetadata,
    )
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children.map((c) => c.name)).toEqual(['Records.md'])
  })

  it('does not append the virtual child to non-kitable files', () => {
    const nodes = buildPrivateSectionTreeNodes([file('plain.md')], emptyMetadata)
    expect(nodes[0].children).toHaveLength(0)
  })
})

describe('parseKitableWorkflowsVirtualPath', () => {
  it('round-trips with buildKitableWorkflowsVirtualPath', () => {
    const path = buildKitableWorkflowsVirtualPath('Leads.kitable')
    expect(parseKitableWorkflowsVirtualPath(path)).toBe('Leads.kitable')
  })

  it('returns null for non-virtual paths', () => {
    expect(parseKitableWorkflowsVirtualPath('Leads.kitable')).toBeNull()
  })

  it('exports a stable prefix constant for the tree builder + onOpen handler to share', () => {
    expect(KITABLE_WORKFLOWS_PREFIX).toBe('workflows://')
  })
})

describe('parseKitableTableVirtualPath', () => {
  it('round-trips with buildKitableTableVirtualPath', () => {
    const path = buildKitableTableVirtualPath('Leads.kitable', 42)
    expect(path).toBe('table://Leads.kitable#42')
    expect(parseKitableTableVirtualPath(path)).toEqual({
      kitablePath: 'Leads.kitable',
      tableId: 42,
    })
  })

  it('returns null for non-virtual paths', () => {
    expect(parseKitableTableVirtualPath('Leads.kitable')).toBeNull()
  })

  it('returns null when the tableId fragment is missing', () => {
    expect(parseKitableTableVirtualPath('table://Leads.kitable')).toBeNull()
  })

  it('returns null when the tableId fragment is not a positive integer', () => {
    expect(parseKitableTableVirtualPath('table://Leads.kitable#0')).toBeNull()
    expect(parseKitableTableVirtualPath('table://Leads.kitable#-3')).toBeNull()
    expect(parseKitableTableVirtualPath('table://Leads.kitable#abc')).toBeNull()
    expect(parseKitableTableVirtualPath('table://Leads.kitable#1.5')).toBeNull()
  })

  it('exports a stable prefix constant for the tree builder + onOpen handler to share', () => {
    expect(KITABLE_TABLE_PREFIX).toBe('table://')
  })
})

describe('kitable dashboard virtual nodes', () => {
  const dashboards: KitableDashboardSummary[] = [
    { id: 'task-dashboard', title: 'Task Dashboard', order: 0 },
  ]

  it('round-trips dashboard virtual paths', () => {
    const path = buildKitableDashboardVirtualPath('Tasks.kitable', 'task-dashboard')
    expect(path).toBe('dashboard://Tasks.kitable#task-dashboard')
    expect(parseKitableDashboardVirtualPath(path)).toEqual({
      kitablePath: 'Tasks.kitable',
      dashboardId: 'task-dashboard',
    })
    expect(KITABLE_DASHBOARD_PREFIX).toBe('dashboard://')
  })

  it('places dashboards after tables in a kitable tree', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [file('Tasks.kitable')],
      emptyMetadata,
      { 'Tasks.kitable': [{ id: 7, title: 'Tasks', order: 0, primaryFieldId: null }] },
      { 'Tasks.kitable': dashboards },
    )
    expect(nodes[0].children.map((child) => child.title)).toEqual(['Tasks', 'Task Dashboard'])
    expect(nodes[0].children[1].path).toBe('dashboard://Tasks.kitable#task-dashboard')
  })
})

describe('buildPrivateSectionTreeNodes kitable table virtual nodes', () => {
  const leadsTables: KitableTableSummary[] = [
    { id: 7, title: 'Leads', order: 10, primaryFieldId: null },
    { id: 8, title: 'Companies', order: 20, primaryFieldId: null },
  ]

  it('emits one virtual file node per table, ordered by table.order', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [file('Leads.kitable')],
      emptyMetadata,
      { 'Leads.kitable': leadsTables },
    )
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children.map((c) => c.name)).toEqual(['Leads', 'Companies'])
    expect(leads.children[0].virtual).toBe(true)
    expect(leads.children[0].path).toBe(buildKitableTableVirtualPath('Leads.kitable', 7))
    expect(leads.children[0].format).toBe('data')
    expect(leads.children[1].path).toBe(buildKitableTableVirtualPath('Leads.kitable', 8))
  })

  it('sorts tables by order ascending even if input is shuffled', () => {
    const shuffled: KitableTableSummary[] = [
      { id: 8, title: 'B', order: 20, primaryFieldId: null },
      { id: 7, title: 'A', order: 10, primaryFieldId: null },
    ]
    const nodes = buildPrivateSectionTreeNodes(
      [file('K.kitable')],
      emptyMetadata,
      { 'K.kitable': shuffled },
    )
    expect(nodes[0].children.map((c) => c.name)).toEqual(['A', 'B'])
  })

  it('falls back to no children when the index has no entry yet', () => {
    const nodes = buildPrivateSectionTreeNodes([file('Leads.kitable')], emptyMetadata, {})
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children).toHaveLength(0)
  })

  it('preserves real sibling-folder children between the table rows', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [
        file('Leads.kitable'),
        {
          type: 'folder',
          path: 'Leads',
          name: 'Leads',
          children: [file('Leads/Records.md', 'Records.md')],
        } as WorkspaceDocumentTreeItem,
      ],
      emptyMetadata,
      { 'Leads.kitable': leadsTables },
    )
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children.map((c) => c.name)).toEqual(['Leads', 'Companies', 'Records.md'])
  })

  it('keeps children empty when no third arg is passed (backward compat)', () => {
    const nodes = buildPrivateSectionTreeNodes([file('Leads.kitable')], emptyMetadata)
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children).toHaveLength(0)
  })
})

describe('parseKitableWorkflowVirtualPath', () => {
  it('round-trips with buildKitableWorkflowVirtualPath', () => {
    const path = buildKitableWorkflowVirtualPath('Leads.kitable', 'auto_abc')
    expect(path).toBe('workflow://Leads.kitable#auto_abc')
    expect(parseKitableWorkflowVirtualPath(path)).toEqual({
      kitablePath: 'Leads.kitable',
      workflowId: 'auto_abc',
    })
  })

  it('returns null for non-virtual paths', () => {
    expect(parseKitableWorkflowVirtualPath('Leads.kitable')).toBeNull()
  })

  it('returns null when the workflow id fragment is missing', () => {
    expect(parseKitableWorkflowVirtualPath('workflow://Leads.kitable')).toBeNull()
  })

  it('exports a stable prefix constant', () => {
    expect(KITABLE_WORKFLOW_PREFIX).toBe('workflow://')
  })
})

describe('buildPrivateSectionTreeNodes kitable workflow virtual children', () => {
  const leadsWorkflows: KitableWorkflowSummary[] = [
    { id: 'auto_b', name: 'Welcome email', enabled: true },
    { id: 'auto_a', name: 'Lead alert', enabled: false },
  ]

  it('appends one virtual workflow node per kitable workflow, sorted by name', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [file('Leads.kitable')],
      emptyMetadata,
      {},
      {},
      { 'Leads.kitable': leadsWorkflows },
    )
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children.map((c) => c.name)).toEqual([
      'Lead alert',
      'Welcome email',
    ])
    expect(leads.children[0].virtual).toBe(true)
    expect(leads.children[0].path).toBe(buildKitableWorkflowVirtualPath('Leads.kitable', 'auto_a'))
    expect(leads.children[1].path).toBe(buildKitableWorkflowVirtualPath('Leads.kitable', 'auto_b'))
  })

  it('does not hang workflow children on non-kitable files', () => {
    const nodes = buildPrivateSectionTreeNodes(
      [file('plain.md')],
      emptyMetadata,
      {},
      {},
      { 'plain.md': leadsWorkflows },
    )
    expect(nodes[0].children).toHaveLength(0)
  })

  it('interleaves tables, existing children, and per-workflow leaves in the expected order', () => {
    const tables: KitableTableSummary[] = [
      { id: 7, title: 'Leads', order: 10, primaryFieldId: null },
    ]
    const nodes = buildPrivateSectionTreeNodes(
      [
        file('Leads.kitable'),
        {
          type: 'folder',
          path: 'Leads',
          name: 'Leads',
          children: [file('Leads/Records.md', 'Records.md')],
        } as WorkspaceDocumentTreeItem,
      ],
      emptyMetadata,
      { 'Leads.kitable': tables },
      {},
      { 'Leads.kitable': leadsWorkflows },
    )
    const leads = nodes.find((n) => n.name === 'Leads.kitable')!
    expect(leads.children.map((c) => c.name)).toEqual([
      'Leads',
      'Records.md',
      'Lead alert',
      'Welcome email',
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
