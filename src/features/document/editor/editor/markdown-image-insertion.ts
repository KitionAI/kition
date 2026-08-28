import type { SyntaxNode } from '@lezer/common'
import { GFM, parser as baseMarkdownParser } from '@lezer/markdown'

import { parseFrontmatter } from '@/features/document/editor/lib/frontmatter-parser'

export type MarkdownImageInsertionStrategy =
  | 'cursor-blank-line'
  | 'nearest-blank-line'
  | 'after-block'
  | 'document-end'

export type MarkdownImageInsertionContext = {
  documentPath: string
  cursorOffset: number | null
  preferredOffset: number
  preferredLine: number
  strategy: MarkdownImageInsertionStrategy
  anchorBefore: string
  anchorAfter: string
}

export type MarkdownImageInsertionSnapshot = {
  documentPath: string
  markdown: string
  cursorOffset: number
}

type DocumentRange = {
  from: number
  to: number
}

type DocumentLine = DocumentRange & {
  number: number
  text: string
}

const markdownParser = baseMarkdownParser.configure([GFM])
const anchorLength = 80

export function resolveMarkdownImageInsertionContext(input: {
  documentPath: string
  markdown: string
  cursorOffset?: number
}): MarkdownImageInsertionContext {
  const cursorOffset = normalizeCursorOffset(input.cursorOffset, input.markdown.length)
  if (cursorOffset === null) {
    return buildContext(input, cursorOffset, input.markdown.length, 'document-end')
  }

  const lines = collectDocumentLines(input.markdown)
  const topLevelBlocks = collectTopLevelBlocks(input.markdown)
  const blankLines = lines.filter((line) => (
    line.text.trim() === ''
    && !topLevelBlocks.some((block) => containsOffset(block, line.from))
  ))
  const cursorLine = findLineAt(lines, cursorOffset)
  if (cursorLine?.text.trim() === '' && blankLines.includes(cursorLine)) {
    return buildContext(input, cursorOffset, cursorLine.from, 'cursor-blank-line', cursorLine.number)
  }

  const nearestBlankLine = blankLines
    .map((line) => ({
      line,
      distance: Math.abs(line.from - cursorOffset),
      followsCursor: line.from >= cursorOffset,
    }))
    .sort((left, right) => (
      left.distance - right.distance
      || Number(right.followsCursor) - Number(left.followsCursor)
      || left.line.from - right.line.from
    ))[0]?.line
  if (nearestBlankLine) {
    return buildContext(
      input,
      cursorOffset,
      nearestBlankLine.from,
      'nearest-blank-line',
      nearestBlankLine.number,
    )
  }

  const containingBlock = topLevelBlocks.find((block) => containsOffset(block, cursorOffset))
  if (containingBlock) {
    return buildContext(input, cursorOffset, containingBlock.to, 'after-block')
  }

  return buildContext(input, cursorOffset, input.markdown.length, 'document-end')
}

function normalizeCursorOffset(offset: number | undefined, documentLength: number): number | null {
  if (!Number.isInteger(offset) || offset === undefined || offset < 0 || offset > documentLength) {
    return null
  }
  return offset
}

function collectTopLevelBlocks(markdown: string): DocumentRange[] {
  const root = markdownParser.parse(markdown).topNode
  const ranges: DocumentRange[] = []
  for (let child: SyntaxNode | null = root.firstChild; child; child = child.nextSibling) {
    ranges.push({ from: child.from, to: child.to })
  }

  const frontmatter = parseFrontmatter(markdown)
  if (frontmatter) {
    ranges.push({ from: frontmatter.from, to: frontmatter.to })
  }

  return ranges.sort((left, right) => left.from - right.from || right.to - left.to)
}

function collectDocumentLines(markdown: string): DocumentLine[] {
  const lines: DocumentLine[] = []
  let from = 0
  let number = 1
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown[index] !== '\n') continue
    const contentTo = index > from && markdown[index - 1] === '\r' ? index - 1 : index
    lines.push({
      from,
      to: contentTo,
      number,
      text: markdown.slice(from, contentTo),
    })
    from = index + 1
    number += 1
  }
  return lines
}

function findLineAt(lines: DocumentLine[], offset: number) {
  return lines.find((line, index) => (
    offset >= line.from
    && (offset <= line.to || (index < lines.length - 1 && offset < lines[index + 1].from))
  )) || lines.at(-1)
}

function containsOffset(range: DocumentRange, offset: number) {
  return offset >= range.from && offset <= range.to
}

function buildContext(
  input: { documentPath: string; markdown: string },
  cursorOffset: number | null,
  preferredOffset: number,
  strategy: MarkdownImageInsertionStrategy,
  preferredLine?: number,
): MarkdownImageInsertionContext {
  return {
    documentPath: input.documentPath,
    cursorOffset,
    preferredOffset,
    preferredLine: preferredLine ?? lineNumberAt(input.markdown, preferredOffset),
    strategy,
    anchorBefore: input.markdown.slice(Math.max(0, preferredOffset - anchorLength), preferredOffset),
    anchorAfter: input.markdown.slice(preferredOffset, preferredOffset + anchorLength),
  }
}

function lineNumberAt(markdown: string, offset: number) {
  let line = 1
  for (let index = 0; index < Math.min(offset, markdown.length); index += 1) {
    if (markdown[index] === '\n') line += 1
  }
  return line
}
