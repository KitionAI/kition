/**
 * Integration test: renameWorkspaceNode must call renameWorkspaceTabPath
 * when renaming a .kitable file so that open table:// and workflow:// tabs
 * get their kitablePath updated.
 *
 * This test will FAIL before the wire-up and PASS after.
 */

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getWorkspaceDeleteConfirmationMessage,
  useWorkspaceTreeNodeActions,
} from './useWorkspaceTreeNodeActions'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

// ── Service mocks ──────────────────────────────────────────────────────────

const mockMoveWorkspaceDocument = vi.fn()

vi.mock('@/services/desktop', () => ({
  moveWorkspaceDocument: (...args: unknown[]) => mockMoveWorkspaceDocument(...args),
  moveWorkspaceFolder: vi.fn(),
  deleteWorkspaceDocument: vi.fn(),
  deleteWorkspaceFolder: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
  getApiBaseURL: () => '',
}))

vi.mock('@/api/dataDocuments', () => ({
  deleteDataDocumentByPath: vi.fn(),
  renameDataDocumentByPath: vi.fn().mockResolvedValue({ renamed: true, count: 1 }),
}))

vi.mock('@/components/confirm', () => ({
  useConfirm: () => async () => true,
}))

// ── Harness ────────────────────────────────────────────────────────────────

type HarnessProps = {
  apiRef: { current: ReturnType<typeof useWorkspaceTreeNodeActions> | null }
  remapWorkspaceTabPaths: (src: string, tgt: string) => void
  renameWorkspaceTabPath: (from: string, to: string) => void
}

function Surface({ apiRef, remapWorkspaceTabPaths, renameWorkspaceTabPath }: HarnessProps) {
  const api = useWorkspaceTreeNodeActions({
    activeDocumentPath: '',
    activeResourcePath: '',
    applyWorkspaceDocumentList: async () => {},
    filterWorkspaceTabs: () => {},
    hasUnsavedChanges: false,
    persistActiveDocument: async () => true,
    pruneOpenedDocumentDrafts: () => {},
    refreshWorkspaceDocuments: async () => true,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    rootPath: '',
    setActiveResourcePath: () => {},
    setActiveWorkspaceTabId: () => {},
    setAgentModifiedDocumentPaths: () => {},
    setError: () => {},
    setFeedback: () => {},
    setSaving: () => {},
    treeState: {
      expandFolders: () => {},
      flatTreeNodes: [],
      updateTreeMetadata: () => {},
    },
    updateSnapshots: () => {},
  })
  useEffect(() => { apiRef.current = api })
  apiRef.current = api
  return null
}

// ── Tests ──────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  mockMoveWorkspaceDocument.mockReset()
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

const kitableNode: WorkspaceTreeNode = {
  type: 'file',
  format: 'data',
  path: 'Leads.kitable',
  filePath: 'Leads.kitable',
  title: 'Leads.kitable',
  name: 'Leads.kitable',
  virtual: false,
  parentPath: '',
  children: [],
}

describe('useWorkspaceTreeNodeActions — kitable rename integration', () => {
  it('calls renameWorkspaceTabPath with old and new paths when renaming a .kitable file', async () => {
    const remapWorkspaceTabPaths = vi.fn()
    const renameWorkspaceTabPath = vi.fn()

    const apiRef: { current: ReturnType<typeof useWorkspaceTreeNodeActions> | null } = { current: null }

    act(() => {
      root = createRoot(container)
      root.render(
        createElement(Surface, { apiRef, remapWorkspaceTabPaths, renameWorkspaceTabPath }),
      )
    })

    // Simulate backend rename: Leads.kitable → Customers.kitable
    mockMoveWorkspaceDocument.mockResolvedValue({
      path: 'Customers.kitable',
      name: 'Customers.kitable',
      content: '',
      format: 'data',
      updated_at: new Date().toISOString(),
      size: 0,
    })

    await act(async () => {
      await apiRef.current!.renameWorkspaceNode(kitableNode, 'Customers.kitable')
    })

    // renameWorkspaceTabPath must be called with exact old → new paths
    expect(renameWorkspaceTabPath).toHaveBeenCalledWith('Leads.kitable', 'Customers.kitable')
    // remapWorkspaceTabPaths is still called for document: tabs
    expect(remapWorkspaceTabPaths).toHaveBeenCalledWith('Leads.kitable', 'Customers.kitable')
  })
})

describe('getWorkspaceDeleteConfirmationMessage', () => {
  it('describes folder deletion as recoverable from the system Trash', () => {
    expect(getWorkspaceDeleteConfirmationMessage({
      title: 'campaigns',
      type: 'folder',
    }, 11)).toBe(
      'Move folder "campaigns" and its 11 pages to the system Trash? You can restore it from there.',
    )
  })

  it('includes child pages when moving a document to the system Trash', () => {
    expect(getWorkspaceDeleteConfirmationMessage({
      title: 'Campaign.md',
      type: 'file',
    }, 1)).toBe(
      'Move "Campaign.md" and its 1 child page to the system Trash? You can restore it from there.',
    )
  })
})
