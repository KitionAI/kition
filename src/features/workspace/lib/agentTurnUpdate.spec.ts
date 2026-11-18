import { describe, expect, it } from 'vitest'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceAgentTurnUpdate } from './agentTurnUpdate'

describe('buildWorkspaceAgentTurnUpdate', () => {
  it('describes a file tab through its path and format', () => {
    const tab: WorkspaceTab = { id: 'd', type: 'file-viewer', title: 'Leads', path: 'leads.ktable', format: 'table' }
    const update = buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: tab })
    expect(update.activeDocumentPath).toBe('leads.ktable')
    expect(update.activeDocumentFormat).toBe('table')
    expect(update.paneContext).toBe('document')
  })

  it('reports no document without a tab', () => {
    const update = buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab: null })
    expect(update.activeDocumentPath).toBe('')
    expect(update.paneContext).toBe('document')
  })
})
