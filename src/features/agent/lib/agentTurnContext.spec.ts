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

describe('design context', () => {
  it('passes the design context through untouched', () => {
    const designContext = {
      type: 'design.context' as const,
      schema_version: 1 as const,
      design: { id: 'd1', path: 'posters/launch.kidesign', title: 'Launch' },
      artboard: { width: 1080, height: 1440, background: '#ffffff' },
      selected_layer_ids: [],
      layers: [],
      recent_operations: [],
    }
    const context = buildAgentTurnContext({ paneContext: 'design', designContext })
    expect(context.paneContext).toBe('design')
    expect(context.designContext).toBe(designContext)
  })
})

