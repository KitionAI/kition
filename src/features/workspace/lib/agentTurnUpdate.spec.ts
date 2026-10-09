import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceAgentTurnUpdate } from './agentTurnUpdate'

const base = {
  tableAgentContext: null,
  tableAgentDocumentPath: '',
  docIdByKitablePath: { 'leads.kitable': '42' },
  activeDataWorkspaceTableId: 3,
}

describe('buildWorkspaceAgentTurnUpdate', () => {
  it('describes a table tab through its kitable document id and table id', () => {
    const tab: WorkspaceTab = { id: 't', type: 'table', title: 'Leads', kitablePath: 'leads.kitable', tableId: 3, format: 'data' }
    const update = buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: tab, tableAgentDocumentPath: 'leads.kitable' })
    expect(update.activeDocumentPath).toBe('leads.kitable')
    expect(update.activeDataDocumentId).toBe(42)
    expect(update.activeDataTableId).toBe(3)
    expect(update.activeWorkflowId).toBeUndefined()
  })

  it('forwards the workflow id only for a workflow tab opened on one workflow', () => {
    const scoped: WorkspaceTab = { id: 'w', type: 'workflow', title: 'Flow', workflowId: 'wf-1' }
    expect(buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: scoped }).activeWorkflowId).toBe('wf-1')
    expect(buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: { id: 'w', type: 'workflow', title: 'Flows' } }).activeWorkflowId).toBeUndefined()
  })

  it('reports no document ids without a tab or an unknown kitable path', () => {
    const update = buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: null, tableAgentDocumentPath: 'missing.kitable' })
    expect(update.activeDocumentPath).toBe('')
    expect(update.activeDataDocumentId).toBe(0)
    expect(update.activeDataTableId).toBe(3)
  })
})
