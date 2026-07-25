import type { IndexableDoc, NoteAnchor } from '../types'

export const NOTE_SOURCE_VERSION = '1'

/** Strips fenced code-block contents but preserves line offsets by replacing with blank lines. */
function maskCodeBlocks(content: string): string {
  const lines = content.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      lines[i] = ''
      continue
    }
    if (inFence) lines[i] = ''
  }
  return lines.join('\n')
}

export type NoteSourceInput = { vaultPath: string; content: string }

export function extractNoteDocs(input: NoteSourceInput): IndexableDoc[] {
  const { vaultPath, content } = input
  const masked = maskCodeBlocks(content)
  const lines = masked.split('\n')
  const rawLines = content.split('\n')
  const title = vaultPath.replace(/\.[^./]+$/, '').split('/').pop() ?? vaultPath

  type Para = { line: number; text: string; section?: string }
  const paragraphs: Para[] = []
  const sectionStack: string[] = []
  let current: Para | null = null

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const headingMatch = ln.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (headingMatch) {
      if (current) { paragraphs.push(current); current = null }
      const depth = headingMatch[1].length
      const text = headingMatch[2].trim()
      sectionStack.length = depth - 1
      sectionStack[depth - 1] = text
      continue
    }
    if (ln.trim() === '') {
      if (current) { paragraphs.push(current); current = null }
      continue
    }
    if (!current) {
      current = { line: i, text: ln, section: sectionStack.filter(Boolean).join(' › ') || undefined }
    } else {
      current.text += '\n' + ln
    }
  }
  if (current) paragraphs.push(current)

  // Empty or heading-only files: emit a single title-only doc so the filename
  // is still searchable. Without this, brand-new "Untitled note N.md" (0 bytes)
  // would have zero index entries and "Untitled" wouldn't match by title either.
  if (paragraphs.length === 0) {
    return [{
      id: `note:${vaultPath}:0:0`,
      kind: 'note' as const,
      vaultPath,
      title,
      body: '',
      tags: [],
      anchor: { kind: 'note', line: 0, ch: 0 },
    }]
  }

  const tagRegex = /(^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g
  const blockRegex = /\s\^([A-Za-z0-9_-]+)\s*$/

  return paragraphs.map((p, idx) => {
    const body = rawLines.slice(p.line, p.line + p.text.split('\n').length).join('\n')
    const tags: string[] = []
    let m: RegExpExecArray | null
    tagRegex.lastIndex = 0
    while ((m = tagRegex.exec(body)) !== null) {
      tags.push(m[2])
    }
    const blockMatch = body.match(blockRegex)
    const blockId = blockMatch?.[1]

    const firstLineTrim = body.split('\n')[0].trim()
    if (/^- \[ \]\s/.test(firstLineTrim)) tags.push('__task__', '__task_todo__')
    if (/^- \[x\]\s/i.test(firstLineTrim)) tags.push('__task__', '__task_done__')

    const anchor: NoteAnchor = {
      kind: 'note',
      line: p.line,
      ch: 0,
      blockId,
      section: p.section,
    }

    return {
      id: `note:${vaultPath}:${p.line}:${idx}`,
      kind: 'note' as const,
      vaultPath,
      title,
      body,
      tags,
      anchor,
    }
  })
}
