import { beforeEach, describe, expect, it } from 'vitest'

import {
  readWorkspaceTreeMetadataMap,
  readWorkspaceTabs,
  writeWorkspaceTabs,
} from './workspacePersistence'

const ROOT_A = '/Users/alice/vault-a'
const ROOT_B = '/Users/alice/vault-b'

const boardTab = {
  id: 'board:plan.kiboard',
  type: 'board' as const,
  title: 'plan',
  path: 'plan.kiboard',
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
        boardTab,
      ],
    }))

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(boardTab)])
  })

  it('keeps each workspace tab list isolated under its own rootPath', () => {
    writeWorkspaceTabs(ROOT_A, [boardTab])
    writeWorkspaceTabs(ROOT_B, [
      {
        id: 'document:notes.md',
        type: 'document',
        title: 'notes',
        path: 'notes.md',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(boardTab)])
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
    writeWorkspaceTabs(ROOT_A, [boardTab])

    expect(readWorkspaceTabs('')).toEqual([])

    writeWorkspaceTabs('', [
      {
        id: 'document:other.md',
        type: 'document',
        title: 'other',
        path: 'other.md',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(boardTab)])
  })

  it('writing an empty list removes that workspace’s slot', () => {
    writeWorkspaceTabs(ROOT_A, [boardTab])
    writeWorkspaceTabs(ROOT_A, [])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([])
    const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({})
  })

  it('migrates legacy v1 array into the first rootPath that reads it', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v1',
      JSON.stringify([boardTab]),
    )

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(boardTab)])
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

  it('restores a native Board tab with its durable .kiboard path', () => {
    const boardTab = {
      id: 'board:Planning.kiboard',
      type: 'board' as const,
      title: 'Planning',
      path: 'Planning.kiboard',
    }
    writeWorkspaceTabs(ROOT_A, [boardTab])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([boardTab])
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
