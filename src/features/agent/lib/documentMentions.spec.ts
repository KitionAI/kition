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
            path: 'Docs/Data.ktable',
            name: 'Data.ktable',
            format: 'table',
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
        path: 'Docs/Data.ktable',
        name: 'Data.ktable',
        title: 'Data',
        format: 'table',
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

  it('ranks the active tab first when its path uses equivalent separators and casing', () => {
    const documents: AgentMentionableDocument[] = [
      { kind: 'file', path: 'Docs/Other.md', name: 'Other.md', title: 'Other', format: 'markdown' },
      { kind: 'file', path: 'Docs/Current.md', name: 'Current.md', title: 'Current', format: 'markdown' },
      { kind: 'file', path: 'Docs/Recent.md', name: 'Recent.md', title: 'Recent', format: 'markdown' },
    ]

    expect(searchAgentMentionableDocuments({
      documents,
      query: '',
      currentDocumentPath: 'docs\\current.md',
      contextPaths: ['Docs/Recent.md'],
    }).map((document) => document.path)).toEqual([
      'Docs/Current.md',
      'Docs/Recent.md',
      'Docs/Other.md',
    ])
  })

  it('prefers an exact active path when case-folded paths are ambiguous', () => {
    const documents: AgentMentionableDocument[] = [
      { kind: 'file', path: 'Docs/current.md', name: 'current.md', title: 'lowercase', format: 'markdown' },
      { kind: 'file', path: 'Docs/Current.md', name: 'Current.md', title: 'Current', format: 'markdown' },
    ]

    expect(searchAgentMentionableDocuments({
      documents,
      query: '',
      currentDocumentPath: 'Docs/Current.md',
    }).map((document) => document.path)).toEqual([
      'Docs/Current.md',
      'Docs/current.md',
    ])
  })

  it('does not collapse compatibility characters when identifying the active path', () => {
    const documents: AgentMentionableDocument[] = [
      { kind: 'file', path: 'Docs/1.md', name: '1.md', title: 'One', format: 'markdown' },
      { kind: 'file', path: 'Docs/①.md', name: '①.md', title: 'Circled one', format: 'markdown' },
    ]

    expect(searchAgentMentionableDocuments({
      documents,
      query: '',
      currentDocumentPath: 'Docs/①.md',
    }).map((document) => document.path)).toEqual([
      'Docs/①.md',
      'Docs/1.md',
    ])
  })

  it('stores document mentions separately from visible composer text', () => {
    const draft = buildAgentDraftWithDocumentMentions('Analyze this file', [
      'Getting Started/Guides/Product Content/Product Content Studio.ktable',
      'Notes/Todo.md',
    ])

    expect(stripAgentDocumentMentions(draft)).toBe('Analyze this file')
    expect(getUniqueAgentDocumentMentionPaths(draft)).toEqual([
      'Getting Started/Guides/Product Content/Product Content Studio.ktable',
      'Notes/Todo.md',
    ])
    expect(removeAgentDocumentMention(draft, 'Notes/Todo.md')).toBe(
      'Analyze this file\n@{Getting Started/Guides/Product Content/Product Content Studio.ktable}',
    )
  })

  it('preserves user-authored trailing newlines while removing a trailing mention line', () => {
    expect(stripAgentDocumentMentions('First line\n')).toBe('First line\n')
    expect(stripAgentDocumentMentions('First line\n@{Docs/Plan.md}')).toBe('First line')
    expect(stripAgentDocumentMentions('First line\n\n@{Docs/Plan.md}')).toBe('First line\n')
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

  it('points the agent at each kit\'s own tools for its files', () => {
    const active = buildAgentDocumentMentionPromptContext({
      activeDocumentPath: 'Art/Logo.kvector',
      activeDocumentFormat: 'vector',
      referencedDocuments: [],
    })
    expect(active).toContain('a vector drawing open in Vector')
    expect(active).toContain('vector_inspect')
    expect(active).not.toContain('photo_inspect')

    const mentioned = buildAgentDocumentMentionPromptContext({
      referencedDocuments: [
        { kind: 'file', path: 'Motion/Intro.keffect', name: 'Intro.keffect', title: 'Intro' },
        { kind: 'file', path: 'Print/Flyer.kdesign', name: 'Flyer.kdesign', title: 'Flyer' },
      ],
    })
    expect(mentioned).toContain('Referenced motion graphics projects in this turn (open them in Effect)')
    expect(mentioned).toContain('effect_run')
    expect(mentioned).toContain('Referenced page layouts in this turn (open them in Design)')
    expect(mentioned).toContain('design_commands')
    expect(mentioned).not.toContain('Referenced workspace documents in this turn')
  })

  it('points the agent at the Photo tools for an open or mentioned layered image', () => {
    const active = buildAgentDocumentMentionPromptContext({
      activeDocumentPath: 'Art/Cover.psd',
      activeDocumentFormat: 'photo',
      referencedDocuments: [],
    })
    expect(active).toContain('layered image open in Photo')
    expect(active).toContain('photo_inspect')
    expect(active).not.toContain('Read this exact path with document_read')

    const mentioned = buildAgentDocumentMentionPromptContext({
      referencedDocuments: [{ kind: 'file', path: 'Art/Poster.psb', name: 'Poster.psb', title: 'Poster' }],
    })
    expect(mentioned).toContain('Referenced layered images in this turn')
    expect(mentioned).toContain('- Art/Poster.psb')
    expect(mentioned).not.toContain('Referenced workspace documents in this turn')
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
