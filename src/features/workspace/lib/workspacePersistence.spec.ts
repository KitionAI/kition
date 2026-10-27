import { beforeEach, describe, expect, it } from 'vitest'

import {
  readWorkspaceTreeMetadataMap,
  readWorkspaceTabs,
  writeWorkspaceTabs,
} from './workspacePersistence'

const ROOT_A = '/Users/alice/vault-a'
const ROOT_B = '/Users/alice/vault-b'

const workflowTab = {
  id: 'workflow:plan.ktable',
  type: 'workflow' as const,
  title: 'plan',
  tablePath: 'plan.ktable',
}

describe('workspacePersistence tabs', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('drops browser tabs saved by earlier versions', () => {
    window.localStorage.setItem('kition.document.workspace-tabs.v2', JSON.stringify({
      [ROOT_A]: [
        { id: 'browser:generic-web:example.com', type: 'browser', title: 'Example', provider: 'generic-web' },
        { id: 'browser-sites', type: 'browser-sites', title: 'Sites' },
        workflowTab,
      ],
    }))

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(workflowTab)])
  })

  it('keeps each workspace tab list isolated under its own rootPath', () => {
    writeWorkspaceTabs(ROOT_A, [workflowTab])
    writeWorkspaceTabs(ROOT_B, [
      {
        id: 'workflow:notes.ktable',
        type: 'workflow',
        title: 'notes',
        tablePath: 'notes.ktable',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(workflowTab)])
    expect(readWorkspaceTabs(ROOT_B)).toEqual([
      {
        id: 'workflow:notes.ktable',
        type: 'workflow',
        title: 'notes',
        tablePath: 'notes.ktable',
      },
    ])
  })

  it('returns no tabs and does not write when rootPath is empty', () => {
    writeWorkspaceTabs(ROOT_A, [workflowTab])

    expect(readWorkspaceTabs('')).toEqual([])

    writeWorkspaceTabs('', [
      {
        id: 'file-viewer:other.md',
        type: 'file-viewer',
        title: 'other',
        path: 'other.md',
        format: 'markdown',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(workflowTab)])
  })

  it('writing an empty list removes that workspace’s slot', () => {
    writeWorkspaceTabs(ROOT_A, [workflowTab])
    writeWorkspaceTabs(ROOT_A, [])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([])
    const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({})
  })

  it('migrates legacy v1 array into the first rootPath that reads it', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v1',
      JSON.stringify([workflowTab]),
    )

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(workflowTab)])
    // Legacy key gets cleaned up.
    expect(window.localStorage.getItem('kition.document.workspace-tabs.v1')).toBeNull()
    // Subsequent reads from other workspaces do not see the migrated data.
    expect(readWorkspaceTabs(ROOT_B)).toEqual([])
  })

  it('restores workflow tabs including optional tablePath/workflowId', () => {
    const scoped = {
      id: 'workflow:Leads.ktable',
      type: 'workflow' as const,
      title: 'Leads workflows',
      tablePath: 'Leads.ktable',
      workflowId: 'auto-99',
    }
    const global = {
      id: 'workflow:home',
      type: 'workflow' as const,
      title: 'Workflows',
    }
    writeWorkspaceTabs(ROOT_A, [scoped, global])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([scoped, global])
  })
})

describe('workspacePersistence tree metadata', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('migrates legacy folder state to the new collapsed-by-default behavior', () => {
    window.localStorage.setItem(
      'kition.document.tree.metadata.v2',
      JSON.stringify({
        [ROOT_A]: {
          icons: {},
          order: {},
          collapsed: ['Previously closed'],
        },
      }),
    )

    expect(readWorkspaceTreeMetadataMap()[ROOT_A]).toEqual({
      icons: {},
      order: {},
      collapsed: ['Previously closed'],
      expandedFolders: [],
    })
  })
})
