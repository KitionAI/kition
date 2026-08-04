import type { WorkspaceDocument } from '@/services/desktop'

export type DocumentRevisionDecision = 'accepted' | 'rejected'

export type DocumentRevisionInlinePart = {
  kind: 'equal' | 'added' | 'removed'
  text: string
}

export type DocumentRevisionChange = {
  id: string
  oldText: string
  newText: string
  parts: DocumentRevisionInlinePart[]
}

export type DocumentRevisionSegment =
  | { kind: 'equal'; text: string }
  | { kind: 'change'; change: DocumentRevisionChange }

export type DocumentRevisionComparison = {
  changes: DocumentRevisionChange[]
  segments: DocumentRevisionSegment[]
}

export type DocumentRevisionDisplayLine = {
  kind: 'equal' | 'added' | 'removed'
  text: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

export type DocumentRevisionDisplayBlock =
  | { kind: 'equal'; lines: DocumentRevisionDisplayLine[] }
  | {
      kind: 'change'
      change: DocumentRevisionChange
      lines: DocumentRevisionDisplayLine[]
    }

export type PendingDocumentRevision = {
  path: string
  originalDocument: WorkspaceDocument
  proposedDocument: WorkspaceDocument
  comparison: DocumentRevisionComparison
  decisions: Record<string, DocumentRevisionDecision>
}

type SequenceDiffPart<T> = {
  kind: 'equal' | 'added' | 'removed'
  values: T[]
}

const MAX_LINE_DIFF_CELLS = 1_000_000
const MAX_INLINE_DIFF_CELLS = 500_000

function appendSequencePart<T>(
  parts: SequenceDiffPart<T>[],
  kind: SequenceDiffPart<T>['kind'],
  value: T,
) {
  const current = parts[parts.length - 1]
  if (current?.kind === kind) {
    current.values.push(value)
    return
  }
  parts.push({ kind, values: [value] })
}

function diffSequence<T>(
  original: T[],
  proposed: T[],
  maxCells: number,
): SequenceDiffPart<T>[] {
  if (!original.length && !proposed.length) return []
  if (!original.length) return [{ kind: 'added', values: proposed }]
  if (!proposed.length) return [{ kind: 'removed', values: original }]

  let prefixLength = 0
  while (
    prefixLength < original.length
    && prefixLength < proposed.length
    && original[prefixLength] === proposed[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < original.length - prefixLength
    && suffixLength < proposed.length - prefixLength
    && original[original.length - 1 - suffixLength] === proposed[proposed.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const originalMiddle = original.slice(prefixLength, original.length - suffixLength)
  const proposedMiddle = proposed.slice(prefixLength, proposed.length - suffixLength)
  const parts: SequenceDiffPart<T>[] = []

  for (const value of original.slice(0, prefixLength)) {
    appendSequencePart(parts, 'equal', value)
  }

  if (!originalMiddle.length) {
    for (const value of proposedMiddle) appendSequencePart(parts, 'added', value)
  } else if (!proposedMiddle.length) {
    for (const value of originalMiddle) appendSequencePart(parts, 'removed', value)
  } else if (originalMiddle.length * proposedMiddle.length > maxCells) {
    for (const value of originalMiddle) appendSequencePart(parts, 'removed', value)
    for (const value of proposedMiddle) appendSequencePart(parts, 'added', value)
  } else {
    const rows = Array.from(
      { length: originalMiddle.length + 1 },
      () => new Uint32Array(proposedMiddle.length + 1),
    )
    for (let originalIndex = originalMiddle.length - 1; originalIndex >= 0; originalIndex -= 1) {
      for (let proposedIndex = proposedMiddle.length - 1; proposedIndex >= 0; proposedIndex -= 1) {
        rows[originalIndex][proposedIndex] = originalMiddle[originalIndex] === proposedMiddle[proposedIndex]
          ? rows[originalIndex + 1][proposedIndex + 1] + 1
          : Math.max(rows[originalIndex + 1][proposedIndex], rows[originalIndex][proposedIndex + 1])
      }
    }

    let originalIndex = 0
    let proposedIndex = 0
    while (originalIndex < originalMiddle.length || proposedIndex < proposedMiddle.length) {
      if (
        originalIndex < originalMiddle.length
        && proposedIndex < proposedMiddle.length
        && originalMiddle[originalIndex] === proposedMiddle[proposedIndex]
      ) {
        appendSequencePart(parts, 'equal', originalMiddle[originalIndex])
        originalIndex += 1
        proposedIndex += 1
      } else if (
        proposedIndex < proposedMiddle.length
        && (
          originalIndex >= originalMiddle.length
          || rows[originalIndex][proposedIndex + 1] > rows[originalIndex + 1][proposedIndex]
        )
      ) {
        appendSequencePart(parts, 'added', proposedMiddle[proposedIndex])
        proposedIndex += 1
      } else {
        appendSequencePart(parts, 'removed', originalMiddle[originalIndex])
        originalIndex += 1
      }
    }
  }

  for (const value of original.slice(original.length - suffixLength)) {
    appendSequencePart(parts, 'equal', value)
  }
  return parts
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) || []
}

function splitDisplayLines(text: string): string[] {
  return (text.match(/[^\n]*(?:\n|$)/g) || [])
    .filter(Boolean)
    .map((line) => line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line.replace(/\r$/, ''))
}

function splitInlineTokens(text: string): string[] {
  return text.match(
    /\r\n|\n|[ \t]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu,
  ) || []
}

function createInlineParts(oldText: string, newText: string): DocumentRevisionInlinePart[] {
  return diffSequence(
    splitInlineTokens(oldText),
    splitInlineTokens(newText),
    MAX_INLINE_DIFF_CELLS,
  ).map((part) => ({
    kind: part.kind,
    text: part.values.join(''),
  }))
}

export function createDocumentRevisionComparison(
  originalContent: string,
  proposedContent: string,
): DocumentRevisionComparison {
  const lineParts = diffSequence(
    splitLines(originalContent),
    splitLines(proposedContent),
    MAX_LINE_DIFF_CELLS,
  )
  const changes: DocumentRevisionChange[] = []
  const segments: DocumentRevisionSegment[] = []
  let removedText = ''
  let addedText = ''

  function flushChange() {
    if (!removedText && !addedText) return
    const change: DocumentRevisionChange = {
      id: `change-${changes.length + 1}`,
      oldText: removedText,
      newText: addedText,
      parts: createInlineParts(removedText, addedText),
    }
    changes.push(change)
    segments.push({ kind: 'change', change })
    removedText = ''
    addedText = ''
  }

  for (const part of lineParts) {
    const text = part.values.join('')
    if (part.kind === 'equal') {
      flushChange()
      const previous = segments[segments.length - 1]
      if (previous?.kind === 'equal') {
        previous.text += text
      } else {
        segments.push({ kind: 'equal', text })
      }
    } else if (part.kind === 'removed') {
      removedText += text
    } else {
      addedText += text
    }
  }
  flushChange()

  return { changes, segments }
}

export function applyDocumentRevisionDecisions(
  comparison: DocumentRevisionComparison,
  decisions: Record<string, DocumentRevisionDecision>,
  pendingDecision: DocumentRevisionDecision = 'accepted',
): string {
  return comparison.segments.map((segment) => {
    if (segment.kind === 'equal') return segment.text
    const decision = decisions[segment.change.id] || pendingDecision
    return decision === 'accepted' ? segment.change.newText : segment.change.oldText
  }).join('')
}

export function buildDocumentRevisionDisplayBlocks(
  comparison: DocumentRevisionComparison,
): DocumentRevisionDisplayBlock[] {
  let oldLineNumber = 1
  let newLineNumber = 1

  return comparison.segments.map((segment) => {
    if (segment.kind === 'equal') {
      const lines = splitDisplayLines(segment.text).map((text) => ({
        kind: 'equal' as const,
        text,
        oldLineNumber: oldLineNumber++,
        newLineNumber: newLineNumber++,
      }))
      return { kind: 'equal' as const, lines }
    }

    const removedLines = splitDisplayLines(segment.change.oldText).map((text) => ({
      kind: 'removed' as const,
      text,
      oldLineNumber: oldLineNumber++,
      newLineNumber: null,
    }))
    const addedLines = splitDisplayLines(segment.change.newText).map((text) => ({
      kind: 'added' as const,
      text,
      oldLineNumber: null,
      newLineNumber: newLineNumber++,
    }))
    return {
      kind: 'change' as const,
      change: segment.change,
      lines: [...removedLines, ...addedLines],
    }
  })
}

export function remapPendingDocumentRevision(
  revision: PendingDocumentRevision,
  nextPath: string,
): PendingDocumentRevision {
  const nextName = nextPath.split('/').pop() || revision.proposedDocument.name
  return {
    ...revision,
    path: nextPath,
    originalDocument: {
      ...revision.originalDocument,
      path: nextPath,
      name: nextName,
    },
    proposedDocument: {
      ...revision.proposedDocument,
      path: nextPath,
      name: nextName,
    },
  }
}
