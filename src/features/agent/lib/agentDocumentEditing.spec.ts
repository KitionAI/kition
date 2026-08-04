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
