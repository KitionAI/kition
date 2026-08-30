import type { WorkspaceDocumentFormat } from '@/services/desktop'
import type { MarkdownImageInsertionContext } from '@/features/document/editor/editor/markdown-image-insertion'
import { isBinaryAttachmentMention } from './documentMentions'

const structuredDocumentFormats = new Set<WorkspaceDocumentFormat>(['data', 'table'])

export function buildAgentDocumentEditingPromptContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  markdownImageInsertionContext?: MarkdownImageInsertionContext
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

  const imageInsertionContext = input.markdownImageInsertionContext?.documentPath === path
    ? input.markdownImageInsertionContext
    : undefined
  const imagePlacementRequirements = [
    'Markdown image placement requirements:',
    '- Insert each generated Markdown image as a standalone block at a top-level block boundary with blank-line separation.',
    '- Never insert a Markdown image inside fenced or inline code, blockquotes, lists, tables, frontmatter, HTML blocks, or other nested Markdown structures.',
    '- Re-read the latest document before insertion. Treat the preferred offset and nearby text as relocation hints, not as authority over newer content.',
    imageInsertionContext
      ? `- Preferred safe image insertion: line ${imageInsertionContext.preferredLine}, offset ${imageInsertionContext.preferredOffset} (strategy: ${imageInsertionContext.strategy}; editor cursor offset: ${imageInsertionContext.cursorOffset ?? 'unavailable'}).`
      : '- No current editor cursor anchor is available; start with the fallback sequence below.',
    ...(imageInsertionContext
      ? [
        `- Text immediately before the preferred boundary: ${JSON.stringify(imageInsertionContext.anchorBefore)}.`,
        `- Text immediately after the preferred boundary: ${JSON.stringify(imageInsertionContext.anchorAfter)}.`,
      ]
      : []),
    '- If the preferred boundary is stale or unsafe, use the nearest top-level blank line to the requested line, preferring the following line when distances are equal.',
    '- If no top-level blank line is available, insert after the containing top-level block and add blank-line separation; if that cannot be located, fall back to the document end.',
  ]

  return [
    'Document edit reliability requirements:',
    '- Read the current document immediately before editing and base every edit on the returned content.',
    '- When using apply_patch on one file, order all hunks from top to bottom as they appear in the current file.',
    '- Keep each patch small and non-overlapping; normally use no more than 8 hunks, then apply the next batch separately.',
    '- After a successful patch, treat earlier source text as stale and read the affected document again before preparing another patch.',
    '- If a patch fails, do not submit the unchanged patch again. Read the current document and regenerate only the failed batch from exact current text.',
    '- Never combine edits derived from different versions of the document in one patch call.',
    '- When the user asks for images or illustrations for this document, insert the generated workspace-relative image paths into this same document as Markdown image links before finishing the task.',
    '',
    ...imagePlacementRequirements,
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
