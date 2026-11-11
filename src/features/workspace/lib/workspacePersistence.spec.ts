import { beforeEach, describe, expect, it } from 'vitest'

import {
  readWorkspaceTreeMetadataMap,
  readWorkspaceTabs,
  writeWorkspaceTabs,
} from './workspacePersistence'

const ROOT_A = '/Users/alice/vault-a'
const ROOT_B = '/Users/alice/vault-b'

const videosTab = {
  id: 'gallery:videos',
  type: 'gallery' as const,
  title: 'Videos',
  kind: 'videos' as const,
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
        videosTab,
      ],
    }))

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(videosTab)])
  })

  it('keeps each workspace tab list isolated under its own rootPath', () => {
    writeWorkspaceTabs(ROOT_A, [videosTab])
    writeWorkspaceTabs(ROOT_B, [
      {
        id: 'gallery:clips',
        type: 'gallery',
        title: 'Clips',
        kind: 'videos',
      },
    ])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(videosTab)])
    expect(readWorkspaceTabs(ROOT_B)).toEqual([
      {
        id: 'gallery:clips',
        type: 'gallery',
        title: 'Clips',
        kind: 'videos',
      },
    ])
  })

  it('returns no tabs and does not write when rootPath is empty', () => {
    writeWorkspaceTabs(ROOT_A, [videosTab])

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

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(videosTab)])
  })

  it('writing an empty list removes that workspace’s slot', () => {
    writeWorkspaceTabs(ROOT_A, [videosTab])
    writeWorkspaceTabs(ROOT_A, [])

    expect(readWorkspaceTabs(ROOT_A)).toEqual([])
    const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({})
  })

  it('migrates legacy v1 array into the first rootPath that reads it', () => {
    window.localStorage.setItem(
      'kition.document.workspace-tabs.v1',
      JSON.stringify([videosTab]),
    )

    expect(readWorkspaceTabs(ROOT_A)).toEqual([expect.objectContaining(videosTab)])
    // Legacy key gets cleaned up.
    expect(window.localStorage.getItem('kition.document.workspace-tabs.v1')).toBeNull()
    // Subsequent reads from other workspaces do not see the migrated data.
    expect(readWorkspaceTabs(ROOT_B)).toEqual([])
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
