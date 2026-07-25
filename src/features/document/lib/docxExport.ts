import { marked, type Tokens } from 'marked'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx'

type BuildWordOptions = {
  markdown: string
  title: string
  includeMedia: boolean
  includeName?: boolean
}

const HEADING_LEVELS: Array<typeof HeadingLevel[keyof typeof HeadingLevel]> = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
]

function inlineRuns(tokens: Tokens.Generic[] | undefined, base: IRunOptions = {}): TextRun[] {
  if (!tokens || !tokens.length) return []
  const runs: TextRun[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        runs.push(new TextRun({ ...base, text: (token as Tokens.Text).text }))
        break
      case 'strong':
        runs.push(...inlineRuns((token as Tokens.Strong).tokens ?? [], { ...base, bold: true }))
        break
      case 'em':
        runs.push(...inlineRuns((token as Tokens.Em).tokens ?? [], { ...base, italics: true }))
        break
      case 'codespan':
        runs.push(new TextRun({ ...base, text: (token as Tokens.Codespan).text, font: 'Consolas' }))
        break
      case 'del':
        runs.push(...inlineRuns((token as Tokens.Del).tokens ?? [], { ...base, strike: true }))
        break
      case 'link': {
        const link = token as Tokens.Link
        const children = inlineRuns(link.tokens ?? [], { ...base, color: '2563EB', underline: {} })
        runs.push(...(children.length ? children : [new TextRun({ ...base, text: link.href, color: '2563EB' })]))
        break
      }
      case 'br':
        runs.push(new TextRun({ ...base, text: '', break: 1 }))
        break
      default: {
        const generic = token as { text?: string }
        if (typeof generic.text === 'string') {
          runs.push(new TextRun({ ...base, text: generic.text }))
        }
      }
    }
  }
  return runs
}

function listItemParagraphs(token: Tokens.List): Paragraph[] {
  const paragraphs: Paragraph[] = []
  for (const item of token.items) {
    const children: ParagraphChild[] = inlineRuns(item.tokens?.filter((t) => t.type !== 'list') ?? [])
    paragraphs.push(new Paragraph({
      children: children.length ? children : [new TextRun({ text: item.text })],
      bullet: token.ordered ? undefined : { level: 0 },
      numbering: token.ordered ? { reference: 'kition-ordered', level: 0 } : undefined,
    }))
    for (const nested of item.tokens ?? []) {
      if (nested.type === 'list') {
        paragraphs.push(...listItemParagraphs(nested as Tokens.List))
      }
    }
  }
  return paragraphs
}

function tableFromToken(token: Tokens.Table): Table {
  const rows: TableRow[] = []
  const header = new TableRow({
    children: token.header.map((cell) => new TableCell({
      children: [new Paragraph({ children: inlineRuns(cell.tokens, { bold: true }) })],
    })),
    tableHeader: true,
  })
  rows.push(header)
  for (const row of token.rows) {
    rows.push(new TableRow({
      children: row.map((cell) => new TableCell({
        children: [new Paragraph({ children: inlineRuns(cell.tokens) })],
      })),
    }))
  }
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  })
}

function tokensToBlocks(tokens: Tokens.Generic[]): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading
        const level = HEADING_LEVELS[Math.min(heading.depth, 6) - 1]
        blocks.push(new Paragraph({
          heading: level,
          children: inlineRuns(heading.tokens ?? []),
        }))
        break
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph
        blocks.push(new Paragraph({ children: inlineRuns(paragraph.tokens ?? []) }))
        break
      }
      case 'list':
        blocks.push(...listItemParagraphs(token as Tokens.List))
        break
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        const innerRuns: TextRun[] = []
        for (const child of quote.tokens ?? []) {
          if (child.type === 'paragraph') {
            innerRuns.push(...inlineRuns((child as Tokens.Paragraph).tokens ?? [], { italics: true, color: '4B5563' }))
            innerRuns.push(new TextRun({ text: '', break: 1 }))
          } else {
            const generic = child as { text?: string }
            if (typeof generic.text === 'string' && generic.text.trim()) {
              innerRuns.push(new TextRun({ text: generic.text, italics: true, color: '4B5563', break: 1 }))
            }
          }
        }
        if (innerRuns.length) {
          blocks.push(new Paragraph({
            children: innerRuns,
            indent: { left: 360 },
            border: { left: { color: 'D1D5DB', size: 12, space: 8, style: BorderStyle.SINGLE } },
          }))
        }
        break
      }
      case 'code': {
        const code = token as Tokens.Code
        for (const line of code.text.split('\n')) {
          blocks.push(new Paragraph({
            children: [new TextRun({ text: line, font: 'Consolas' })],
            shading: { fill: 'F3F4F6', type: 'clear', color: 'auto' },
          }))
        }
        break
      }
      case 'table':
        blocks.push(tableFromToken(token as Tokens.Table))
        break
      case 'hr':
        blocks.push(new Paragraph({
          children: [],
          border: { bottom: { color: 'D1D5DB', size: 6, space: 1, style: BorderStyle.SINGLE } },
        }))
        break
      case 'space':
        blocks.push(new Paragraph({ children: [] }))
        break
      default: {
        const generic = token as { text?: string }
        if (typeof generic.text === 'string' && generic.text.trim()) {
          blocks.push(new Paragraph({ children: [new TextRun({ text: generic.text })] }))
        }
      }
    }
  }
  return blocks
}

export async function buildWordExportBlob(options: BuildWordOptions): Promise<Blob> {
  const tokens = marked.lexer(options.markdown || '')
  const blocks = tokensToBlocks(tokens)

  if (options.includeName && options.title) {
    blocks.unshift(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: options.title, bold: true })],
    }))
  }

  if (!blocks.length) {
    blocks.push(new Paragraph({ children: [] }))
  }

  const doc = new Document({
    creator: 'Kition',
    title: options.title || 'Kition Export',
    numbering: {
      config: [{
        reference: 'kition-ordered',
        levels: [{
          level: 0,
          format: 'decimal',
          text: '%1.',
          alignment: AlignmentType.LEFT,
        }],
      }],
    },
    sections: [{ children: blocks }],
  })

  return Packer.toBlob(doc)
}
