import { beforeEach, expect, it } from 'vitest'
import {
  deriveAgentPaneContext,
  resolveAgentActiveDocument,
} from './agentPaneContext'
import {
  getWorkspaceItemTitle,
  inferWorkspaceItemFormat,
  isOrganizableWorkspaceFormat,
  renameWorkspaceDocumentPath,
  type WorkspaceTab,
} from './workspace'
import { readWorkspaceTabs, writeWorkspaceTabs } from './workspacePersistence'
beforeEach(() => localStorage.clear())
it('recognizes and renames editable Design files without losing their extension', () => {
  expect(inferWorkspaceItemFormat('Posters/Launch.KIDESIGN')).toBe('design')
  expect(getWorkspaceItemTitle('Launch.kidesign')).toBe('Launch')
  expect(isOrganizableWorkspaceFormat('design')).toBe(true)
  expect(renameWorkspaceDocumentPath('Posters/Launch.kidesign', 'Summer')).toBe(
    'Posters/Summer.kidesign',
  )
})
it('restores Design tabs in their own workspace and does not impersonate a runtime editing target', () => {
  const tab: WorkspaceTab = {
    id: 'design:Posters/Launch.kidesign',
    type: 'design',
    title: 'Launch',
    path: 'Posters/Launch.kidesign',
  }
  writeWorkspaceTabs('/workspace-one', [tab])
  expect(readWorkspaceTabs('/workspace-one')).toEqual([tab])
  expect(readWorkspaceTabs('/workspace-two')).toEqual([])
  expect(deriveAgentPaneContext(tab)).toBe('gallery')
  expect(resolveAgentActiveDocument(tab)).toEqual({ path: '' })
})
