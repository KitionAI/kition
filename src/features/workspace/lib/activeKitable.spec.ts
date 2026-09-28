import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { resolveActiveKitablePath, resolveKitableSidebarMode } from './activeKitable'

const table: WorkspaceTab = { id: 't', type: 'table', title: 'T', kitablePath: 'Leads.kitable', tableId: 1, format: 'data' }
const kitableDoc: WorkspaceTab = { id: 'd', type: 'document', title: 'Leads', path: 'Leads.KITABLE' }
const note: WorkspaceTab = { id: 'n', type: 'document', title: 'Note', path: 'note.md' }
const globalFlows: WorkspaceTab = { id: 'w', type: 'workflow', title: 'Flows' }

describe('resolveActiveKitablePath', () => {
  it('reads the container from table, dashboard, and scoped workflow tabs', () => {
    expect(resolveActiveKitablePath(table, null)).toBe('Leads.kitable')
    expect(resolveActiveKitablePath({ ...globalFlows, kitablePath: 'Leads.kitable' }, null)).toBe('Leads.kitable')
    expect(resolveActiveKitablePath(globalFlows, null)).toBe('')
  })

  it('treats an open .kitable file as its own container only when it loaded as data', () => {
    expect(resolveActiveKitablePath(kitableDoc, 'data')).toBe('Leads.KITABLE')
    expect(resolveActiveKitablePath(kitableDoc, 'markdown')).toBe('')
    expect(resolveActiveKitablePath(note, 'data')).toBe('')
    expect(resolveActiveKitablePath(null, 'data')).toBe('')
  })
})

describe('resolveKitableSidebarMode', () => {
  it('prefers workflow when the workflow route is open', () => {
    expect(resolveKitableSidebarMode(table, true)).toBe('workflow')
    expect(resolveKitableSidebarMode(globalFlows, false)).toBe('workflow')
    expect(resolveKitableSidebarMode({ id: 'b', type: 'dashboard', title: 'B', kitablePath: 'Leads.kitable' } as WorkspaceTab, false)).toBe('dashboard')
    expect(resolveKitableSidebarMode(table, false)).toBe('table')
  })
})
