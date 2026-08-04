import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { isBinaryAttachmentMention } from './documentMentions'

const structuredDocumentFormats = new Set<WorkspaceDocumentFormat>(['data', 'table'])

export function buildAgentDocumentEditingPromptContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
}) {
  const path = String(input.activeDocumentPath || '').trim()
  if (
    !path
    || structuredDocumentFormats.has(input.activeDocumentFormat || 'markdown')
    || path.toLowerCase().endsWith('.kitable')
    || isBinaryAttachmentMention(input.activeDocumentFormat, path)
  ) {
    return ''
  }

  return [
    'Document edit reliability requirements:',
    '- Read the current document immediately before editing and base every edit on the returned content.',
    '- When using apply_patch on one file, order all hunks from top to bottom as they appear in the current file.',
    '- Keep each patch small and non-overlapping; normally use no more than 8 hunks, then apply the next batch separately.',
    '- After a successful patch, treat earlier source text as stale and read the affected document again before preparing another patch.',
    '- If a patch fails, do not submit the unchanged patch again. Read the current document and regenerate only the failed batch from exact current text.',
    '- Never combine edits derived from different versions of the document in one patch call.',
    '- When the user asks for images or illustrations for this document, insert the generated workspace-relative image paths into this same document as Markdown image links before finishing the task.',
  ].join('\n')
}

export async function prepareAgentDocumentForTurn(input: {
  prepare?: () => Promise<boolean>
  onError: (message: string) => void
}) {
  if (!input.prepare) {
    return true
  }

  try {
    const prepared = await input.prepare()
    if (!prepared) {
      input.onError('Current document could not be saved. The agent request was not sent.')
      return false
    }
    return true
  } catch (error) {
    input.onError(error instanceof Error
      ? error.message
      : 'Current document could not be prepared for the agent.')
    return false
  }
}
