import { describe, expect, it } from 'vitest'

import { buildAgentTurnContext, finalizeAgentTurnContext } from './agentTurnContext'

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

  it('keeps Markdown image insertion context for the active document', () => {
    const markdownImageInsertionContext = {
      documentPath: 'Docs/Pendant.md',
      cursorOffset: 42,
      preferredOffset: 48,
      preferredLine: 6,
      strategy: 'nearest-blank-line' as const,
      anchorBefore: 'before',
      anchorAfter: 'after',
    }

    expect(buildAgentTurnContext({
      activeDocumentPath: 'Docs/Pendant.md',
      activeDocumentFormat: 'markdown',
      markdownImageInsertionContext,
    })).toMatchObject({ markdownImageInsertionContext })
  })

  it('drops stale Markdown image insertion context from another document', () => {
    expect(buildAgentTurnContext({
      activeDocumentPath: 'Docs/Current.md',
      activeDocumentFormat: 'markdown',
      markdownImageInsertionContext: {
        documentPath: 'Docs/Previous.md',
        cursorOffset: 42,
        preferredOffset: 48,
        preferredLine: 6,
        strategy: 'nearest-blank-line',
        anchorBefore: 'before',
        anchorAfter: 'after',
      },
    }).markdownImageInsertionContext).toBeUndefined()
  })

  it('resolves the latest Markdown cursor snapshot only when finalizing an Agent turn', () => {
    const baseContext = buildAgentTurnContext({
      activeDocumentPath: 'Docs/Pendant.md',
      activeDocumentFormat: 'markdown',
    })

    expect(finalizeAgentTurnContext({
      baseContext,
      markdownImageInsertionSnapshot: {
        documentPath: 'Docs/Pendant.md',
        markdown: '# Title\n\nBody',
        cursorOffset: 8,
      },
    }).markdownImageInsertionContext).toMatchObject({
      documentPath: 'Docs/Pendant.md',
      cursorOffset: 8,
      preferredOffset: 8,
      strategy: 'cursor-blank-line',
    })
  })

  it('does not resolve a cursor snapshot for another active document', () => {
    const baseContext = buildAgentTurnContext({
      activeDocumentPath: 'Docs/Current.md',
      activeDocumentFormat: 'markdown',
    })

    expect(finalizeAgentTurnContext({
      baseContext,
      markdownImageInsertionSnapshot: {
        documentPath: 'Docs/Previous.md',
        markdown: '# Previous',
        cursorOffset: 3,
      },
    }).markdownImageInsertionContext).toBeUndefined()
  })
})
