import { beforeEach, describe, expect, it } from 'vitest'

import {
  readWorkspaceTabs,
  writeWorkspaceTabs,
} from './workspacePersistence'

const ROOT_A = '/Users/alice/vault-a'
const ROOT_B = '/Users/alice/vault-b'

const browserTab = {
  id: 'browser:generic-web:youtube.com:document:travel.kitable',
  type: 'browser' as const,
  title: '',
  provider: 'generic-web',
  host: 'youtube.com',
  url: 'https://example.com/search?q=San%20Diego%20travel',
  query: 'San Diego travel',
  originTabId: 'document:travel.kitable',
  originDocumentPath: 'travel.kitable',
  originTableId: 42,
  originLabel: 'Travel Leads',
}

describe('workspacePersistence browser tabs', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('restores persisted browser tabs when the feature is enabled', () => {
    writeWorkspaceTabs(ROOT_A, [browserTab])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([
      expect.objectContaining({
        ...browserTab,
        title: 'youtube.com · Travel Leads · San Diego travel',
      }),
    ])
  })

  it('keeps each workspace tab list isolated under its own rootPath', () => {
    writeWorkspaceTabs(ROOT_A, [browserTab])
    writeWorkspaceTabs(ROOT_B, [
      {
        id: 'document:notes.md',
        type: 'document',
        title: 'notes',
        path: 'notes.md',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([
      expect.objectContaining({
        ...browserTab,
        title: 'youtube.com · Travel Leads · San Diego travel',
      }),
    ])
    expect(readWorkspaceTabs(ROOT_B)).toEqual([
      {
        id: 'document:notes.md',
        type: 'document',
        title: 'notes',
        path: 'notes.md',
        format: undefined,
      },
    ])
  })

  it('returns no tabs and does not write when rootPath is empty', () => {
    writeWorkspaceTabs(ROOT_A, [browserTab])

    expect(readWorkspaceTabs('')).toEqual([])

    writeWorkspaceTabs('', [
      {
        id: 'document:other.md',
        type: 'document',
        title: 'other',
        path: 'other.md',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([
      expect.objectContaining({
        ...browserTab,
        title: 'youtube.com · Travel Leads · San Diego travel',
      }),
    ])
  })

  it('writing an empty list removes that workspace’s slot', () => {
    writeWorkspaceTabs(ROOT_A, [browserTab])
    writeWorkspaceTabs(ROOT_A, [])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([])
    const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({})
  })

  it('migrates legacy v1 array into the first rootPath that reads it', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v1',
      JSON.stringify([browserTab]),
    )

    expect(readWorkspaceTabs(ROOT_A)).toEqual([
      expect.objectContaining({
        ...browserTab,
        title: 'youtube.com · Travel Leads · San Diego travel',
      }),
    ])
    // Legacy key gets cleaned up.
    expect(window.localStorage.getItem('kition.document.workspace-tabs.v1')).toBeNull()
    // Subsequent reads from other workspaces do not see the migrated data.
    expect(readWorkspaceTabs(ROOT_B)).toEqual([])
  })

  it('drops persisted document tabs whose path ends in .kitable on restore', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v2',
      JSON.stringify({
        [ROOT_A]: [
          { id: 'document:Leads.kitable', type: 'document', title: 'Leads', path: 'Leads.kitable', format: 'data' },
          { id: 'document:notes.md', type: 'document', title: 'Notes', path: 'notes.md', format: 'markdown' },
        ],
      }),
    )
    const restored = readWorkspaceTabs(ROOT_A)
    expect(restored.map((t) => t.id)).toEqual(['document:notes.md'])
  })

  it('restores table tabs scoped to their kitable', () => {
    const tableTab = {
      id: 'table:Leads.kitable#7',
      type: 'table' as const,
      title: 'Leads',
      kitablePath: 'Leads.kitable',
      tableId: 7,
      format: 'data' as const,
    }
    writeWorkspaceTabs(ROOT_A, [tableTab])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([{
      ...tableTab,
      id: 'kitable:Leads.kitable',
    }])
  })

  it('drops malformed table tabs (missing kitablePath or non-integer tableId)', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v2',
      JSON.stringify({
        [ROOT_A]: [
          { id: 'table:Leads.kitable#7', type: 'table', title: 'Leads', tableId: 7, format: 'data' }, // no kitablePath
          { id: 'table:Leads.kitable#x', type: 'table', title: 'Leads', kitablePath: 'Leads.kitable', tableId: 'x', format: 'data' },
          { id: 'table:Leads.kitable#7', type: 'table', title: 'Leads', kitablePath: 'Leads.kitable', tableId: 7, format: 'data' }, // valid
        ],
      }),
    )

    expect(readWorkspaceTabs(ROOT_A).map((t) => t.id)).toEqual(['kitable:Leads.kitable'])
  })

  it('restores dashboard tabs scoped to their kitable', () => {
    const dashboardTab = {
      id: 'dashboard:Tasks.kitable#task-dashboard',
      type: 'dashboard' as const,
      title: 'Task Dashboard',
      kitablePath: 'Tasks.kitable',
      dashboardId: 'task-dashboard',
      format: 'data' as const,
    }
    writeWorkspaceTabs(ROOT_A, [dashboardTab])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([{
      ...dashboardTab,
      id: 'kitable:Tasks.kitable',
      title: 'Tasks',
    }])
  })

  it('restores workflow tabs including optional kitablePath/workflowId', () => {
    const scoped = {
      id: 'workflow:Leads.kitable',
      type: 'workflow' as const,
      title: 'Leads workflows',
      kitablePath: 'Leads.kitable',
      workflowId: 'auto-99',
    }
    const global = {
      id: 'workflow:home',
      type: 'workflow' as const,
      title: 'Workflows',
    }
    writeWorkspaceTabs(ROOT_A, [scoped, global])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([{
      ...scoped,
      id: 'kitable:Leads.kitable',
      title: 'Leads',
    }, global])
  })

  it('merges legacy table/workflow tabs for the same kitable into one file tab', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v2',
      JSON.stringify({
        [ROOT_A]: [
          { id: 'table:Leads.kitable#7', type: 'table', title: 'Prospects', kitablePath: 'Leads.kitable', tableId: 7, format: 'data' },
          { id: 'workflow:Leads.kitable:auto-99', type: 'workflow', title: 'Lead alert', kitablePath: 'Leads.kitable', workflowId: 'auto-99' },
        ],
      }),
    )

    expect(readWorkspaceTabs(ROOT_A)).toEqual([{
      id: 'kitable:Leads.kitable',
      type: 'workflow',
      title: 'Leads',
      kitablePath: 'Leads.kitable',
      workflowId: 'auto-99',
    }])
  })
})
