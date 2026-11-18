import { describe, expect, it } from 'vitest'

import { resolveAgentDocumentTarget } from './agentDocumentTargeting'

describe('agentDocumentTargeting', () => {
  it('keeps the current document when binding is required', () => {
    expect(
      resolveAgentDocumentTarget({
        currentDocumentPath: 'Docs/Current.md',
        referencedDocuments: [
          {
            kind: 'file',
            path: 'Docs/Referenced.md',
            name: 'Referenced.md',
            title: 'Referenced',
            format: 'markdown',
          },
        ],
        bindDocumentContext: true,
        allowSaveMarkdown: true,
      }),
    ).toEqual({
      requestActiveDocumentPath: 'Docs/Current.md',
      saveMarkdown: false,
    })
  })

  it('prefers the referenced document when the turn is unbound', () => {
    expect(
      resolveAgentDocumentTarget({
        currentDocumentPath: 'Docs/Current.md',
        referencedDocuments: [
          {
            kind: 'file',
            path: 'Docs/Referenced.md',
            name: 'Referenced.md',
            title: 'Referenced',
            format: 'markdown',
          },
        ],
        bindDocumentContext: false,
        allowSaveMarkdown: true,
      }),
    ).toEqual({
      requestActiveDocumentPath: 'Docs/Referenced.md',
      saveMarkdown: false,
    })
  })

  it('falls back to the current document when no mention is resolved', () => {
    expect(
      resolveAgentDocumentTarget({
        currentDocumentPath: 'Docs/Current.md',
        bindDocumentContext: false,
        allowSaveMarkdown: true,
      }),
    ).toEqual({
      requestActiveDocumentPath: 'Docs/Current.md',
      saveMarkdown: false,
    })
  })

  it('requests markdown creation only when unbound and no target document exists', () => {
    expect(
      resolveAgentDocumentTarget({
        currentDocumentPath: '',
        referencedDocuments: [],
        bindDocumentContext: false,
        allowSaveMarkdown: true,
      }),
    ).toEqual({
      requestActiveDocumentPath: '',
      saveMarkdown: true,
    })
  })

  it('does not request markdown creation when auto-create is not allowed', () => {
    expect(
      resolveAgentDocumentTarget({
        currentDocumentPath: '',
        referencedDocuments: [],
        bindDocumentContext: false,
        allowSaveMarkdown: false,
      }),
    ).toEqual({
      requestActiveDocumentPath: '',
      saveMarkdown: false,
    })
  })
})
