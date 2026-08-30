import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentDocumentEditingPromptContext,
  prepareAgentDocumentForTurn,
} from './agentDocumentEditing'

describe('buildAgentDocumentEditingPromptContext', () => {
  it('adds deterministic patch guidance for an active text document', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Article.md',
      activeDocumentFormat: 'markdown',
    })

    expect(context).toContain('order all hunks from top to bottom')
    expect(context).toContain('no more than 8 hunks')
    expect(context).toContain('read the affected document again')
    expect(context).toContain('do not submit the unchanged patch again')
    expect(context).toContain('insert the generated workspace-relative image paths')
  })

  it('does not add text patch guidance for structured or binary documents', () => {
    expect(buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Data/Issues.kitable',
      activeDocumentFormat: 'data',
    })).toBe('')
    expect(buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Report.pdf',
      activeDocumentFormat: 'pdf',
    })).toBe('')
  })

  it('provides a cursor-aware safe Markdown image placement contract', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Pendant.md',
      activeDocumentFormat: 'markdown',
      markdownImageInsertionContext: {
        documentPath: 'Docs/Pendant.md',
        cursorOffset: 20,
        preferredOffset: 30,
        preferredLine: 6,
        strategy: 'nearest-blank-line',
        anchorBefore: '```\n',
        anchorAfter: '\nAfter',
      },
    })

    expect(context).toContain('Preferred safe image insertion: line 6, offset 30')
    expect(context).toContain('nearest-blank-line')
    expect(context).toContain('"```\\n"')
    expect(context).toContain('"\\nAfter"')
    expect(context).toContain('Never insert a Markdown image inside')
    expect(context).toContain('nearest top-level blank line')
    expect(context).toContain('fall back to the document end')
  })

  it('provides a safe document-end fallback without cursor context', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Pendant.md',
      activeDocumentFormat: 'markdown',
    })

    expect(context).toContain('No current editor cursor anchor is available')
    expect(context).toContain('fall back to the document end')
  })
})

describe('prepareAgentDocumentForTurn', () => {
  it('blocks the turn and reports a save failure', async () => {
    const onError = vi.fn()

    await expect(prepareAgentDocumentForTurn({
      prepare: async () => false,
      onError,
    })).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith(
      'Current document could not be saved. The agent request was not sent.',
    )
  })

  it('reports preparation errors without starting the turn', async () => {
    const onError = vi.fn()

    await expect(prepareAgentDocumentForTurn({
      prepare: async () => {
        throw new Error('Save conflict')
      },
      onError,
    })).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith('Save conflict')
  })
})
