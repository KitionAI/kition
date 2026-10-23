import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceAgentTurnUpdate } from './agentTurnUpdate'

describe('buildWorkspaceAgentTurnUpdate', () => {
  it('describes a document tab through its path and format', () => {
    const tab: WorkspaceTab = { id: 'd', type: 'document', title: 'Leads', path: 'leads.ktable', format: 'table' }
    const update = buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: tab })
    expect(update.activeDocumentPath).toBe('leads.ktable')
    expect(update.activeDocumentFormat).toBe('table')
    expect(update.paneContext).toBe('document')
    expect(update.activeWorkflowId).toBeUndefined()
  })

  it('forwards the workflow id only for a workflow tab opened on one workflow', () => {
    const scoped: WorkspaceTab = { id: 'w', type: 'workflow', title: 'Flow', workflowId: 'wf-1' }
    expect(buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: scoped }).activeWorkflowId).toBe('wf-1')
    expect(buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: { id: 'w', type: 'workflow', title: 'Flows' } }).activeWorkflowId).toBeUndefined()
  })

  it('reports no document without a tab', () => {
    const update = buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: null })
    expect(update.activeDocumentPath).toBe('')
    expect(update.paneContext).toBe('document')
  })
})
