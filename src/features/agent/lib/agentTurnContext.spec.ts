import { describe, expect, it } from 'vitest'

import { buildAgentTurnContext } from './agentTurnContext'

describe('buildAgentTurnContext', () => {
  it('uses indexed Kitable ids while the table editor context is still hydrating', () => {
    expect(buildAgentTurnContext({
      activeDocumentPath: 'Reports/Jira.kitable',
      activeDocumentFormat: 'data',
      activeDataDocumentId: 12,
      activeDataTableId: 34,
      paneContext: 'table',
    })).toMatchObject({
      activeDocumentPath: 'Reports/Jira.kitable',
      activeDataDocumentId: 12,
      activeDataTableId: 34,
      paneContext: 'table',
    })
  })

  it('prefers the fully loaded table editor context over fallback ids', () => {
    expect(buildAgentTurnContext({
      activeDocument: { id: 56 } as never,
      activeTable: { id: 78 } as never,
      activeDataDocumentId: 12,
      activeDataTableId: 34,
    })).toMatchObject({
      activeDataDocumentId: 56,
      activeDataTableId: 78,
    })
  })
})
