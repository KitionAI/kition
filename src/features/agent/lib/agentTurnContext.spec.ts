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

  it('forwards compact Whiteboard context without expanding it in the client', () => {
    const whiteboardContext = {
      type: 'whiteboard.context' as const,
      schema_version: 1 as const,
      board: { id: 'home', path: 'Whiteboards/Home.kiboard', title: 'Home' },
      scope: 'selection' as const,
      viewport: { x: 0, y: 0, width: 1200, height: 800, zoom: 1 },
      selected_element_ids: ['node-1'],
      elements: [],
      clusters: [],
      recent_operations: [],
      source_refs: [],
      current_page: { id: 'page:main', name: 'Home' },
      current_tool: 'select',
      active_style: {},
      lint_findings: [],
    }

    expect(buildAgentTurnContext({
      paneContext: 'whiteboard',
      whiteboardContext,
    })).toMatchObject({
      paneContext: 'whiteboard',
      whiteboardContext,
    })
  })
})
