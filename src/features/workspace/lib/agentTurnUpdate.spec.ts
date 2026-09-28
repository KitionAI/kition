import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceAgentTurnUpdate } from './agentTurnUpdate'

const base = {
  tableAgentContext: null,
  tableAgentDocumentPath: '',
  docIdByKitablePath: { 'leads.kitable': '42' },
  browserResolvedTableId: 9,
  activeDataWorkspaceTableId: 3,
  browserEnabled: false,
}

describe('buildWorkspaceAgentTurnUpdate', () => {
  it('describes a table tab through its kitable document id and table id', () => {
    const tab: WorkspaceTab = { id: 't', type: 'table', title: 'Leads', kitablePath: 'leads.kitable', tableId: 3, format: 'data' }
    const update = buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: tab, tableAgentDocumentPath: 'leads.kitable' })
    expect(update.activeDocumentPath).toBe('leads.kitable')
    expect(update.activeDataDocumentId).toBe(42)
    expect(update.activeDataTableId).toBe(3)
    expect(update.browserContext).toBeUndefined()
    expect(update.activeWorkflowId).toBeUndefined()
  })

  it('uses the browser origin table and attaches the page context for a browser tab', () => {
    const tab: WorkspaceTab = { id: 'b', type: 'browser', title: 'Example', provider: 'generic-web', host: 'example.com', url: 'https://example.com/x' }
    const update = buildWorkspaceAgentTurnUpdate({ ...base, activeWorkspaceTab: tab, browserEnabled: true })
    expect(update.activeDataTableId).toBe(9)
    expect(update.browserEnabled).toBe(true)
    expect(update.browserContext).toMatchObject({ source: 'desktop_embedded_browser', host: 'example.com' })
    expect(update.paneContext).toBeDefined()
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
