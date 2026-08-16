import { describe, expect, it } from 'vitest'
import type { AgentMentionableDocument } from './documentMentions'
import {
  applyAgentMentionSelection,
  buildAgentDraftWithDocumentMentions,
  buildAgentDocumentMentionPromptContext,
  extractAgentDocumentMentionTokens,
  findAgentMentionQuery,
  flattenMentionableWorkspaceDocuments,
  getUniqueAgentDocumentMentionPaths,
  parseAgentMentionSegments,
  removeAgentDocumentMention,
  resolveAgentDocumentMentions,
  searchAgentMentionableDocuments,
  stripAgentDocumentMentions,
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
      {
        kind: 'file',
        path: 'Docs/Data.kitable',
        name: 'Data.kitable',
        title: 'Data',
        format: 'data',
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

  it('keeps mention search open for document names containing spaces', () => {
    expect(findAgentMentionQuery('Compare @project intro', 'Compare @project intro'.length)).toEqual({
      query: 'project intro',
      start: 8,
      end: 22,
    })
  })

  it('searches the full document set and ranks current and exact title matches first', () => {
    const documents: AgentMentionableDocument[] = [
      { kind: 'file', path: 'Archive/Project notes.md', name: 'Project notes.md', title: 'Project notes', format: 'markdown' },
      { kind: 'file', path: 'Agent/Project intro.md', name: 'Project intro.md', title: 'Project intro', format: 'markdown' },
      { kind: 'folder', path: 'Projects', name: 'Projects', title: 'Projects' },
    ]
    expect(searchAgentMentionableDocuments({
      documents,
      query: 'project intro',
      currentDocumentPath: 'Agent/Project intro.md',
    }).map((document) => document.path)).toEqual([
      'Agent/Project intro.md',
    ])
    expect(searchAgentMentionableDocuments({
      documents,
      query: 'project',
      currentDocumentPath: 'Agent/Project intro.md',
      contextPaths: ['Archive/Project notes.md'],
    }).map((document) => document.path)).toEqual([
      'Agent/Project intro.md',
      'Archive/Project notes.md',
      'Projects',
    ])
  })

  it('stores document mentions separately from visible composer text', () => {
    const draft = buildAgentDraftWithDocumentMentions('Analyze this file', [
      'Getting Started/Guides/Product Content/Product Content Studio.kitable',
      'Notes/Todo.md',
    ])

    expect(stripAgentDocumentMentions(draft)).toBe('Analyze this file')
    expect(getUniqueAgentDocumentMentionPaths(draft)).toEqual([
      'Getting Started/Guides/Product Content/Product Content Studio.kitable',
      'Notes/Todo.md',
    ])
    expect(removeAgentDocumentMention(draft, 'Notes/Todo.md')).toBe(
      'Analyze this file\n@{Getting Started/Guides/Product Content/Product Content Studio.kitable}',
    )
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

  it('requires analysis of the current document without an explicit mention', () => {
    const context = buildAgentDocumentMentionPromptContext({
      activeDocumentPath: 'Docs/Current.md',
      activeDocumentFormat: 'markdown',
      referencedDocuments: [],
    })

    expect(context).toContain('Current workspace document for this turn:')
    expect(context).toContain('Docs/Current.md')
    expect(context).toContain('Read this exact path with document_read and analyze it before responding')
    expect(context).toContain('Do not ask which document the user means')
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
