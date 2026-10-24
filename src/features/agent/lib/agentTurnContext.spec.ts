import { describe, expect, it } from 'vitest'

import { resolveMarkdownImageInsertionContext } from '@/features/document/editor/editor/markdown-image-insertion'

import { buildAgentTurnContext, finalizeAgentTurnContext } from './agentTurnContext'

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
      resolveMarkdownImageInsertionContext,
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
      resolveMarkdownImageInsertionContext,
      markdownImageInsertionSnapshot: {
        documentPath: 'Docs/Previous.md',
        markdown: '# Previous',
        cursorOffset: 3,
      },
    }).markdownImageInsertionContext).toBeUndefined()
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

