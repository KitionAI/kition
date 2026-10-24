import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentDocumentEditingPromptContext,
  prepareAgentDocumentForTurn,
} from './agentDocumentEditing'

describe('buildAgentDocumentEditingPromptContext', () => {
  it('points the agent at note_run for an active note, never at text tools', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Article.md',
      activeDocumentFormat: 'markdown',
    })

    expect(context).toContain('Note edit requirements:')
    expect(context).toContain('only with note_run')
    expect(context).toContain('never with document_write or apply_patch')
    expect(context).toContain('with note_run (`text.insert`)')
    expect(context).not.toContain('order all hunks from top to bottom')
  })

  it('adds deterministic patch guidance for an active text document', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Article.txt',
      activeDocumentFormat: 'text',
    })

    expect(context).toContain('order all hunks from top to bottom')
    expect(context).toContain('no more than 8 hunks')
    expect(context).toContain('read the affected document again')
    expect(context).toContain('do not submit the unchanged patch again')
    expect(context).toContain('insert the generated workspace-relative image paths')
  })

  it('does not add text patch guidance for structured or binary documents', () => {
    expect(buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Data/Issues.ktable',
      activeDocumentFormat: 'table',
    })).toBe('')
    expect(buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Report.pdf',
      activeDocumentFormat: 'pdf',
    })).toBe('')
  })

  it('provides a safe Markdown image placement contract with a document-end fallback', () => {
    const context = buildAgentDocumentEditingPromptContext({
      activeDocumentPath: 'Docs/Pendant.md',
      activeDocumentFormat: 'markdown',
    })

    expect(context).toContain('Never insert a Markdown image inside')
    expect(context).toContain('nearest top-level blank line')
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
