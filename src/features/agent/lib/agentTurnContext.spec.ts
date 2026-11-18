import { describe, expect, it } from 'vitest'

import { buildAgentTurnContext } from './agentTurnContext'

describe('buildAgentTurnContext', () => {
  it('forwards the active document path and format', () => {
    expect(buildAgentTurnContext({
      activeDocumentPath: ' Reports/Jira.ktable ',
      activeDocumentFormat: 'table',
      paneContext: 'document',
    })).toMatchObject({
      activeDocumentPath: 'Reports/Jira.ktable',
      activeDocumentFormat: 'table',
      paneContext: 'document',
    })
  })
})
