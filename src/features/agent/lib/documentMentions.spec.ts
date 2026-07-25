import { describe, expect, it } from 'vitest'
import {
  applyAgentMentionSelection,
  buildAgentDocumentMentionPromptContext,
  extractAgentDocumentMentionTokens,
  findAgentMentionQuery,
  flattenMentionableWorkspaceDocuments,
  parseAgentMentionSegments,
  resolveAgentDocumentMentions,
} from './documentMentions'

describe('documentMentions', () => {
  it('flattens mentionable folders and files', () => {
    expect(flattenMentionableWorkspaceDocuments([
      {
        type: 'folder',
        path: 'Docs',
        name: 'Docs',
        children: [
          {
            type: 'file',
            path: 'Docs/Plan.md',
            name: 'Plan.md',
            format: 'markdown',
          },
          {
            type: 'file',
            path: 'Docs/Data.kitable',
            name: 'Data.kitable',
            format: 'data',
          },
        ],
      },
    ] as never)).toEqual([
      {
        kind: 'folder',
        path: 'Docs',
        name: 'Docs',
        title: 'Docs',
      },
      {
        kind: 'file',
        path: 'Docs/Plan.md',
        name: 'Plan.md',
        title: 'Plan',
        format: 'markdown',
      },
    ])
  })

  it('parses and resolves @{path} mentions', () => {
    expect(extractAgentDocumentMentionTokens('Read @{Docs/Plan.md} and @{Notes/Todo.md}.')).toEqual([
      'Docs/Plan.md',
      'Notes/Todo.md',
    ])

    expect(parseAgentMentionSegments('Read @{Docs/Plan.md} now.')).toEqual([
      { type: 'text', value: 'Read ' },
      { type: 'mention', raw: '@{Docs/Plan.md}', path: 'Docs/Plan.md' },
      { type: 'text', value: ' now.' },
    ])

    const resolved = resolveAgentDocumentMentions({
      content: 'Read @{Docs/Plan.md} and @{Todo}.',
      documents: [
        {
          kind: 'file',
          path: 'Docs/Plan.md',
          name: 'Plan.md',
          title: 'Plan',
          format: 'markdown',
        },
        {
          kind: 'file',
          path: 'Notes/Todo.md',
          name: 'Todo.md',
          title: 'Todo',
          format: 'markdown',
        },
      ],
    })

    expect(resolved.resolved.map((item) => item.path)).toEqual([
      'Docs/Plan.md',
      'Notes/Todo.md',
    ])
    expect(resolved.unresolved).toEqual([])
  })

  it('finds open mention queries and applies selection', () => {
    const query = findAgentMentionQuery('Compare @pla', 'Compare @pla'.length)
    expect(query).toEqual({
      query: 'pla',
      start: 8,
      end: 12,
    })

    expect(applyAgentMentionSelection({
      content: 'Compare @pla now',
      mention: query!,
      path: 'Docs/Plan.md',
    })).toEqual({
      content: 'Compare @{Docs/Plan.md}  now',
      caret: 24,
    })
  })

  it('builds explicit prompt context for referenced docs', () => {
    expect(buildAgentDocumentMentionPromptContext({
      referencedDocuments: [
        {
          kind: 'file',
          path: 'Docs/Plan.md',
          name: 'Plan.md',
          title: 'Plan',
          format: 'markdown',
        },
      ],
      unresolvedTokens: ['Unknown'],
    })).toContain('Referenced workspace documents in this turn:')
  })

  it('builds a folders block instructing document_list for referenced folders', () => {
    const context = buildAgentDocumentMentionPromptContext({
      referencedDocuments: [
        {
          kind: 'folder',
          path: 'Docs',
          name: 'Docs',
          title: 'Docs',
        },
      ],
    })
    expect(context).toContain('Referenced workspace folders in this turn:')
    expect(context).toContain('- Docs')
    expect(context).toContain('document_list')
  })
})
