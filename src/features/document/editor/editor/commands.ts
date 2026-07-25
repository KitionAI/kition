   
                  
  
                                                            
                             
  
        
                                                   
                                                 
   

import type { ChangeSpec, EditorState, SelectionRange } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { foldEffect, unfoldAll } from '@codemirror/language'

import { parseWikilinks } from '../lib/wikilink-parser'

type Command = (view: EditorView) => boolean

function dispatchChanges(
  view: EditorView,
  build: (
    range: SelectionRange,
    state: EditorState,
  ) => { changes: ChangeSpec; range: SelectionRange },
): boolean {
  const transaction = view.state.changeByRange((range) => build(range, view.state))
  view.dispatch(transaction)
  view.focus()
  return true
}

                                                              

export function toggleInlineMark(open: string, close: string = open): Command {
  return (view) =>
    dispatchChanges(view, (range, state) => {
      const { from, to } = range
      if (from === to) {
        const insert = open + close
        return {
          changes: { from, insert },
          range: EditorSelection.cursor(from + open.length),
        }
      }

      const selected = state.doc.sliceString(from, to)
      const before = state.doc.sliceString(Math.max(0, from - open.length), from)
      const after = state.doc.sliceString(to, Math.min(state.doc.length, to + close.length))

      if (before === open && after === close) {
        return {
          changes: { from: from - open.length, to: to + close.length, insert: selected },
          range: EditorSelection.range(from - open.length, to - open.length),
        }
      }

      const insert = open + selected + close
      return {
        changes: { from, to, insert },
        range: EditorSelection.range(from + open.length, to + open.length),
      }
    })
}

export const toggleBold = toggleInlineMark('**')
export const toggleItalic = toggleInlineMark('*')
export const toggleStrike = toggleInlineMark('~~')
export const toggleInlineCode = toggleInlineMark('`')

                                                    

function eachSelectedLine(
  state: EditorState,
  range: SelectionRange,
): { from: number; to: number; text: string; number: number }[] {
  const startLine = state.doc.lineAt(range.from)
  const endLine = state.doc.lineAt(range.to)
  const lines: { from: number; to: number; text: string; number: number }[] = []
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n)
    lines.push({ from: line.from, to: line.to, text: line.text, number: n })
  }
  return lines
}

export function setLineHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): Command {
  return (view) =>
    dispatchChanges(view, (range, state) => {
      const lines = eachSelectedLine(state, range)
      const changes: ChangeSpec[] = []
      let shift = 0
      for (const line of lines) {
        const stripped = line.text.replace(/^#{1,6}\s+/, '')
        const next = level === 0 ? stripped : '#'.repeat(level) + ' ' + stripped
        changes.push({ from: line.from, to: line.to, insert: next })
        shift += next.length - line.text.length
      }
      return {
        changes,
        range: EditorSelection.range(range.from, range.to + shift),
      }
    })
}

export function toggleLinePrefix(prefix: string): Command {
  return (view) =>
    dispatchChanges(view, (range, state) => {
      const lines = eachSelectedLine(state, range)
      const allHave = lines.every((l) => l.text.startsWith(prefix))
      const changes: ChangeSpec[] = []
      let shift = 0
      for (const line of lines) {
        if (allHave) {
          changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
          shift -= prefix.length
        } else if (!line.text.startsWith(prefix)) {
          changes.push({ from: line.from, insert: prefix })
          shift += prefix.length
        }
      }
      return {
        changes,
        range: EditorSelection.range(range.from, range.to + shift),
      }
    })
}

export const toggleBulletList = toggleLinePrefix('- ')
export const toggleQuote = toggleLinePrefix('> ')
export const toggleTodoList = toggleLinePrefix('- [ ] ')

export const toggleOrderedList: Command = (view) =>
  dispatchChanges(view, (range, state) => {
    const lines = eachSelectedLine(state, range)
    const allHave = lines.every((l) => /^\d+\.\s/.test(l.text))
    const changes: ChangeSpec[] = []
    let shift = 0
    let n = 1
    for (const line of lines) {
      if (allHave) {
        const match = line.text.match(/^\d+\.\s/)
        if (match) {
          changes.push({ from: line.from, to: line.from + match[0].length, insert: '' })
          shift -= match[0].length
        }
      } else if (!/^\d+\.\s/.test(line.text)) {
        const prefix = `${n}. `
        changes.push({ from: line.from, insert: prefix })
        shift += prefix.length
        n += 1
      } else {
        n += 1
      }
    }
    return {
      changes,
      range: EditorSelection.range(range.from, range.to + shift),
    }
  })

                               

function insertAtCursor(view: EditorView, text: string, cursorOffset: number = text.length): boolean {
  return dispatchChanges(view, (range) => ({
    changes: { from: range.from, to: range.to, insert: text },
    range: EditorSelection.cursor(range.from + cursorOffset),
  }))
}

function ensureBlockBoundary(view: EditorView, body: string, cursorOffsetInBody: number): boolean {
  return dispatchChanges(view, (range, state) => {
    const line = state.doc.lineAt(range.from)
    const needsLeading = line.from !== range.from || line.text.length > 0
    const trailingChar = state.doc.sliceString(range.to, Math.min(state.doc.length, range.to + 1))
    const needsTrailing = trailingChar !== '\n' && range.to !== state.doc.length

    const leading = needsLeading ? '\n\n' : ''
    const trailing = needsTrailing ? '\n\n' : ''
    const insert = leading + body + trailing
    const cursorAt = range.from + leading.length + cursorOffsetInBody
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(cursorAt),
    }
  })
}

export function insertCodeBlock(lang: string = ''): Command {
  return (view) => {
    const body = '```' + lang + '\n\n```'
    const cursorAt = 3 + lang.length + 1
    return ensureBlockBoundary(view, body, cursorAt)
  }
}

export function insertTable(rows: number = 3, cols: number = 3): Command {
  return (view) => {
    const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |'
    const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |'
    const bodyRows = Array.from(
      { length: Math.max(0, rows - 1) },
      () => '| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |',
    )
    const body = [header, sep, ...bodyRows].join('\n')
    return ensureBlockBoundary(view, body, header.length + 1 + sep.length + 1 + 2)
  }
}

export function insertLink(url?: string, text?: string): Command {
  return (view) => {
    const linkText = text ?? ''
    const linkUrl = url ?? ''
    return dispatchChanges(view, (range, state) => {
      const selected = state.doc.sliceString(range.from, range.to)
      const finalText = selected || linkText || 'link text'
      const insert = `[${finalText}](${linkUrl})`
      const cursorAt = range.from + 1 + finalText.length + 2
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(cursorAt),
      }
    })
  }
}

export function insertImage(url?: string, alt?: string): Command {
  return (view) => {
    const insert = `![${alt ?? ''}](${url ?? ''})`
    const cursorAt = url ? insert.length : insert.length - 1
    return insertAtCursor(view, insert, cursorAt)
  }
}

export function insertCallout(type: string = 'note'): Command {
  return (view) => {
    const body = `> [!${type}]\n> `
    return ensureBlockBoundary(view, body, body.length)
  }
}

export function insertTOC(): Command {
  return (view) => ensureBlockBoundary(view, '[TOC]', 5)
}

export function insertWikilink(target: string = ''): Command {
  return (view) => {
    const insert = `[[${target}]]`
    const cursorAt = target ? insert.length : insert.length - 2
    return insertAtCursor(view, insert, cursorAt)
  }
}

export function insertEmbed(target: string = ''): Command {
  return (view) => {
    const insert = `![[${target}]]`
    const cursorAt = target ? insert.length : insert.length - 2
    return insertAtCursor(view, insert, cursorAt)
  }
}

export function insertTag(name: string = ''): Command {
  return (view) => {
    const insert = `#${name}`
    return insertAtCursor(view, insert, insert.length)
  }
}

export function insertHighlight(): Command {
  return (view) => {
    return dispatchChanges(view, (range) => {
      const selected = view.state.sliceDoc(range.from, range.to)
      if (selected.length === 0) {
        const placeholder = 'Highlight'
        return {
          changes: { from: range.from, to: range.to, insert: `==${placeholder}==` },
          range: EditorSelection.range(range.from + 2, range.from + 2 + placeholder.length),
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: `==${selected}==` },
        range: EditorSelection.cursor(range.from + selected.length + 4),
      }
    })
  }
}

export function insertComment(): Command {
  return (view) => {
    return dispatchChanges(view, (range) => {
      const selected = view.state.sliceDoc(range.from, range.to)
      if (selected.length === 0) {
        const placeholder = 'Comment'
        return {
          changes: { from: range.from, to: range.to, insert: `%%${placeholder}%%` },
          range: EditorSelection.range(range.from + 2, range.from + 2 + placeholder.length),
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: `%%${selected}%%` },
        range: EditorSelection.cursor(range.from + selected.length + 4),
      }
    })
  }
}

export function insertMath(): Command {
  return (view) => {
    return dispatchChanges(view, (range) => {
      const selected = view.state.sliceDoc(range.from, range.to)
      if (selected.length === 0) {
        const placeholder = 'x^2'
        return {
          changes: { from: range.from, to: range.to, insert: `$${placeholder}$` },
          range: EditorSelection.range(range.from + 1, range.from + 1 + placeholder.length),
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: `$${selected}$` },
        range: EditorSelection.cursor(range.from + selected.length + 2),
      }
    })
  }
}

export function insertMathBlock(): Command {
  return (view) => ensureBlockBoundary(view, '$$\n\n$$', 3)
}

export function insertHorizontalRule(): Command {
  return (view) => ensureBlockBoundary(view, '---', 3)
}

                                          

   
                                                
                             
   
export function shiftHeadingLevel(delta: number): Command {
  return (view) =>
    dispatchChanges(view, (range, state) => {
      const lines = eachSelectedLine(state, range)
      const changes: ChangeSpec[] = []
      let shift = 0
      for (const line of lines) {
        const match = line.text.match(/^(#{1,6})\s+(.*)$/)
        const currentLevel = match ? match[1].length : 0
        const rest = match ? match[2] : line.text
        const target = Math.max(0, Math.min(6, currentLevel + delta))
        const next = target === 0 ? rest : '#'.repeat(target) + ' ' + rest
        changes.push({ from: line.from, to: line.to, insert: next })
        shift += next.length - line.text.length
      }
      return {
        changes,
        range: EditorSelection.range(range.from, range.to + shift),
      }
    })
}

export const promoteHeading = shiftHeadingLevel(-1)
export const demoteHeading = shiftHeadingLevel(1)

   
            
  
                               
                              
                                  
  
                             
   
export const toggleTaskCheckbox: Command = (view) =>
  dispatchChanges(view, (range, state) => {
    const lines = eachSelectedLine(state, range)
    const allChecked = lines.every((l) => /^\s*(?:[-*+]|\d+\.)\s+\[[xX]\]\s/.test(l.text))
    const changes: ChangeSpec[] = []
    let shift = 0
    for (const line of lines) {
      const original = line.text
      let next = original
      const checked = original.match(/^(\s*(?:[-*+]|\d+\.)\s+\[)[xX](\]\s)/)
      const unchecked = original.match(/^(\s*(?:[-*+]|\d+\.)\s+\[) (\]\s)/)
      const bulletNoBox = original.match(/^(\s*(?:[-*+]|\d+\.)\s+)(?!\[[xX ]\]\s)(.*)$/)
      if (allChecked && checked) {
        next = original.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)[xX](\]\s)/, '$1 $2')
      } else if (checked) {
                                      
        next = original
      } else if (unchecked) {
        next = original.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[) (\]\s)/, '$1x$2')
      } else if (bulletNoBox) {
        next = bulletNoBox[1] + '[ ] ' + bulletNoBox[2]
      } else {
        const indentMatch = original.match(/^(\s*)/)
        const indent = indentMatch ? indentMatch[1] : ''
        next = indent + '- [ ] ' + original.slice(indent.length)
      }
      if (next !== original) {
        changes.push({ from: line.from, to: line.to, insert: next })
        shift += next.length - original.length
      }
    }
    return {
      changes,
      range: EditorSelection.range(range.from, range.to + shift),
    }
  })

                                                          

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, '0')
}

                          
export function insertDate(): Command {
  return (view) => {
    const d = new Date()
    const text = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return dispatchChanges(view, (range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    }))
  }
}

                                
export function insertTimestamp(): Command {
  return (view) => {
    const d = new Date()
    const text =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    return dispatchChanges(view, (range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    }))
  }
}

                                          
export const stripFrontmatter: Command = (view) => {
  const doc = view.state.doc
  const head = doc.sliceString(0, Math.min(doc.length, 4))
  if (!head.startsWith('---')) return false
  const first = doc.line(1)
  if (first.text.trim() !== '---') return false
  let endLine = -1
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') {
      endLine = i
      break
    }
  }
  if (endLine < 0) return false
  let cut = doc.line(endLine).to
             
  while (cut < doc.length) {
    const next = doc.lineAt(cut + 1)
    if (next.text.trim() === '') {
      cut = next.to
    } else {
      break
    }
  }
                     
  const removeTo = Math.min(doc.length, cut + 1)
  view.dispatch({
    changes: { from: 0, to: removeTo, insert: '' },
    selection: EditorSelection.cursor(0),
  })
  return true
}

                             
export function transformCase(mode: 'upper' | 'lower' | 'title' | 'sentence'): Command {
  return (view) =>
    dispatchChanges(view, (range, state) => {
      if (range.empty) return { changes: [], range }
      const text = state.doc.sliceString(range.from, range.to)
      let next: string
      switch (mode) {
        case 'upper':
          next = text.toUpperCase()
          break
        case 'lower':
          next = text.toLowerCase()
          break
        case 'title':
          next = text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
          break
        case 'sentence':
                               
          next = text
            .toLowerCase()
            .replace(/(^|\p{Sentence_Terminal}\s+)([a-z])/gu, (_, p, c) => p + c.toUpperCase())
          break
      }
      return {
        changes: { from: range.from, to: range.to, insert: next },
        range: EditorSelection.range(range.from, range.from + next.length),
      }
    })
}

                                  

type ListKind = 'none' | 'bullet' | 'ordered' | 'todo'

function detectListKind(text: string): { kind: ListKind; indent: string; rest: string } {
  const todo = text.match(/^(\s*)(?:[-*+])\s+\[[xX ]\]\s+(.*)$/)
  if (todo) return { kind: 'todo', indent: todo[1], rest: todo[2] }
  const ordered = text.match(/^(\s*)\d+\.\s+(.*)$/)
  if (ordered) return { kind: 'ordered', indent: ordered[1], rest: ordered[2] }
  const bullet = text.match(/^(\s*)[-*+]\s+(.*)$/)
  if (bullet) return { kind: 'bullet', indent: bullet[1], rest: bullet[2] }
  const plain = text.match(/^(\s*)(.*)$/)
  return {
    kind: 'none',
    indent: plain ? plain[1] : '',
    rest: plain ? plain[2] : text,
  }
}

function nextListKind(k: ListKind): ListKind {
  if (k === 'none') return 'bullet'
  if (k === 'bullet') return 'ordered'
  if (k === 'ordered') return 'todo'
  return 'none'
}

function renderListLine(kind: ListKind, indent: string, rest: string, n: number): string {
  if (kind === 'bullet') return `${indent}- ${rest}`
  if (kind === 'ordered') return `${indent}${n}. ${rest}`
  if (kind === 'todo') return `${indent}- [ ] ${rest}`
  return `${indent}${rest}`
}

   
                                                    
                               
   
export const cycleListType: Command = (view) =>
  dispatchChanges(view, (range, state) => {
    const lines = eachSelectedLine(state, range)
    if (lines.length === 0) return { changes: [], range }
    const first = detectListKind(lines[0].text)
    const target = nextListKind(first.kind)
    const changes: ChangeSpec[] = []
    let shift = 0
    let n = 1
    for (const line of lines) {
      if (line.text.trim() === '') continue
      const parsed = detectListKind(line.text)
      const next = renderListLine(target, parsed.indent, parsed.rest, n)
      if (target === 'ordered') n += 1
      if (next !== line.text) {
        changes.push({ from: line.from, to: line.to, insert: next })
        shift += next.length - line.text.length
      }
    }
    return {
      changes,
      range: EditorSelection.range(range.from, range.to + shift),
    }
  })

                                   
export const sortSelectedLines: Command = (view) => {
  const state = view.state
  const range = state.selection.main
  const from = state.doc.lineAt(range.from).from
  const to = state.doc.lineAt(range.to).to
  if (from === to) return false
  const block = state.doc.sliceString(from, to)
  const lines = block.split('\n')
  if (lines.length < 2) return false
  const sorted = [...lines].sort((a, b) => a.localeCompare(b))
  if (sorted.every((l, i) => l === lines[i])) return false
  view.dispatch({
    changes: { from, to, insert: sorted.join('\n') },
    selection: EditorSelection.range(from, from + sorted.join('\n').length),
  })
  return true
}

const HEADING_RE = /^(\s*)(#{1,6})\s+(?:(\d+(?:\.\d+)*)(?:\.)?\s+)?(.*)$/

   
                                       
                                 
                             
   
export const numberHeadings: Command = (view) => {
  return applyHeadingNumbering(view, true)
}

                   
export const stripHeadingNumbers: Command = (view) => {
  return applyHeadingNumbering(view, false)
}

function applyHeadingNumbering(view: EditorView, number: boolean): boolean {
  const doc = view.state.doc
  const counters: number[] = [0, 0, 0, 0, 0, 0]
  const edits: { from: number; to: number; insert: string }[] = []
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = HEADING_RE.exec(text)
    if (!m) continue
    const [, indent, hashes, , rest] = m
    const level = hashes.length
    let next: string
    if (number) {
      counters[level - 1] += 1
      for (let j = level; j < 6; j++) counters[j] = 0
      const parts = counters.slice(0, level).join('.')
      next = `${indent}${hashes} ${parts} ${rest}`
    } else {
      next = `${indent}${hashes} ${rest}`
    }
    if (next !== text) {
      edits.push({ from: line.from, to: line.to, insert: next })
    }
  }
  if (edits.length === 0) return false
  view.dispatch({ changes: edits, userEvent: 'input.heading-number' })
  return true
}

                                                       

const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g

   
                                       
                                      
                                               
                                                                                            
                               
                             
   
export const convertLinkUnderCursor: Command = (view) => {
  const state = view.state
  const pos = state.selection.main.from
  const line = state.doc.lineAt(pos)
  // 1) wikilink
  const wikis = parseWikilinks(line.text)
  for (const w of wikis) {
    if (w.embed) continue
    const absFrom = line.from + w.from
    const absTo = line.from + w.to
    if (pos < absFrom || pos > absTo) continue
    const display = w.display ?? w.target
    const target = w.target.replace(/\.md$/i, '') + '.md'
    const replacement = `[${display}](${encodeURI(target)})`
    view.dispatch({
      changes: { from: absFrom, to: absTo, insert: replacement },
      selection: EditorSelection.cursor(absFrom + replacement.length),
      userEvent: 'input.convert-link',
    })
    return true
  }
  // 2) markdown link
  MD_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MD_LINK_RE.exec(line.text)) !== null) {
    const absFrom = line.from + m.index
    const absTo = absFrom + m[0].length
    if (pos < absFrom || pos > absTo) continue
    const [, text, url] = m
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return false
    const decoded = decodeURI(url).replace(/\.md$/i, '')
    const basename = decoded.split('/').pop() ?? decoded
    const inner = text === decoded || text === basename ? decoded : `${decoded}|${text}`
    const replacement = `[[${inner}]]`
    view.dispatch({
      changes: { from: absFrom, to: absTo, insert: replacement },
      selection: EditorSelection.cursor(absFrom + replacement.length),
      userEvent: 'input.convert-link',
    })
    return true
  }
  return false
}

                                        

const BLOCK_ID_TAIL_RE = /\s\^([A-Za-z0-9_-]+)\s*$/
const HEADING_LINE_RE = /^\s*(#{1,6})\s+(.+?)\s*$/

function generateBlockId(): string {
                                 
  return Math.random().toString(36).slice(2, 8)
}

                                   
export function getBlockIdAtCursor(view: EditorView): string | null {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const m = line.text.match(BLOCK_ID_TAIL_RE)
  return m ? m[1] : null
}

                                       
export function getHeadingAtCursor(view: EditorView): string | null {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const m = line.text.match(HEADING_LINE_RE)
  return m ? m[2] : null
}

   
                           
                      
   
export function ensureBlockIdAtCursor(view: EditorView): string {
  const state = view.state
  const line = state.doc.lineAt(state.selection.main.from)
  const existing = line.text.match(BLOCK_ID_TAIL_RE)
  if (existing) return existing[1]
  const id = generateBlockId()
  const needsSpace = line.text.endsWith(' ') ? '' : ' '
  view.dispatch({
    changes: { from: line.to, insert: `${needsSpace}^${id}` },
    userEvent: 'input.block-id',
  })
  return id
}

                                    

   
                                    
                                   
                               
                            
                            
                         
   
export function foldHeadingsBelowLevel(level: number): Command {
  return (view) => {
    if (level < 1 || level > 5) return false
                 
    unfoldAll(view)
    const doc = view.state.doc
    const ranges: { from: number; to: number }[] = []
    let inFence = false
    type HeadingPos = { lineNo: number; level: number; lineTo: number; lineFrom: number }
    const headings: HeadingPos[] = []
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i)
      const text = line.text
      if (/^\s*```/.test(text)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = text.match(/^(#{1,6})\s+/)
      if (!m) continue
      headings.push({ lineNo: i, level: m[1].length, lineTo: line.to, lineFrom: line.from })
    }
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]
      if (h.level <= level) continue
      // find end: next heading with level <= h.level
      let endPos = doc.length
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) {
          endPos = headings[j].lineFrom - 1
          break
        }
      }
      if (endPos > h.lineTo) {
        ranges.push({ from: h.lineTo, to: endPos })
      }
    }
    if (ranges.length === 0) return false
    view.dispatch({
      effects: ranges.map((r) => foldEffect.of(r)),
    })
    return true
  }
}

                                        

const HEADING_LINE_PATTERN = /^(#{1,6})\s+/

type SectionBounds = {
  headingLineNo: number
  headingLevel: number
  endLineNo: number
}

function findCurrentSection(state: EditorState): SectionBounds | null {
  const doc = state.doc
  const startNo = doc.lineAt(state.selection.main.from).number
  let inFence = false
  // Walk backwards looking for the heading that governs this position
  const fences: number[] = []
  for (let i = 1; i <= startNo; i++) {
    if (/^\s*```/.test(doc.line(i).text)) fences.push(i)
  }
  function isInFence(lineNo: number): boolean {
    // count fences strictly before lineNo
    let count = 0
    for (const f of fences) {
      if (f < lineNo) count += 1
      else break
    }
    return count % 2 === 1
  }
  let headingLineNo = -1
  let headingLevel = 0
  for (let i = startNo; i >= 1; i--) {
    if (isInFence(i)) continue
    const m = doc.line(i).text.match(HEADING_LINE_PATTERN)
    if (m) {
      headingLineNo = i
      headingLevel = m[1].length
      break
    }
  }
  if (headingLineNo === -1) return null
  // Walk forward for section end (next heading with level ≤ headingLevel)
  let endLineNo = -1
  inFence = false
  for (let i = headingLineNo + 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = text.match(HEADING_LINE_PATTERN)
    if (m && m[1].length <= headingLevel) {
      endLineNo = i - 1
      break
    }
  }
  if (endLineNo === -1) {
    // No next heading — end is the last non-empty line
    endLineNo = doc.lines
    while (endLineNo > headingLineNo && doc.line(endLineNo).text === '') endLineNo -= 1
  }
  return { headingLineNo, headingLevel, endLineNo }
}

   
                         
                             
   
export const moveSectionUp: Command = (view) => {
  const state = view.state
  const cur = findCurrentSection(state)
  if (!cur) return false
  const doc = state.doc
  // find previous sibling
  let prevHeadingLineNo = -1
  let inFence = false
  // build fence position list from top up to cur.headingLineNo - 1
  for (let i = 1; i <= cur.headingLineNo - 1; i++) {
    if (/^\s*```/.test(doc.line(i).text)) inFence = !inFence
  }
  // now walk back, tracking fence state inversely
  for (let i = cur.headingLineNo - 1; i >= 1; i--) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = text.match(HEADING_LINE_PATTERN)
    if (!m) continue
    if (m[1].length < cur.headingLevel) return false // hit parent
    if (m[1].length === cur.headingLevel) {
      prevHeadingLineNo = i
      break
    }
  }
  if (prevHeadingLineNo === -1) return false
  const prevHeadingStart = doc.line(prevHeadingLineNo).from
  const prevSectionEnd = doc.line(cur.headingLineNo - 1).to
  const curHeadingStart = doc.line(cur.headingLineNo).from
  const curSectionEnd = doc.line(cur.endLineNo).to
  const prevText = doc.sliceString(prevHeadingStart, prevSectionEnd)
  const curText = doc.sliceString(curHeadingStart, curSectionEnd)
  const newText = curText + '\n' + prevText
  view.dispatch({
    changes: { from: prevHeadingStart, to: curSectionEnd, insert: newText },
    selection: EditorSelection.cursor(prevHeadingStart),
    userEvent: 'move.section',
  })
  return true
}

                        
export const moveSectionDown: Command = (view) => {
  const state = view.state
  const cur = findCurrentSection(state)
  if (!cur) return false
  const doc = state.doc
  const nextStartLineNo = cur.endLineNo + 1
  if (nextStartLineNo > doc.lines) return false
  const nextHeadingText = doc.line(nextStartLineNo).text
  const m = nextHeadingText.match(HEADING_LINE_PATTERN)
  if (!m) return false
  if (m[1].length !== cur.headingLevel) return false // parent or deeper

  let nextEndLineNo = -1
  let inFence = false
  for (let i = nextStartLineNo + 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m2 = text.match(HEADING_LINE_PATTERN)
    if (m2 && m2[1].length <= cur.headingLevel) {
      nextEndLineNo = i - 1
      break
    }
  }
  if (nextEndLineNo === -1) {
    nextEndLineNo = doc.lines
    while (nextEndLineNo > nextStartLineNo && doc.line(nextEndLineNo).text === '') nextEndLineNo -= 1
  }
  const curHeadingStart = doc.line(cur.headingLineNo).from
  const curSectionEnd = doc.line(cur.endLineNo).to
  const nextHeadingStart = doc.line(nextStartLineNo).from
  const nextSectionEnd = doc.line(nextEndLineNo).to
  const curText = doc.sliceString(curHeadingStart, curSectionEnd)
  const nextText = doc.sliceString(nextHeadingStart, nextSectionEnd)
  const newText = nextText + '\n' + curText
  view.dispatch({
    changes: { from: curHeadingStart, to: nextSectionEnd, insert: newText },
    selection: EditorSelection.cursor(curHeadingStart + nextText.length + 1),
    userEvent: 'move.section',
  })
  return true
}

                                         

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/

type ColAlign = 'left' | 'center' | 'right' | 'none'

type TableLocation = {
  startLine: number
  endLine: number
  separatorLine: number
  cursorRow: number // 0=header, 1=separator, ≥2=body
  cursorCol: number // 0-based column index
  cols: number
}

function parseRowCells(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map((c) => c.trim())
}

function alignsFromSep(sepLine: string): ColAlign[] {
  return parseRowCells(sepLine).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (left) return 'left'
    if (right) return 'right'
    return 'none'
  })
}

function serializeBodyRow(cells: string[]): string {
  return '| ' + cells.map((c) => c || ' ').join(' | ') + ' |'
}

function serializeSepRow(aligns: ColAlign[]): string {
  return (
    '| ' +
    aligns
      .map((a) => {
        if (a === 'left') return ':---'
        if (a === 'center') return ':---:'
        if (a === 'right') return '---:'
        return '---'
      })
      .join(' | ') +
    ' |'
  )
}

function findTableAtCursor(state: EditorState): TableLocation | null {
  const doc = state.doc
  const pos = state.selection.main.from
  const cursorLine = doc.lineAt(pos)
  if (!TABLE_LINE_RE.test(cursorLine.text)) return null
  let startLine = cursorLine.number
  while (startLine > 1 && TABLE_LINE_RE.test(doc.line(startLine - 1).text)) startLine -= 1
  let endLine = cursorLine.number
  while (endLine < doc.lines && TABLE_LINE_RE.test(doc.line(endLine + 1).text)) endLine += 1
  if (endLine < startLine + 1) return null
  const separatorLine = startLine + 1
  if (!TABLE_SEP_RE.test(doc.line(separatorLine).text)) return null
  const cols = parseRowCells(doc.line(startLine).text).length
  const cursorOffset = pos - cursorLine.from
  let pipeCount = 0
  for (let j = 0; j < cursorOffset; j++) {
    if (cursorLine.text[j] === '|') pipeCount += 1
  }
  let cursorCol = pipeCount - 1
  if (cursorCol < 0) cursorCol = 0
  if (cursorCol >= cols) cursorCol = cols - 1
  return {
    startLine,
    endLine,
    separatorLine,
    cursorRow: cursorLine.number - startLine,
    cursorCol,
    cols,
  }
}

function rewriteTable(
  view: EditorView,
  build: (rows: string[][], aligns: ColAlign[], loc: TableLocation) =>
    | { rows: string[][]; aligns: ColAlign[] }
    | null,
): boolean {
  const state = view.state
  const loc = findTableAtCursor(state)
  if (!loc) return false
  const doc = state.doc
  const rows: string[][] = []
  for (let i = loc.startLine; i <= loc.endLine; i++) {
    if (i === loc.separatorLine) continue
    rows.push(parseRowCells(doc.line(i).text))
  }
  const aligns = alignsFromSep(doc.line(loc.separatorLine).text)
  const result = build(rows, aligns, loc)
  if (!result) return false
  const colCount = result.aligns.length
  const normRows = result.rows.map((r) => {
    if (r.length < colCount) return [...r, ...Array(colCount - r.length).fill('')]
    if (r.length > colCount) return r.slice(0, colCount)
    return r
  })
  const lines: string[] = [
    serializeBodyRow(normRows[0]),
    serializeSepRow(result.aligns),
    ...normRows.slice(1).map(serializeBodyRow),
  ]
  view.dispatch({
    changes: {
      from: doc.line(loc.startLine).from,
      to: doc.line(loc.endLine).to,
      insert: lines.join('\n'),
    },
    userEvent: 'input.table',
  })
  return true
}

export function tableAddColumnRight(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    const at = loc.cursorCol + 1
    const newRows = rows.map((r) => {
      const copy = [...r]
      copy.splice(at, 0, '')
      return copy
    })
    const newAligns = [...aligns]
    newAligns.splice(at, 0, 'none')
    return { rows: newRows, aligns: newAligns }
  })
}

export function tableAddColumnLeft(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    const at = loc.cursorCol
    const newRows = rows.map((r) => {
      const copy = [...r]
      copy.splice(at, 0, '')
      return copy
    })
    const newAligns = [...aligns]
    newAligns.splice(at, 0, 'none')
    return { rows: newRows, aligns: newAligns }
  })
}

export function tableDeleteColumn(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    if (aligns.length <= 1) return null
    const at = loc.cursorCol
    const newRows = rows.map((r) => {
      const copy = [...r]
      copy.splice(at, 1)
      return copy
    })
    const newAligns = [...aligns]
    newAligns.splice(at, 1)
    return { rows: newRows, aligns: newAligns }
  })
}

export function tableAddRowBelow(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    let insertIndex = 1
    if (loc.cursorRow >= 2) insertIndex = loc.cursorRow - 1 + 1
    const blank = Array<string>(aligns.length).fill('')
    const newRows = [...rows]
    newRows.splice(insertIndex, 0, blank)
    return { rows: newRows, aligns }
  })
}

export function tableAddRowAbove(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    if (loc.cursorRow <= 1) return null
    const insertIndex = loc.cursorRow - 1
    const blank = Array<string>(aligns.length).fill('')
    const newRows = [...rows]
    newRows.splice(insertIndex, 0, blank)
    return { rows: newRows, aligns }
  })
}

export function tableDeleteRow(view: EditorView): boolean {
  return rewriteTable(view, (rows, aligns, loc) => {
    if (loc.cursorRow <= 1) return null
    if (rows.length <= 2) return null
    const at = loc.cursorRow - 1
    const newRows = [...rows]
    newRows.splice(at, 1)
    return { rows: newRows, aligns }
  })
}

export function tableAlignColumn(align: ColAlign): Command {
  return (view) =>
    rewriteTable(view, (rows, aligns, loc) => {
      const next = [...aligns]
      next[loc.cursorCol] = align
      return { rows, aligns: next }
    })
}

   
                        
                                              
                                  
   
export function tableSortByColumn(direction: 'asc' | 'desc' = 'asc'): Command {
  return (view) =>
    rewriteTable(view, (rows, aligns, loc) => {
      if (rows.length <= 2) return null
      const header = rows[0]
      const body = rows.slice(1)
      const col = loc.cursorCol
      const allNumbers = body.every((r) => {
        const v = (r[col] ?? '').trim()
        return v !== '' && !Number.isNaN(Number(v))
      })
      const sorted = [...body].sort((a, b) => {
        const av = (a[col] ?? '').trim()
        const bv = (b[col] ?? '').trim()
        if (allNumbers) return Number(av) - Number(bv)
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
      })
      if (direction === 'desc') sorted.reverse()
      return { rows: [header, ...sorted], aligns }
    })
}

                           
export function tableFormat(view: EditorView): boolean {
  const loc = findTableAtCursor(view.state)
  if (!loc) return false
  const doc = view.state.doc
  const rows: string[][] = []
  for (let i = loc.startLine; i <= loc.endLine; i++) {
    if (i === loc.separatorLine) continue
    rows.push(parseRowCells(doc.line(i).text))
  }
  const aligns = alignsFromSep(doc.line(loc.separatorLine).text)
  const cols = aligns.length
  const normRows = rows.map((r) => {
    if (r.length < cols) return [...r, ...Array<string>(cols - r.length).fill('')]
    if (r.length > cols) return r.slice(0, cols)
    return r
  })
  const widths = new Array<number>(cols).fill(3)
  for (const r of normRows) {
    for (let c = 0; c < cols; c++) widths[c] = Math.max(widths[c], r[c].length)
  }
  // ensure separator can fit alignment markers
  for (let c = 0; c < cols; c++) {
    const a = aligns[c]
    const min = a === 'center' ? 5 : a === 'left' || a === 'right' ? 4 : 3
    widths[c] = Math.max(widths[c], min)
  }

  function pad(text: string, w: number, align: ColAlign): string {
    if (align === 'right') return text.padStart(w, ' ')
    if (align === 'center') {
      const totalPad = w - text.length
      const left = Math.floor(totalPad / 2)
      return ' '.repeat(left) + text + ' '.repeat(totalPad - left)
    }
    return text.padEnd(w, ' ')
  }
  const headerLine =
    '| ' +
    normRows[0].map((c, i) => pad(c, widths[i], aligns[i])).join(' | ') +
    ' |'
  const sepLine =
    '| ' +
    aligns
      .map((a, i) => {
        const w = widths[i]
        if (a === 'left') return ':' + '-'.repeat(w - 1)
        if (a === 'right') return '-'.repeat(w - 1) + ':'
        if (a === 'center') return ':' + '-'.repeat(w - 2) + ':'
        return '-'.repeat(w)
      })
      .join(' | ') +
    ' |'
  const bodyLines = normRows
    .slice(1)
    .map((r) => '| ' + r.map((c, i) => pad(c, widths[i], aligns[i])).join(' | ') + ' |')
  view.dispatch({
    changes: {
      from: doc.line(loc.startLine).from,
      to: doc.line(loc.endLine).to,
      insert: [headerLine, sepLine, ...bodyLines].join('\n'),
    },
    userEvent: 'input.table',
  })
  return true
}

                               
export const insertFootnote: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const text = doc.toString()
  let maxId = 0
  const re = /\[\^(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > maxId) maxId = n
  }
  const id = maxId + 1
  const pos = state.selection.main.from
  const refInsert = `[^${id}]`
  const hasDefs = /^\[\^\d+\]:/m.test(text)
  const trailing = text.endsWith('\n') ? '' : '\n'
  const defInsert = `${trailing}${hasDefs ? '' : '\n'}[^${id}]: `
  view.dispatch({
    changes: [
      { from: pos, insert: refInsert },
      { from: doc.length, insert: defInsert },
    ],
    selection: EditorSelection.cursor(doc.length + refInsert.length + defInsert.length),
    userEvent: 'input.footnote',
  })
  return true
}

   
                                     
                                                    
   
export const jumpFootnote: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const pos = state.selection.main.head
  const line = doc.lineAt(pos)
  const lineText = line.text

                           
  const refRe = /\[\^([^\]\s]+)\](?!:)/g
  let mr: RegExpExecArray | null
  while ((mr = refRe.exec(lineText)) !== null) {
    const start = line.from + mr.index
    const end = start + mr[0].length
    if (pos >= start && pos <= end) {
      const id = mr[1]
      const target = findFootnoteDef(state, id)
      if (target == null) return false
      view.dispatch({
        selection: EditorSelection.cursor(target),
        effects: EditorView.scrollIntoView(target, { y: 'center' }),
      })
      return true
    }
  }

                            
  const defMatch = /^\[\^([^\]\s]+)\]:/.exec(lineText)
  if (defMatch && pos - line.from <= defMatch[0].length + 200) {
    const id = defMatch[1]
    const target = findFootnoteRef(state, id)
    if (target == null) return false
    view.dispatch({
      selection: EditorSelection.cursor(target),
      effects: EditorView.scrollIntoView(target, { y: 'center' }),
    })
    return true
  }

  return false
}

function findFootnoteDef(state: EditorState, id: string): number | null {
  const doc = state.doc
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    const m = /^\[\^([^\]\s]+)\]:/.exec(text)
    if (m && m[1] === id) return doc.line(i).from
  }
  return null
}

function findFootnoteRef(state: EditorState, id: string): number | null {
  const doc = state.doc
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    if (/^\[\^[^\]\s]+\]:/.test(line.text)) continue
    const re = /\[\^([^\]\s]+)\](?!:)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text)) !== null) {
      if (m[1] === id) return line.from + m.index
    }
  }
  return null
}

   
                           
                      
   
export const renumberFootnotes: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const text = doc.toString()

                                 
  const order: string[] = []
  const seen = new Set<string>()
  const allRefRe = /\[\^(\d+)\](?!:)/g
  let m: RegExpExecArray | null
  while ((m = allRefRe.exec(text)) !== null) {
    const id = m[1]
    if (!seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
  }
  if (order.length === 0) return false

  const mapping = new Map<string, string>()
  order.forEach((oldId, i) => mapping.set(oldId, String(i + 1)))

                           
  const alreadyOk = order.every((oldId, i) => oldId === String(i + 1))
  if (alreadyOk) return false

  const changes: ChangeSpec[] = []
  // refs `[^N]`
  const refScan = /\[\^(\d+)\](?!:)/g
  while ((m = refScan.exec(text)) !== null) {
    const newId = mapping.get(m[1])
    if (!newId || newId === m[1]) continue
    changes.push({ from: m.index, to: m.index + m[0].length, insert: `[^${newId}]` })
  }
                          
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const defMatch = /^\[\^(\d+)\]:/.exec(line.text)
    if (!defMatch) continue
    const newId = mapping.get(defMatch[1])
    if (!newId || newId === defMatch[1]) continue
    changes.push({
      from: line.from,
      to: line.from + defMatch[0].length,
      insert: `[^${newId}]:`,
    })
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'input.footnote.renumber' })
  return true
}

                                                                  
export const wrapAsWikilink: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    return insertWikilink()(view)
  }
  const selected = state.sliceDoc(main.from, main.to)
  if (selected.includes('\n')) return false
  const insert = `[[${selected}]]`
  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: EditorSelection.cursor(main.from + insert.length),
    userEvent: 'input.wikilink.wrap',
  })
  return true
}

                                 
export const wrapAsTag: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  let from = main.from
  let to = main.to
  if (main.empty) {
                            
    const line = state.doc.lineAt(main.from)
    const colInLine = main.from - line.from
    const text = line.text
    let start = colInLine
    while (start > 0 && /\S/.test(text[start - 1]) && text[start - 1] !== '#') start -= 1
    let end = colInLine
    while (end < text.length && /\S/.test(text[end])) end += 1
    if (start === end) return false
    from = line.from + start
    to = line.from + end
  }
  const raw = state.sliceDoc(from, to)
  if (raw.includes('\n') || raw.startsWith('#')) return false
                                      
  const normalized = raw.replace(/[^\p{L}\p{N}_\-/]+/gu, '-').replace(/^-+|-+$/g, '')
  if (!normalized) return false
  const insert = `#${normalized}`
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent: 'input.tag.wrap',
  })
  return true
}

                                    
export function convertSelectionToCallout(type: string = 'note'): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    const startLine = state.doc.lineAt(main.from)
    const endLine = state.doc.lineAt(main.to)
    const headLine = `> [!${type}]`
    const bodyLines: string[] = []
    for (let i = startLine.number; i <= endLine.number; i++) {
      const t = state.doc.line(i).text
      bodyLines.push(`> ${t}`)
    }
    const insert = [headLine, ...bodyLines].join('\n')
    view.dispatch({
      changes: { from: startLine.from, to: endLine.to, insert },
      selection: EditorSelection.cursor(startLine.from + insert.length),
      userEvent: 'input.callout.wrap',
    })
    return true
  }
}

                                            
export const unwrapLink: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const from = main.empty ? state.doc.lineAt(main.from).from : main.from
  const to = main.empty ? state.doc.lineAt(main.from).to : main.to
  const text = state.sliceDoc(from, to)
  if (!text) return false
                                                                                
  const replaced = text
    .replace(/!\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  if (replaced === text) return false
  view.dispatch({
    changes: { from, to, insert: replaced },
    selection: EditorSelection.cursor(from + replaced.length),
    userEvent: 'input.link.unwrap',
  })
  return true
}

                                                     
export const selectCurrentSection: Command = (view) => {
  const state = view.state
  const cur = findCurrentSection(state)
  if (!cur) return false
  const doc = state.doc
  const from = doc.line(cur.headingLineNo).from
  const to = doc.line(cur.endLineNo).to
  view.dispatch({ selection: EditorSelection.single(from, to) })
  return true
}

                                             
export const trimTrailingWhitespace: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const changes: ChangeSpec[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const trimmed = line.text.replace(/[ \t]+$/, '')
    if (trimmed !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: trimmed })
    }
  }
           
  const text = doc.toString()
  const trimEnd = text.replace(/\s+$/, '')
  if (trimEnd.length < text.length) {
    changes.push({ from: trimEnd.length, to: text.length, insert: text.endsWith('\n') ? '\n' : '' })
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'input.trim' })
  return true
}

                               
export const insertAsQuote: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const selected = state.sliceDoc(main.from, main.to)
  const wrapped = selected.split('\n').map((l) => `> ${l}`).join('\n')
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: wrapped },
    selection: EditorSelection.cursor(main.from + wrapped.length),
    userEvent: 'input.quote.wrap',
  })
  return true
}

                                      
export function wrapAsCodeBlock(lang: string = ''): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    if (main.empty) return false
    const selected = state.sliceDoc(main.from, main.to)
                                
    const insert = '```' + lang + '\n' + selected + (selected.endsWith('\n') ? '' : '\n') + '```'
    view.dispatch({
      changes: { from: main.from, to: main.to, insert },
      selection: EditorSelection.cursor(main.from + insert.length),
      userEvent: 'input.codeblock.wrap',
    })
    return true
  }
}

   
                        
                                      
   
export const duplicateLine: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  const blockText = state.sliceDoc(startLine.from, endLine.to)
  const insertPos = endLine.to
  const insert = '\n' + blockText
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert },
    selection: EditorSelection.cursor(main.head + insert.length),
    userEvent: 'input.duplicate',
  })
  return true
}

   
                 
                       
                    
   
export const joinLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  if (startLine.number === endLine.number) return false
  const text = state.sliceDoc(startLine.from, endLine.to)
                      
  const merged = text.split('\n').map((s, i) => i === 0 ? s.replace(/\s+$/, '') : s.replace(/^\s+/, '').replace(/\s+$/, '')).filter((s) => s.length > 0).join(' ')
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: merged },
    selection: EditorSelection.cursor(startLine.from + merged.length),
    userEvent: 'input.join',
  })
  return true
}

   
                                   
                 
   
export const splitSentencesToLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.sliceDoc(main.from, main.to)
                    
  const split = text.replace(/(\p{Sentence_Terminal})\s+/gu, '$1\n').replace(/\n{2,}/g, '\n')
  if (split === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: split },
    selection: EditorSelection.cursor(main.from + split.length),
    userEvent: 'input.split.sentences',
  })
  return true
}

   
                                     
               
                
                
                
                 
               
                          
   
export const applySmartTypography: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const from = main.empty ? 0 : main.from
  const to = main.empty ? state.doc.length : main.to
  const text = state.sliceDoc(from, to)
  const next = text
    .replace(/---/g, '—')
    .replace(/--/g, '—')
    .replace(/\.\.\./g, '…')
    .replace(/\(c\)/gi, '©')
    .replace(/\(r\)/gi, '®')
    .replace(/\(tm\)/gi, '™')
    .replace(/\+-/g, '±')
    .replace(/<<(?!=)/g, '«')
    .replace(/(?<!=)>>/g, '»')
  if (next === text) return false
  view.dispatch({
    changes: { from, to, insert: next },
    selection: main.empty
      ? EditorSelection.cursor(state.selection.main.head)
      : EditorSelection.cursor(from + next.length),
    userEvent: 'input.smart.typography',
  })
  return true
}

   
                      
                           
   
export const deleteCurrentLine: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  const from = startLine.from
  const to = endLine.number < state.doc.lines ? endLine.to + 1 : endLine.to
  if (from === to) return false
  view.dispatch({
    changes: { from, to: to <= state.doc.length ? to : state.doc.length, insert: '' },
    selection: EditorSelection.cursor(Math.min(from, state.doc.length - (to - from))),
    userEvent: 'delete.line',
  })
  return true
}

   
                               
   
export const compressBlankLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const from = main.empty ? 0 : main.from
  const to = main.empty ? state.doc.length : main.to
  const text = state.sliceDoc(from, to)
  const next = text.replace(/(\r?\n[ \t]*){3,}/g, '\n\n')
  if (next === text) return false
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.cursor(main.empty ? main.head : from + next.length),
    userEvent: 'input.compress.blanks',
  })
  return true
}

   
                                              
                                                  
   
export const sortTasks: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  if (startLine.number === endLine.number) return false
  const lines: string[] = []
  for (let i = startLine.number; i <= endLine.number; i++) {
    lines.push(state.doc.line(i).text)
  }
  const TASK_RE = /^(\s*[-*+]\s+)\[( |x|X)\](.*)$/
            
  const taskIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (TASK_RE.test(lines[i])) taskIndices.push(i)
  }
  if (taskIndices.length < 2) return false
  const open: string[] = []
  const done: string[] = []
  for (const idx of taskIndices) {
    const m = TASK_RE.exec(lines[idx])!
    if (m[2] === ' ') open.push(lines[idx])
    else done.push(lines[idx])
  }
  const sorted = [...open, ...done]
  const next: string[] = []
  let p = 0
  for (let i = 0; i < lines.length; i++) {
    if (taskIndices.includes(i)) {
      next.push(sorted[p++])
    } else {
      next.push(lines[i])
    }
  }
  const text = next.join('\n')
  if (text === lines.join('\n')) return false
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: text },
    selection: EditorSelection.cursor(startLine.from + text.length),
    userEvent: 'input.sort.tasks',
  })
  return true
}

   
                                                   
                    
   
export const ensureFrontmatter: Command = (view) => {
  const state = view.state
  const first = state.doc.lineAt(0)
  if (first.text.trim() === '---') return false
  const tpl = `---\ntitle: \ntags: []\n---\n\n`
  view.dispatch({
    changes: { from: 0, to: 0, insert: tpl },
    selection: EditorSelection.cursor('---\ntitle: '.length),
    userEvent: 'input.frontmatter.insert',
  })
  return true
}

   
                                     
                               
   
export const toggleAllTasksInSelection: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  const TASK_RE = /^(\s*[-*+]\s+)\[( |x|X)\](.*)$/
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = state.doc.line(i)
    const m = TASK_RE.exec(line.text)
    if (!m) continue
    const next = m[2] === ' ' ? 'x' : ' '
    changes.push({ from: line.from, to: line.to, insert: `${m[1]}[${next}]${m[3]}` })
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'input.tasks.toggleAll' })
  return true
}

   
                                   
                           
                           
                 
                 
   
export const applySmartArrows: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const from = main.empty ? 0 : main.from
  const to = main.empty ? state.doc.length : main.to
  const text = state.sliceDoc(from, to)
  const next = text
    .replace(/<->/g, '↔')
    .replace(/<=>/g, '⇔')
    .replace(/->/g, '→')
    .replace(/<-/g, '←')
    .replace(/=>/g, '⇒')
    .replace(/<=/g, '⇐')
  if (next === text) return false
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.cursor(main.empty ? main.head : from + next.length),
    userEvent: 'input.smart.arrows',
  })
  return true
}

   
                                                  
                                 
   
export function insertDataviewField(key: string = ''): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    const line = state.doc.lineAt(main.head)
    const insertPos = line.to
    const sep = main.head === line.to && line.text.trim() === '' ? '' : '\n'
    const insert = `${sep}${key}:: `
    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert },
      selection: EditorSelection.cursor(insertPos + insert.length),
      userEvent: 'input.dataview.field',
    })
    return true
  }
}

   
                                     
   
export const jumpToPrevHeading: Command = (view) => {
  const state = view.state
  const head = state.selection.main.head
  const curLine = state.doc.lineAt(head)
  let inFence = false
                        
  for (let i = 1; i < curLine.number; i++) {
    if (/^\s*```/.test(state.doc.line(i).text)) inFence = !inFence
  }
         
  let foundLineNo: number | null = null
  let runningFence = inFence
  for (let i = curLine.number - 1; i >= 1; i--) {
    const text = state.doc.line(i).text
    if (/^\s*```/.test(text)) {
      runningFence = !runningFence
      continue
    }
    if (runningFence) continue
    if (/^\s*#{1,6}\s+/.test(text)) {
      foundLineNo = i
      break
    }
  }
  const targetPos = foundLineNo ? state.doc.line(foundLineNo).from : 0
  view.dispatch({
    selection: EditorSelection.cursor(targetPos),
    effects: EditorView.scrollIntoView(targetPos, { y: 'center' }),
    userEvent: 'select.heading.prev',
  })
  return true
}

   
                                     
   
export const jumpToNextHeading: Command = (view) => {
  const state = view.state
  const head = state.selection.main.head
  const curLine = state.doc.lineAt(head)
  let inFence = false
  for (let i = 1; i <= curLine.number; i++) {
    if (/^\s*```/.test(state.doc.line(i).text)) inFence = !inFence
  }
  let foundLineNo: number | null = null
  let runningFence = inFence
  for (let i = curLine.number + 1; i <= state.doc.lines; i++) {
    const text = state.doc.line(i).text
    if (/^\s*```/.test(text)) {
      runningFence = !runningFence
      continue
    }
    if (runningFence) continue
    if (/^\s*#{1,6}\s+/.test(text)) {
      foundLineNo = i
      break
    }
  }
  const targetPos = foundLineNo
    ? state.doc.line(foundLineNo).from
    : state.doc.length
  view.dispatch({
    selection: EditorSelection.cursor(targetPos),
    effects: EditorView.scrollIntoView(targetPos, { y: 'center' }),
    userEvent: 'select.heading.next',
  })
  return true
}

   
                                 
   
export const tableMoveColumnLeft: Command = (view) =>
  rewriteTable(view, (rows, aligns, loc) => {
    const at = loc.cursorCol
    if (at <= 0) return null
    const newRows = rows.map((r) => {
      const copy = [...r]
      ;[copy[at - 1], copy[at]] = [copy[at], copy[at - 1]]
      return copy
    })
    const newAligns = [...aligns]
    ;[newAligns[at - 1], newAligns[at]] = [newAligns[at], newAligns[at - 1]]
    return { rows: newRows, aligns: newAligns }
  })

   
                               
   
export const tableMoveColumnRight: Command = (view) =>
  rewriteTable(view, (rows, aligns, loc) => {
    const at = loc.cursorCol
    if (at >= aligns.length - 1) return null
    const newRows = rows.map((r) => {
      const copy = [...r]
      ;[copy[at], copy[at + 1]] = [copy[at + 1], copy[at]]
      return copy
    })
    const newAligns = [...aligns]
    ;[newAligns[at], newAligns[at + 1]] = [newAligns[at + 1], newAligns[at]]
    return { rows: newRows, aligns: newAligns }
  })

   
                            
                                                                                    
                                                                                        
   
export const tableMoveRowUp: Command = (view) =>
  rewriteTable(view, (rows, aligns, loc) => {
    if (loc.cursorRow < 3) return null
    const idx = loc.cursorRow - 1
    if (idx >= rows.length) return null
    const newRows = [...rows]
    ;[newRows[idx - 1], newRows[idx]] = [newRows[idx], newRows[idx - 1]]
    return { rows: newRows, aligns }
  })

   
                            
   
export const tableMoveRowDown: Command = (view) =>
  rewriteTable(view, (rows, aligns, loc) => {
    if (loc.cursorRow < 2) return null
    const idx = loc.cursorRow - 1
    if (idx >= rows.length - 1) return null
    const newRows = [...rows]
    ;[newRows[idx], newRows[idx + 1]] = [newRows[idx + 1], newRows[idx]]
    return { rows: newRows, aligns }
  })

   
                       
   
export const swapLineUp: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  if (line.number <= 1) return false
  const above = state.doc.line(line.number - 1)
  const insert = `${line.text}\n${above.text}`
  const newHead = above.from + (main.head - line.from)
  view.dispatch({
    changes: { from: above.from, to: line.to, insert },
    selection: EditorSelection.cursor(newHead),
    userEvent: 'move.line.up',
  })
  return true
}

   
                       
   
export const swapLineDown: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  if (line.number >= state.doc.lines) return false
  const below = state.doc.line(line.number + 1)
  const insert = `${below.text}\n${line.text}`
  const newLineFrom = line.from + below.text.length + 1
  const newHead = newLineFrom + (main.head - line.from)
  view.dispatch({
    changes: { from: line.from, to: below.to, insert },
    selection: EditorSelection.cursor(newHead),
    userEvent: 'move.line.down',
  })
  return true
}

   
                                                        
                       
   
export const normalizeBulletMarkers: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const changes: ChangeSpec[] = []
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)([*+])(\s+)(.*)$/.exec(text)
    if (!m) continue
    const [, indent, _bullet, space, rest] = m
                                              
    if (/^\[( |x|X)\]\s/.test(rest)) {
      changes.push({ from: line.from, to: line.to, insert: `${indent}-${space}${rest}` })
    } else {
      changes.push({ from: line.from, to: line.to, insert: `${indent}-${space}${rest}` })
    }
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'format.list.normalize' })
  return true
}

   
                                         
                           
   
export const renumberOrderedLists: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const changes: ChangeSpec[] = []
  let inFence = false
  let lastIndent: string | null = null
  let counter = 0
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      lastIndent = null
      counter = 0
      continue
    }
    if (inFence) continue
    const m = /^(\s*)(\d+)(\.\s+)(.*)$/.exec(text)
    if (!m) {
      if (text.trim() === '') {
        lastIndent = null
        counter = 0
      } else {
        lastIndent = null
        counter = 0
      }
      continue
    }
    const [, indent, num, dotSpace, rest] = m
    if (indent !== lastIndent) {
      counter = 1
      lastIndent = indent
    } else {
      counter += 1
    }
    const expected = String(counter)
    if (expected !== num) {
      changes.push({ from: line.from, to: line.to, insert: `${indent}${expected}${dotSpace}${rest}` })
    }
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'format.ol.renumber' })
  return true
}

   
                                     
   
export const selectCurrentParagraph: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const doc = state.doc
  let startNo = doc.lineAt(main.from).number
  let endNo = doc.lineAt(main.to).number
  while (startNo > 1 && doc.line(startNo - 1).text.trim() !== '') startNo -= 1
  while (endNo < doc.lines && doc.line(endNo + 1).text.trim() !== '') endNo += 1
  const from = doc.line(startNo).from
  const to = doc.line(endNo).to
  if (main.from === from && main.to === to) return false
  view.dispatch({
    selection: EditorSelection.range(from, to),
    userEvent: 'select.paragraph',
  })
  return true
}

   
                                               
   
export const ensureReferencesSection: Command = (view) => {
  const state = view.state
  const text = state.doc.toString()
  if (/^#{1,6}\s+(References|Bibliography)\s*$/m.test(text)) return false
  const trailing = text.endsWith('\n') ? '' : '\n'
  const insert = `${trailing}\n## References\n\n`
  view.dispatch({
    changes: { from: state.doc.length, insert },
    selection: EditorSelection.cursor(state.doc.length + insert.length),
    userEvent: 'input.references.section',
  })
  return true
}

   
                      
   
export const reverseLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  if (startLine.number === endLine.number) return false
  const lines: string[] = []
  for (let i = startLine.number; i <= endLine.number; i++) lines.push(state.doc.line(i).text)
  const reversed = [...lines].reverse()
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: reversed.join('\n') },
    selection: EditorSelection.range(startLine.from, startLine.from + reversed.join('\n').length),
    userEvent: 'edit.reverse.lines',
  })
  return true
}

   
                               
   
export const dedupSelectedLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  if (startLine.number === endLine.number) return false
  const lines: string[] = []
  for (let i = startLine.number; i <= endLine.number; i++) lines.push(state.doc.line(i).text)
  const seen = new Set<string>()
  const out: string[] = []
  for (const ln of lines) {
    if (seen.has(ln)) continue
    seen.add(ln)
    out.push(ln)
  }
  if (out.length === lines.length) return false
  const insert = out.join('\n')
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: EditorSelection.range(startLine.from, startLine.from + insert.length),
    userEvent: 'edit.dedup.lines',
  })
  return true
}

   
             
   
export const removeEmptyLines: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const startLine = state.doc.lineAt(main.from)
  const endLine = state.doc.lineAt(main.to)
  const lines: string[] = []
  for (let i = startLine.number; i <= endLine.number; i++) lines.push(state.doc.line(i).text)
  const filtered = lines.filter((ln) => ln.trim() !== '')
  if (filtered.length === lines.length) return false
  const insert = filtered.join('\n')
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: EditorSelection.range(startLine.from, startLine.from + insert.length),
    userEvent: 'edit.remove.empty.lines',
  })
  return true
}

   
                                   
   
export const collapseInnerSpaces: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const next = text.replace(/^(\s*)([\s\S]*?)$/gm, (_full, lead, body) => {
    return lead + body.replace(/ {2,}/g, ' ')
  })
  if (next === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: next },
    selection: EditorSelection.range(main.from, main.from + next.length),
    userEvent: 'edit.collapse.spaces',
  })
  return true
}

   
                                                          
   
export const decodeHtmlEntities: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const next = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  if (next === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: next },
    selection: EditorSelection.range(main.from, main.from + next.length),
    userEvent: 'edit.decode.html',
  })
  return true
}

   
                                                     
   
export function getDocumentStats(view: EditorView): {
  chars: number
  charsNoSpaces: number
  words: number
  lines: number
  readingMinutes: number
} {
  const text = view.state.doc.toString()
  const chars = text.length
  const charsNoSpaces = text.replace(/\s+/g, '').length
  const lines = view.state.doc.lines
                               
  const englishWords = (text.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) || []).length
  const cjkChars = (text.match(/\p{Script=Han}/gu) || []).length
  const words = englishWords + cjkChars
  const readingMinutes = Math.max(1, Math.ceil(words / 200))
  return { chars, charsNoSpaces, words, lines, readingMinutes }
}

function formatDateLink(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

   
                                       
   
export const insertTodayLink: Command = (view) => {
  const link = `[[${formatDateLink(new Date())}]]`
  const pos = view.state.selection.main.from
  view.dispatch({
    changes: { from: pos, insert: link },
    selection: EditorSelection.cursor(pos + link.length),
    userEvent: 'input.today.link',
  })
  return true
}

   
                               
   
export const insertYesterdayLink: Command = (view) => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const link = `[[${formatDateLink(d)}]]`
  const pos = view.state.selection.main.from
  view.dispatch({
    changes: { from: pos, insert: link },
    selection: EditorSelection.cursor(pos + link.length),
    userEvent: 'input.yesterday.link',
  })
  return true
}

   
                               
   
export const insertTomorrowLink: Command = (view) => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const link = `[[${formatDateLink(d)}]]`
  const pos = view.state.selection.main.from
  view.dispatch({
    changes: { from: pos, insert: link },
    selection: EditorSelection.cursor(pos + link.length),
    userEvent: 'input.tomorrow.link',
  })
  return true
}

   
                          
   
export function convertTabsToSpaces(spaces: number = 2): Command {
  const pad = ' '.repeat(Math.max(1, Math.min(8, spaces)))
  return (view) => {
    const state = view.state
    const main = state.selection.main
    if (main.empty) return false
    const text = state.doc.sliceString(main.from, main.to)
    if (!text.includes('\t')) return false
    const next = text.replace(/\t/g, pad)
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: next },
      selection: EditorSelection.range(main.from, main.from + next.length),
      userEvent: 'edit.tabs.to.spaces',
    })
    return true
  }
}

   
                         
   
export function convertSpacesToTabs(spaces: number = 2): Command {
  const n = Math.max(1, Math.min(8, spaces))
  return (view) => {
    const state = view.state
    const main = state.selection.main
    if (main.empty) return false
    const text = state.doc.sliceString(main.from, main.to)
    const lines = text.split('\n')
    let changed = false
    const out = lines.map((ln) => {
      const leadMatch = /^( +)/.exec(ln)
      if (!leadMatch) return ln
      const lead = leadMatch[1]
      const tabs = Math.floor(lead.length / n)
      const rem = lead.length % n
      if (tabs === 0) return ln
      changed = true
      return '\t'.repeat(tabs) + ' '.repeat(rem) + ln.slice(lead.length)
    })
    if (!changed) return false
    const next = out.join('\n')
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: next },
      selection: EditorSelection.range(main.from, main.from + next.length),
      userEvent: 'edit.spaces.to.tabs',
    })
    return true
  }
}

   
                                                        
                                  
   
export const generateTOC: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const items: { level: number; text: string }[] = []
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(text)
    if (!m) continue
    items.push({ level: m[1].length, text: m[2] })
  }
  if (items.length === 0) return false
  const minLevel = Math.min(...items.map((x) => x.level))
  const lines = items.map((it) => {
    const indent = '  '.repeat(it.level - minLevel)
    const slug = it.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, '')
      .replace(/\s+/g, '-')
    return `${indent}- [${it.text}](#${slug})`
  })
  const tocText = lines.join('\n')

  const main = state.selection.main
  const cursorLine = doc.lineAt(main.head)
  if (/^\s*\[TOC\]\s*$/i.test(cursorLine.text)) {
    view.dispatch({
      changes: { from: cursorLine.from, to: cursorLine.to, insert: tocText },
      selection: EditorSelection.cursor(cursorLine.from + tocText.length),
      userEvent: 'input.toc.expand',
    })
    return true
  }
  view.dispatch({
    changes: { from: main.from, insert: tocText },
    selection: EditorSelection.cursor(main.from + tocText.length),
    userEvent: 'input.toc',
  })
  return true
}

   
                                  
   
export function wrapAsSpoiler(summary: string = 'Click to expand'): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    const body = main.empty
      ? state.doc.lineAt(main.head).text
      : state.doc.sliceString(main.from, main.to)
    const from = main.empty ? state.doc.lineAt(main.head).from : main.from
    const to = main.empty ? state.doc.lineAt(main.head).to : main.to
    const insert = `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      userEvent: 'input.spoiler',
    })
    return true
  }
}

   
                                                   
                                                           
   
export type Slide = { content: string; from: number; startLine: number; endLine: number }

export function splitMarkdownSlides(source: string): Slide[] {
  const lines = source.split('\n')
  const lineFrom: number[] = []
  {
    let off = 0
    for (const ln of lines) {
      lineFrom.push(off)
      off += ln.length + 1
    }
  }
                        
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1
        break
      }
    }
  }
  const slides: Slide[] = []
  let currentStart = bodyStart
  let inFence = false
  for (let i = bodyStart; i < lines.length; i++) {
    const text = lines[i]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
                                
    if (i > currentStart && /^-{3,}\s*$/.test(text)) {
      const content = lines.slice(currentStart, i).join('\n')
      slides.push({
        content,
        from: lineFrom[currentStart] ?? 0,
        startLine: currentStart + 1,
        endLine: i,
      })
      currentStart = i + 1
    }
  }
  if (currentStart < lines.length) {
    const content = lines.slice(currentStart).join('\n')
    slides.push({
      content,
      from: lineFrom[currentStart] ?? 0,
      startLine: currentStart + 1,
      endLine: lines.length,
    })
  }
             
  return slides.filter((s) => s.content.trim().length > 0)
}

   
                                               
   
export function jumpToSlide(view: EditorView, slideNo: number): boolean {
  const source = view.state.doc.sliceString(0)
  const slides = splitMarkdownSlides(source)
  if (slides.length === 0) return false
  const idx = Math.max(0, Math.min(slides.length - 1, slideNo - 1))
  const pos = slides[idx].from
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start' }),
  })
  view.focus()
  return true
}

   
                         
   
export const jumpToNextSlide: Command = (view) => {
  const source = view.state.doc.sliceString(0)
  const slides = splitMarkdownSlides(source)
  if (slides.length <= 1) return false
  const head = view.state.selection.main.head
  let cur = 0
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].from <= head) cur = i
    else break
  }
  if (cur >= slides.length - 1) return false
  const pos = slides[cur + 1].from
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start' }),
  })
  view.focus()
  return true
}

   
            
   
export const jumpToPrevSlide: Command = (view) => {
  const source = view.state.doc.sliceString(0)
  const slides = splitMarkdownSlides(source)
  if (slides.length <= 1) return false
  const head = view.state.selection.main.head
  let cur = 0
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].from <= head) cur = i
    else break
  }
  if (cur <= 0) return false
  const pos = slides[cur - 1].from
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start' }),
  })
  view.focus()
  return true
}

   
                        
   
export const insertSlideBreak: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  const at = line.to
  const insert = `\n---\n\n`
  view.dispatch({
    changes: { from: at, insert },
    selection: EditorSelection.cursor(at + insert.length),
    userEvent: 'input.slide-break',
  })
  view.focus()
  return true
}

   
                                                   
   
export type CodeBlockAtCursor = {
                            
  from: number
                                   
  to: number
                        
  startLine: number
               
  endLine: number
                  
  lang: string
                           
  body: string
}

export function getCodeBlockAtCursor(view: EditorView): CodeBlockAtCursor | null {
  const doc = view.state.doc
  const head = view.state.selection.main.head
  const cursorLine = doc.lineAt(head).number
  let fenceOpenLine = -1
  let lang = ''
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    const m = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(text)
    if (m) {
      if (fenceOpenLine === -1) {
        fenceOpenLine = i
        lang = m[1] ?? ''
      } else {
                   
        if (cursorLine > fenceOpenLine && cursorLine <= i) {
          const openLine = doc.line(fenceOpenLine)
          const closeLine = doc.line(i)
          const bodyLines: string[] = []
          for (let j = fenceOpenLine + 1; j < i; j++) bodyLines.push(doc.line(j).text)
          return {
            from: openLine.from,
            to: closeLine.to,
            startLine: fenceOpenLine,
            endLine: i,
            lang,
            body: bodyLines.join('\n'),
          }
        }
        fenceOpenLine = -1
        lang = ''
      }
    }
  }
  return null
}

   
                                    
                        
   
export const copyCodeBlockAtCursor: Command = (view) => {
  const info = getCodeBlockAtCursor(view)
  if (!info) return false
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(info.body)
  }
  return true
}

   
                                  
                                            
   
export function changeCodeBlockLang(newLang?: string): Command {
  return (view) => {
    const info = getCodeBlockAtCursor(view)
    if (!info) return false
    let lang = newLang
    if (lang === undefined && typeof window !== 'undefined' && typeof window.prompt === 'function') {
      const r = window.prompt('New language (leave blank to clear)', info.lang) ?? null
      if (r === null) return false
      lang = r
    }
    if (lang === undefined) lang = info.lang
    const cleaned = lang.trim().replace(/[^A-Za-z0-9_+\-]/g, '')
    const openLine = view.state.doc.line(info.startLine)
    const newText = '```' + (cleaned ? cleaned : '')
    view.dispatch({
      changes: { from: openLine.from, to: openLine.to, insert: newText },
      userEvent: 'input.codefence-lang',
    })
    view.focus()
    return true
  }
}

   
                             
                                  
                              
   
export function shiftAllHeadings(delta: number): Command {
  return (view) => {
    if (delta === 0) return false
    const doc = view.state.doc
    const lines: string[] = []
    for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text)
    let inFence = false
    const changes: { from: number; to: number; insert: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      if (/^\s*```/.test(text)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = /^(#{1,6})\s+(.+)$/.exec(text)
      if (!m) continue
      const cur = m[1].length
      const next = Math.max(1, Math.min(6, cur + delta))
      if (next === cur) continue
      const line = doc.line(i + 1)
      const replaced = '#'.repeat(next) + ' ' + m[2]
      changes.push({ from: line.from, to: line.to, insert: replaced })
    }
    if (changes.length === 0) return false
    view.dispatch({ changes, userEvent: 'input.shift-headings' })
    view.focus()
    return true
  }
}

   
                                             
   
export function parseCsv(source: string, delimiter: string = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
            
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  return rows
}

   
                                     
                                 
   
export function csvToMarkdownTable(csv: string, delimiter: string = ','): string {
  const rows = parseCsv(csv, delimiter)
  if (rows.length === 0) return ''
  const widths: number[] = []
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = row[c].length
      if (widths[c] === undefined || w > widths[c]) widths[c] = w
    }
  }
  const totalCols = widths.length
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  const fmt = (row: string[]) =>
    '| ' + Array.from({ length: totalCols }, (_, c) => pad(row[c] ?? '', widths[c])).join(' | ') + ' |'
  const header = fmt(rows[0])
  const sep = '| ' + widths.map((w) => '-'.repeat(Math.max(3, w))).join(' | ') + ' |'
  const body = rows.slice(1).map(fmt)
  return [header, sep, ...body].join('\n')
}

   
                                         
   
export function markdownTableToCsv(table: string, delimiter: string = ','): string {
  const lines = table.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const rows: string[][] = []
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue
                         
    if (/^\|?\s*:?-{2,}/.test(line.trim().slice(1))) {
      const segs = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((s) => s.trim())
      if (segs.every((s) => /^:?-+:?$/.test(s))) continue
    }
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((s) => s.trim())
    rows.push(cells)
  }
  const quote = (s: string) => {
    if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
  return rows.map((r) => r.map(quote).join(delimiter)).join('\n')
}

   
                                   
                                                                                           
                      
   
export function stripMarkdownToPlain(source: string): string {
  let s = source
            
  s = s.replace(/<!--[\s\S]*?-->/g, '')
                         
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Wikilink [[Page|alias]] becomes alias; [[Page]] becomes Page.
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1')
  // markdown link [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
              
  s = s.replace(/^(\s*)#{1,6}\s+/gm, '$1')
              
  s = s.replace(/^(\s*)([-*+]|\d+\.)\s+/gm, '$1')
              
  s = s.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, '$1')
              
  s = s.replace(/^(\s*)>+\s?/gm, '$1')
         
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
               
  s = s.replace(/==([^=]+)==/g, '$1')
                  
           
  s = s.replace(/[ \t]+$/gm, '')
           
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

   
                           
   
export const copyAsPlainText: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  let text: string
  if (main.empty) {
    const line = state.doc.lineAt(main.head)
    text = line.text
  } else {
    text = state.doc.sliceString(main.from, main.to)
  }
  const plain = stripMarkdownToPlain(text)
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(plain)
  }
  return true
}

   
                           
   
export const replaceWithPlain: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const plain = stripMarkdownToPlain(text)
  if (plain === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: plain },
    selection: EditorSelection.range(main.from, main.from + plain.length),
    userEvent: 'input.strip-markdown',
  })
  view.focus()
  return true
}

   
                                      
   
export function convertCsvSelectionToTable(delimiter: string = ','): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    if (main.empty) return false
    const sel = state.doc.sliceString(main.from, main.to)
    if (!sel.includes(delimiter)) return false
    const md = csvToMarkdownTable(sel, delimiter)
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: md },
      selection: EditorSelection.range(main.from, main.from + md.length),
      userEvent: 'input.csv-to-table',
    })
    view.focus()
    return true
  }
}

   
                             
   
export function convertTableSelectionToCsv(delimiter: string = ','): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    if (main.empty) return false
    const sel = state.doc.sliceString(main.from, main.to)
    if (!/\|/.test(sel)) return false
    const csv = markdownTableToCsv(sel, delimiter)
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: csv },
      selection: EditorSelection.range(main.from, main.from + csv.length),
      userEvent: 'input.table-to-csv',
    })
    view.focus()
    return true
  }
}

   
                                                  
                        
   
export function markAllTasks(state: 'done' | 'undone'): Command {
  return (view) => {
    const doc = view.state.doc
    const target = state === 'done' ? 'x' : ' '
    const changes: { from: number; to: number; insert: string }[] = []
    let inFence = false
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i)
      const text = line.text
      if (/^\s*```/.test(text)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = /^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/.exec(text)
      if (!m) continue
      const cur = m[2]
      const want = target
      if (cur.toLowerCase() === want.toLowerCase()) continue
      const replaced = m[1] + want + m[3]
      changes.push({ from: line.from, to: line.to, insert: replaced })
    }
    if (changes.length === 0) return false
    view.dispatch({ changes, userEvent: 'input.bulk-tasks' })
    view.focus()
    return true
  }
}

   
                                                      
                          
   
export const archiveDoneTasks: Command = (view) => {
  const doc = view.state.doc
  const lines: string[] = []
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text)

  let inFence = false
  const keepIdx: boolean[] = lines.map(() => true)
  const archived: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^(\s*)[-*+]\s+\[[xX]\]\s+.+$/.test(text)) {
      archived.push(text)
      keepIdx[i] = false
    }
  }
  if (archived.length === 0) return false

  const kept = lines.filter((_, i) => keepIdx[i])
                             
  let archivedHeadingAt = -1
  for (let i = 0; i < kept.length; i++) {
    if (/^##\s+Archived\s*$/.test(kept[i].trim())) {
      archivedHeadingAt = i
      break
    }
  }
  let next: string[]
  if (archivedHeadingAt === -1) {
    next = [...kept]
    if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('')
    next.push('## Archived')
    next.push(...archived)
  } else {
    next = [...kept.slice(0, archivedHeadingAt + 1), ...archived, ...kept.slice(archivedHeadingAt + 1)]
  }
  const newText = next.join('\n')
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: newText },
    userEvent: 'input.archive-tasks',
  })
  view.focus()
  return true
}

   
                                            
                                    
                                
   
export function renameDocumentTag(oldTag: string, newTag: string): Command {
  return (view) => {
    const cleanOld = oldTag.replace(/^#/, '')
    const cleanNew = newTag.replace(/^#/, '')
    if (!cleanOld || !cleanNew) return false
    if (cleanOld === cleanNew) return false
    const doc = view.state.doc
    let inFence = false
    const changes: { from: number; to: number; insert: string }[] = []
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i)
      const text = line.text
      if (/^\s*```/.test(text)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
                         
      const masked = text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
      const escaped = cleanOld.replace(/[/.+\-]/g, '\\$&')
      const re = new RegExp('(^|[\\s\\p{P}])#' + escaped + '(?=$|[\\s\\p{P}])', 'gu')
      let m: RegExpExecArray | null
      while ((m = re.exec(masked)) !== null) {
        const startCol = m.index + m[1].length
                                         
        changes.push({
          from: line.from + startCol,
          to: line.from + startCol + 1 + cleanOld.length,
          insert: '#' + cleanNew,
        })
      }
    }
    if (changes.length === 0) return false
    view.dispatch({ changes, userEvent: 'input.rename-tag' })
    view.focus()
    return true
  }
}

   
                                    
                                                
                          
   
export function markdownOutlineToOpml(source: string): string {
  type Node = { text: string; children: Node[] }
  const root: Node = { text: '', children: [] }
  const stack: { level: number; node: Node }[] = [{ level: -1, node: root }]
  const lines = source.split(/\r?\n/)
  for (const raw of lines) {
    if (!raw.trim()) continue
    const m = /^([ \t]*)([-*+])\s+(.*)$/.exec(raw)
    if (!m) continue
    const indent = m[1].replace(/\t/g, '  ').length
    const level = Math.floor(indent / 2)
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
    const node: Node = { text: m[3], children: [] }
    stack[stack.length - 1].node.children.push(node)
    stack.push({ level, node })
  }
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const render = (nodes: Node[], indent: number): string => {
    const pad = '  '.repeat(indent)
    return nodes
      .map((n) =>
        n.children.length === 0
          ? `${pad}<outline text="${esc(n.text)}"/>`
          : `${pad}<outline text="${esc(n.text)}">\n${render(n.children, indent + 1)}\n${pad}</outline>`,
      )
      .join('\n')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head/>\n  <body>\n${render(root.children, 2)}\n  </body>\n</opml>`
}

   
                                 
                                        
   
export function opmlToMarkdownOutline(opml: string): string {
  const lines = opml.split(/\r?\n/)
  const out: string[] = []
  const stack: number[] = []
  const decode = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  let inBody = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/<body>/.test(trimmed)) inBody = true
    else if (/<\/body>/.test(trimmed)) inBody = false
    if (!inBody) continue
    if (trimmed.startsWith('<outline')) {
      const m = /text="([^"]*)"/.exec(trimmed)
      if (!m) continue
                           
      const leading = /^( *)/.exec(line)?.[1].length ?? 0
      const depth = Math.max(0, Math.floor((leading - 4) / 2))
      out.push('  '.repeat(depth) + '- ' + decode(m[1]))
      if (!trimmed.endsWith('/>')) stack.push(depth)
    } else if (/^<\/outline>/.test(trimmed)) {
      stack.pop()
    }
  }
  return out.join('\n')
}

   
                                   
   
export const convertOutlineSelectionToOpml: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const sel = state.doc.sliceString(main.from, main.to)
  if (!/(^|\n)\s*[-*+]\s+/.test(sel)) return false
  const opml = markdownOutlineToOpml(sel)
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: opml },
    selection: EditorSelection.range(main.from, main.from + opml.length),
    userEvent: 'input.md-to-opml',
  })
  view.focus()
  return true
}

   
                                   
   
export const convertOpmlSelectionToOutline: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const sel = state.doc.sliceString(main.from, main.to)
  if (!/<opml/.test(sel)) return false
  const md = opmlToMarkdownOutline(sel)
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: md },
    selection: EditorSelection.range(main.from, main.from + md.length),
    userEvent: 'input.opml-to-md',
  })
  view.focus()
  return true
}

function listItemRangeAtLine(view: EditorView, lineNo: number): { startLine: number; endLine: number; indentChars: string } | null {
  const doc = view.state.doc
  const line = doc.line(lineNo)
  const m = /^([ \t]*)([-*+]|\d+\.)\s+/.exec(line.text)
  if (!m) return null
  const indentChars = m[1]
  const indent = indentChars.replace(/\t/g, '  ').length
                                      
  let endLine = lineNo
  for (let i = lineNo + 1; i <= doc.lines; i++) {
    const t = doc.line(i).text
    if (/^\s*$/.test(t)) break
    const mm = /^([ \t]*)([-*+]|\d+\.)\s+/.exec(t)
    if (!mm) break
    const childIndent = mm[1].replace(/\t/g, '  ').length
    if (childIndent <= indent) break
    endLine = i
  }
  return { startLine: lineNo, endLine, indentChars }
}

   
                                 
                  
   
export const promoteListItem: Command = (view) => {
  const state = view.state
  const head = state.selection.main.head
  const lineNo = state.doc.lineAt(head).number
  const info = listItemRangeAtLine(view, lineNo)
  if (!info) return false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = info.startLine; i <= info.endLine; i++) {
    const line = state.doc.line(i)
    const t = line.text
    if (t.startsWith('  ')) {
      changes.push({ from: line.from, to: line.from + 2, insert: '' })
    } else if (t.startsWith('\t')) {
      changes.push({ from: line.from, to: line.from + 1, insert: '' })
    } else {
      return false
    }
  }
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'input.indent-list-out' })
  view.focus()
  return true
}

   
                                 
   
export const demoteListItem: Command = (view) => {
  const state = view.state
  const head = state.selection.main.head
  const lineNo = state.doc.lineAt(head).number
  const info = listItemRangeAtLine(view, lineNo)
  if (!info) return false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = info.startLine; i <= info.endLine; i++) {
    const line = state.doc.line(i)
    changes.push({ from: line.from, to: line.from, insert: '  ' })
  }
  view.dispatch({ changes, userEvent: 'input.indent-list-in' })
  view.focus()
  return true
}

function selectionLineRange(view: EditorView): { fromLine: number; toLine: number } {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    const ln = state.doc.lineAt(main.head).number
    return { fromLine: ln, toLine: ln }
  }
  const fromLine = state.doc.lineAt(main.from).number
  const toLine = state.doc.lineAt(main.to - (main.to > main.from ? 1 : 0)).number
  return { fromLine, toLine }
}

   
                                      
   
export const convertBulletListToOrdered: Command = (view) => {
  const state = view.state
  const { fromLine, toLine } = selectionLineRange(view)
  let counter = 1
  let changed = false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = fromLine; i <= toLine; i++) {
    const line = state.doc.line(i)
    const m = /^([ \t]*)[-*+]\s+(.*)$/.exec(line.text)
    if (!m) {
      counter = 1
      continue
    }
    const replaced = `${m[1]}${counter}. ${m[2]}`
    changes.push({ from: line.from, to: line.to, insert: replaced })
    counter++
    changed = true
  }
  if (!changed) return false
  view.dispatch({ changes, userEvent: 'input.bullet-to-ordered' })
  view.focus()
  return true
}

   
                                   
   
export const convertOrderedListToBullet: Command = (view) => {
  const state = view.state
  const { fromLine, toLine } = selectionLineRange(view)
  let changed = false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = fromLine; i <= toLine; i++) {
    const line = state.doc.line(i)
    const m = /^([ \t]*)\d+\.\s+(.*)$/.exec(line.text)
    if (!m) continue
    const replaced = `${m[1]}- ${m[2]}`
    changes.push({ from: line.from, to: line.to, insert: replaced })
    changed = true
  }
  if (!changed) return false
  view.dispatch({ changes, userEvent: 'input.ordered-to-bullet' })
  view.focus()
  return true
}

   
                                                 
   
export const insertUuid: Command = (view) => {
  let uuid: string
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    uuid = crypto.randomUUID()
  } else {
    uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
  const state = view.state
  const main = state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: uuid },
    selection: EditorSelection.cursor(main.from + uuid.length),
    userEvent: 'input.uuid',
  })
  view.focus()
  return true
}

   
                                 
                                                                           
   
export const sortFrontmatterKeys: Command = (view) => {
  const doc = view.state.doc
  if (doc.lines < 2) return false
  if (doc.line(1).text.trim() !== '---') return false
  let closeLine = -1
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') {
      closeLine = i
      break
    }
  }
  if (closeLine === -1) return false
  type Entry = { key: string; lines: string[] }
  const entries: Entry[] = []
  for (let i = 2; i < closeLine; i++) {
    const t = doc.line(i).text
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(t)
    if (m) {
      entries.push({ key: m[1], lines: [t] })
    } else if (entries.length > 0) {
      entries[entries.length - 1].lines.push(t)
    }
  }
  if (entries.length < 2) return false
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key))
  if (sorted.every((e, i) => entries[i].key === e.key)) return false
  const replaced = sorted.flatMap((e) => e.lines).join('\n')
  const firstFrom = doc.line(2).from
  const lastTo = doc.line(closeLine - 1).to
  view.dispatch({
    changes: { from: firstFrom, to: lastTo, insert: replaced },
    userEvent: 'input.sort-frontmatter',
  })
  view.focus()
  return true
}

   
                      
   
export const reverseCase: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  let out = ''
  for (const ch of text) {
    if (ch >= 'a' && ch <= 'z') out += ch.toUpperCase()
    else if (ch >= 'A' && ch <= 'Z') out += ch.toLowerCase()
    else out += ch
  }
  if (out === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.range(main.from, main.from + out.length),
    userEvent: 'input.reverse-case',
  })
  view.focus()
  return true
}

   
                                               
   
export const tableDedupRowsByFirstColumn: Command = (view) =>
  rewriteTable(view, (rows, aligns) => {
    if (rows.length < 2) return null
    const [header, ...body] = rows
    const seen = new Set<string>()
    const kept: string[][] = []
    for (const r of body) {
      const key = (r[0] ?? '').trim()
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(r)
    }
    if (kept.length === body.length) return null
    return { rows: [header, ...kept], aligns }
  })

   
                                         
   
export const tableRotateColumnsLeft: Command = (view) =>
  rewriteTable(view, (rows, aligns) => {
    if (aligns.length < 2) return null
    const newRows = rows.map((r) => (r.length > 1 ? [...r.slice(1), r[0] ?? ''] : r))
    const newAligns = [...aligns.slice(1), aligns[0]]
    return { rows: newRows, aligns: newAligns }
  })

   
                                         
   
export const tableRotateColumnsRight: Command = (view) =>
  rewriteTable(view, (rows, aligns) => {
    if (aligns.length < 2) return null
    const newRows = rows.map((r) => (r.length > 1 ? [r[r.length - 1] ?? '', ...r.slice(0, -1)] : r))
    const newAligns = [aligns[aligns.length - 1], ...aligns.slice(0, -1)]
    return { rows: newRows, aligns: newAligns }
  })

   
                                           
   
export const tableTranspose: Command = (view) =>
  rewriteTable(view, (rows) => {
    if (rows.length < 1 || rows[0].length < 1) return null
    const w = Math.max(...rows.map((r) => r.length))
    const padded = rows.map((r) => {
      if (r.length === w) return r
      return [...r, ...Array(w - r.length).fill('')]
    })
    const h = padded.length
    const newRows: string[][] = []
    for (let c = 0; c < w; c++) {
      const row: string[] = []
      for (let r = 0; r < h; r++) {
        row.push(padded[r][c] ?? '')
      }
      newRows.push(row)
    }
    const newAligns = Array<ColAlign>(h).fill('none')
    return { rows: newRows, aligns: newAligns }
  })

   
                                                              
   
export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-.!<>|~])/g, '\\$1')
}

   
                                     
   
export function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, '$1')
}

export const escapeMarkdownSelection: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const out = escapeMarkdownText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.range(main.from, main.from + out.length),
    userEvent: 'input.escape-md',
  })
  view.focus()
  return true
}

export const unescapeMarkdownSelection: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const out = unescapeMarkdownText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.range(main.from, main.from + out.length),
    userEvent: 'input.unescape-md',
  })
  view.focus()
  return true
}

export function wrapAsDetails(summary: string = 'Details'): Command {
  return (view) => {
    const state = view.state
    const main = state.selection.main
    const body = main.empty ? '' : state.doc.sliceString(main.from, main.to)
    const block = `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: block },
      selection: EditorSelection.cursor(main.from + block.length),
      userEvent: 'input.details',
    })
    view.focus()
    return true
  }
}

   
                                                           
                            
   
export const convertHeadingsToList: Command = (view) => {
  const doc = view.state.doc
  const lines: string[] = []
  let inFence = false
  let changed = false
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      lines.push(text)
      continue
    }
    if (inFence) {
      lines.push(text)
      continue
    }
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
    if (!m) {
      lines.push(text)
      continue
    }
    const level = m[1].length
    const indent = ' '.repeat((level - 1) * 2)
    lines.push(`${indent}- ${m[2]}`)
    changed = true
  }
  if (!changed) return false
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: lines.join('\n') },
    userEvent: 'input.headings-to-list',
  })
  view.focus()
  return true
}

   
                                                           
                            
   
export const convertBulletsToHeadings: Command = (view) => {
  const doc = view.state.doc
  const lines: string[] = []
  let inFence = false
  let changed = false
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      lines.push(text)
      continue
    }
    if (inFence) {
      lines.push(text)
      continue
    }
    const m = /^([ \t]*)[-*+]\s+(.*)$/.exec(text)
    if (!m) {
      lines.push(text)
      continue
    }
    const indent = m[1].replace(/\t/g, '  ').length
    const level = Math.min(6, Math.floor(indent / 2) + 1)
    lines.push(`${'#'.repeat(level)} ${m[2]}`)
    changed = true
  }
  if (!changed) return false
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: lines.join('\n') },
    userEvent: 'input.bullets-to-headings',
  })
  view.focus()
  return true
}

   
                                                               
   
export function capitalizeSentencesText(text: string): string {
  let out = ''
  let cap = true
  for (const ch of text) {
    if (cap && /[a-zA-Z]/.test(ch)) {
      out += ch.toUpperCase()
      cap = false
    } else {
      out += ch
      if (/[.!?]/.test(ch)) cap = true
      else if (/\s/.test(ch)) {
        // Keep the previous capitalization state.
      } else {
        cap = false
      }
    }
  }
  return out
}

export const capitalizeSentences: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const out = capitalizeSentencesText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.range(main.from, main.from + out.length),
    userEvent: 'input.capitalize-sentences',
  })
  view.focus()
  return true
}

   
                                         
   
export function capitalizeEachWordText(text: string): string {
  return text.replace(/\b([a-zA-Z])/g, (_, c) => c.toUpperCase())
}

export const capitalizeEachWord: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.doc.sliceString(main.from, main.to)
  const out = capitalizeEachWordText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.range(main.from, main.from + out.length),
    userEvent: 'input.capitalize-words',
  })
  view.focus()
  return true
}

   
                         
                                                        
   
export function straightToCurlyQuotesText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const prev = i === 0 ? '' : text[i - 1]
      const isOpening = !prev || /[\s(\[{<—–-]/.test(prev)
      if (ch === '"') out += isOpening ? '“' : '”'
      else out += isOpening ? '‘' : '’'
    } else {
      out += ch
    }
  }
  return out
}

                                       
export function curlyToStraightQuotesText(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

export const straightToCurlyQuotes: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const range = main.empty ? { from: 0, to: state.doc.length } : { from: main.from, to: main.to }
  const text = state.doc.sliceString(range.from, range.to)
  const out = straightToCurlyQuotesText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: out },
    userEvent: 'input.curly-quotes',
  })
  view.focus()
  return true
}

export const curlyToStraightQuotes: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const range = main.empty ? { from: 0, to: state.doc.length } : { from: main.from, to: main.to }
  const text = state.doc.sliceString(range.from, range.to)
  const out = curlyToStraightQuotesText(text)
  if (out === text) return false
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: out },
    userEvent: 'input.straight-quotes',
  })
  view.focus()
  return true
}

                                                        
function consecutiveListBlock(view: EditorView): {
  startLine: number
  endLine: number
  prefix: string
  matcher: RegExp
} | null {
  const doc = view.state.doc
  const here = doc.lineAt(view.state.selection.main.head).number
  const text = doc.line(here).text
  let matcher: RegExp | null = null
  let prefix = ''
  const bulletM = /^([ \t]*)([-*+])\s+(.*)$/.exec(text)
  const orderedM = /^([ \t]*)\d+\.\s+(.*)$/.exec(text)
  const todoM = /^([ \t]*)[-*+]\s+\[[ xX]\]\s+(.*)$/.exec(text)
  if (todoM) {
    matcher = /^([ \t]*)[-*+]\s+\[[ xX]\]\s+(.*)$/
    prefix = todoM[1]
  } else if (orderedM) {
    matcher = /^([ \t]*)\d+\.\s+(.*)$/
    prefix = orderedM[1]
  } else if (bulletM) {
    matcher = /^([ \t]*)[-*+]\s+(.*)$/
    prefix = bulletM[1]
  }
  if (!matcher) return null
  let s = here
  while (s > 1) {
    const t = doc.line(s - 1).text
    const m = matcher.exec(t)
    if (!m || m[1] !== prefix) break
    s--
  }
  let e = here
  while (e < doc.lines) {
    const t = doc.line(e + 1).text
    const m = matcher.exec(t)
    if (!m || m[1] !== prefix) break
    e++
  }
  return { startLine: s, endLine: e, prefix, matcher }
}

function rewriteListBlock(view: EditorView, transform: (items: string[]) => string[] | null): boolean {
  const block = consecutiveListBlock(view)
  if (!block) return false
  const doc = view.state.doc
  const lines: string[] = []
  const items: string[] = []
  for (let i = block.startLine; i <= block.endLine; i++) {
    const t = doc.line(i).text
    const m = block.matcher.exec(t)
    if (!m) return false
    items.push(m[m.length - 1])
    lines.push(t)
  }
  const out = transform(items)
  if (!out) return false
                                                            
  const sample = doc.line(block.startLine).text
  const rendered = out.map((content, idx) => {
    return sample.replace(block.matcher, (_full, _prefix, _marker, _body) => {
                       
      if (/^([ \t]*)\d+\./.test(sample)) {
        return `${block.prefix}${idx + 1}. ${content}`
      }
      // todo
      const todo = /\[[xX]\]/.test(sample)
      if (/\[[ xX]\]/.test(sample)) {
        return `${block.prefix}- [${todo ? 'x' : ' '}] ${content}`
      }
      // bullet
      const markerMatch = /^[ \t]*([-*+])/.exec(sample)
      const marker = markerMatch?.[1] ?? '-'
      return `${block.prefix}${marker} ${content}`
    })
  })
  view.dispatch({
    changes: {
      from: doc.line(block.startLine).from,
      to: doc.line(block.endLine).to,
      insert: rendered.join('\n'),
    },
    userEvent: 'input.list-rewrite',
  })
  view.focus()
  return true
}

export const sortListBlock: Command = (view) =>
  rewriteListBlock(view, (items) => {
    const sorted = [...items].sort((a, b) => a.localeCompare(b))
    if (sorted.every((v, i) => v === items[i])) return null
    return sorted
  })

export const uniqueListBlock: Command = (view) =>
  rewriteListBlock(view, (items) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of items) {
      const k = v.trim()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
    if (out.length === items.length) return null
    return out
  })

export const shuffleListBlock: Command = (view) =>
  rewriteListBlock(view, (items) => {
    if (items.length < 2) return null
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
                         
    if (out.every((v, i) => v === items[i])) {
      out.reverse()
    }
    return out
  })

function moveSectionTo(view: EditorView, target: 'top' | 'bottom'): boolean {
  const state = view.state
  const cur = findCurrentSection(state)
  if (!cur) return false
  const doc = state.doc
  const curStart = doc.line(cur.headingLineNo).from
  const curEnd = doc.line(cur.endLineNo).to
  const sectionText = doc.sliceString(curStart, curEnd)
  if (target === 'top') {
    if (curStart === 0) return false
    const before = doc.sliceString(0, curStart).replace(/\n$/, '')
    const after = doc.sliceString(curEnd).replace(/^\n/, '')
    const next = [sectionText, before, after].filter((s) => s.length > 0).join('\n')
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: next },
      selection: EditorSelection.cursor(0),
      userEvent: 'move.section',
    })
    return true
  }
  // bottom
  if (curEnd >= doc.length - 0) return false
  const before = doc.sliceString(0, curStart).replace(/\n$/, '')
  const after = doc.sliceString(curEnd).replace(/^\n/, '')
  if (after.length === 0) return false
  const next = [before, after, sectionText].filter((s) => s.length > 0).join('\n')
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: next },
    userEvent: 'move.section',
  })
  return true
}

export const moveSectionToTop: Command = (view) => moveSectionTo(view, 'top')
export const moveSectionToBottom: Command = (view) => moveSectionTo(view, 'bottom')

   
                                             
                                                        
   
export function buildSectionLinkText(view: EditorView, documentBase: string): string | null {
  const cur = findCurrentSection(view.state)
  if (!cur) return null
  const headingLine = view.state.doc.line(cur.headingLineNo).text
  const m = HEADING_LINE_PATTERN.exec(headingLine)
  if (!m) return null
  const title = headingLine.slice(m[0].length).replace(/\s*#*\s*$/, '').trim()
  if (!title) return null
  return documentBase ? `[[${documentBase}#${title}]]` : `[[#${title}]]`
}

   
                                                           
   
export function copySectionAsLink(documentBase: string): Command {
  return (view) => {
    const txt = buildSectionLinkText(view, documentBase)
    if (!txt) return false
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(txt)
      }
    } catch {
      // best-effort
    }
    return true
  }
}

   
                                 
                      
   
export const toggleInlineMath: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    view.dispatch({
      changes: { from: main.from, insert: '$$' },
      selection: EditorSelection.cursor(main.from + 1),
      userEvent: 'input.math',
    })
    view.focus()
    return true
  }
  const text = state.doc.sliceString(main.from, main.to)
  if (text.startsWith('$') && text.endsWith('$') && text.length >= 2) {
    const inner = text.slice(1, -1)
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: inner },
      selection: EditorSelection.range(main.from, main.from + inner.length),
      userEvent: 'input.math',
    })
    view.focus()
    return true
  }
  const wrapped = `$${text}$`
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: wrapped },
    selection: EditorSelection.range(main.from + 1, main.from + 1 + text.length),
    userEvent: 'input.math',
  })
  view.focus()
  return true
}

   
                                   
                                                                        
   
export const insertHorizontalRuleAtCursor: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  const insert = `${line.text.length === 0 ? '' : '\n'}\n---\n`
  view.dispatch({
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(line.to + insert.length),
    userEvent: 'input.hr',
  })
  view.focus()
  return true
}

   
                                             
   
export function bulletsToCsvText(source: string, sep: string = ', '): string {
  const items: string[] = []
  for (const line of source.split('\n')) {
    const m = /^[ \t]*[-*+]\s+(.*)$/.exec(line)
    if (m) items.push(m[1])
  }
  return items.join(sep)
}

   
                              
   
export function csvToBulletsText(csv: string, sep: string | RegExp = /,\s*|;\s*/): string {
  const parts = typeof sep === 'string' ? csv.split(sep) : csv.split(sep)
  return parts.map((p) => `- ${p.trim()}`).filter((l) => l.length > 2).join('\n')
}

export const bulletsToCsvLine: Command = (view) => {
  const block = consecutiveListBlock(view)
  if (!block) return false
  const doc = view.state.doc
  const lines: string[] = []
  for (let i = block.startLine; i <= block.endLine; i++) {
    lines.push(doc.line(i).text)
  }
  const csv = bulletsToCsvText(lines.join('\n'))
  if (!csv) return false
  view.dispatch({
    changes: {
      from: doc.line(block.startLine).from,
      to: doc.line(block.endLine).to,
      insert: csv,
    },
    userEvent: 'input.bullets-to-csv',
  })
  view.focus()
  return true
}

export const csvToBulletsLine: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  if (!line.text.trim()) return false
                         
  if (!/[,;]/.test(line.text)) return false
  const out = csvToBulletsText(line.text)
  if (!out) return false
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: out },
    userEvent: 'input.csv-to-bullets',
  })
  view.focus()
  return true
}

   
                            
  
                                      
                       
   
export function hardWrapText(source: string, width = 80): string {
  if (width < 1) return source
  const out: string[] = []
  for (const para of source.split(/\n\n+/)) {
    if (!para.trim()) {
      out.push(para)
      continue
    }
                      
    const flat = para.replace(/\s+\n\s+/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    const lines: string[] = []
    let cur = ''
    const tokens = flat.split(' ')
    for (const tok of tokens) {
      if (!cur) {
        cur = tok
        continue
      }
      if (cur.length + 1 + tok.length <= width) {
        cur += ' ' + tok
      } else {
        lines.push(cur)
        cur = tok
      }
    }
    if (cur) lines.push(cur)
    out.push(lines.join('\n'))
  }
  return out.join('\n\n')
}

   
                                       
   
export function unwrapParagraphsText(source: string): string {
  return source
    .split(/\n\n+/)
    .map((para) => {
      if (!para.trim()) return para
                                       
      if (/^[ \t]*```/.test(para) || /\n[ \t]*```/.test(para)) return para
      return para.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
    })
    .join('\n\n')
}

   
                                                            
   
export function toMarkdownHardBreaksText(source: string): string {
  return source
    .split(/\n\n+/)
    .map((para) => {
      if (!para.trim()) return para
      return para
        .split('\n')
        .map((ln, i, arr) => {
          if (i === arr.length - 1) return ln
                      
          if (/\s\s+$/.test(ln)) return ln
          return ln.replace(/\s+$/, '') + '  '
        })
        .join('\n')
    })
    .join('\n\n')
}

   
                        
   
export function fromMarkdownHardBreaksText(source: string): string {
  return source.replace(/[ \t]{2,}\n/g, '\n')
}

function applyToSelectionOrAll(
  view: EditorView,
  transform: (s: string) => string,
  userEvent: string,
): boolean {
  const state = view.state
  const main = state.selection.main
  const from = main.empty ? 0 : main.from
  const to = main.empty ? state.doc.length : main.to
  const before = state.sliceDoc(from, to)
  const after = transform(before)
  if (after === before) return false
  view.dispatch({
    changes: { from, to, insert: after },
    selection: EditorSelection.range(from, from + after.length),
    userEvent,
  })
  view.focus()
  return true
}

                   
export const hardWrapSelection = (width = 80): Command => (view) =>
  applyToSelectionOrAll(view, (s) => hardWrapText(s, width), 'input.wrap.paragraph')

                  
export const unwrapParagraphs: Command = (view) =>
  applyToSelectionOrAll(view, unwrapParagraphsText, 'input.unwrap.paragraph')

                            
export const toMarkdownHardBreaks: Command = (view) =>
  applyToSelectionOrAll(view, toMarkdownHardBreaksText, 'input.hardbreaks.on')

                             
export const fromMarkdownHardBreaks: Command = (view) =>
  applyToSelectionOrAll(view, fromMarkdownHardBreaksText, 'input.hardbreaks.off')

// -----------------------------------------------------------------------------
                       
// -----------------------------------------------------------------------------

                                          
export const increaseQuoteLevel: Command = (view) => {
  const state = view.state
  const range = state.selection.main
  const from = state.doc.lineAt(range.from).from
  const to = state.doc.lineAt(range.to).to
  const text = state.doc.sliceString(from, to)
  const next = text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n')
  if (next === text) return false
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
    userEvent: 'input.quote.increase',
  })
  return true
}

                                    
export const decreaseQuoteLevel: Command = (view) => {
  const state = view.state
  const range = state.selection.main
  const from = state.doc.lineAt(range.from).from
  const to = state.doc.lineAt(range.to).to
  const text = state.doc.sliceString(from, to)
  const next = text
    .split('\n')
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n')
  if (next === text) return false
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
    userEvent: 'input.quote.decrease',
  })
  return true
}

                                
function sortLinesByComparator(
  view: EditorView,
  cmp: (a: string, b: string) => number,
  userEvent: string,
): boolean {
  const state = view.state
  const range = state.selection.main
  const from = state.doc.lineAt(range.from).from
  const to = state.doc.lineAt(range.to).to
  if (from === to) return false
  const block = state.doc.sliceString(from, to)
  const lines = block.split('\n')
  if (lines.length < 2) return false
  const sorted = [...lines].sort(cmp)
  if (sorted.every((l, i) => l === lines[i])) return false
  view.dispatch({
    changes: { from, to, insert: sorted.join('\n') },
    selection: EditorSelection.range(from, from + sorted.join('\n').length),
    userEvent,
  })
  return true
}

                   
export const sortSelectedLinesDesc: Command = (view) =>
  sortLinesByComparator(view, (a, b) => b.localeCompare(a), 'input.sort.desc')

                  
export const sortSelectedLinesByLengthAsc: Command = (view) =>
  sortLinesByComparator(view, (a, b) => a.length - b.length, 'input.sort.length.asc')

                  
export const sortSelectedLinesByLengthDesc: Command = (view) =>
  sortLinesByComparator(view, (a, b) => b.length - a.length, 'input.sort.length.desc')

                                  
export const sortSelectedLinesNumericAsc: Command = (view) => {
  const num = (s: string): number => {
    const m = /-?\d+(?:\.\d+)?/.exec(s)
    return m ? Number(m[0]) : 0
  }
  return sortLinesByComparator(view, (a, b) => num(a) - num(b), 'input.sort.numeric.asc')
}

                      
export const sortSelectedLinesNumericDesc: Command = (view) => {
  const num = (s: string): number => {
    const m = /-?\d+(?:\.\d+)?/.exec(s)
    return m ? Number(m[0]) : 0
  }
  return sortLinesByComparator(view, (a, b) => num(b) - num(a), 'input.sort.numeric.desc')
}

                                           
export const sortSelectedLinesNatural: Command = (view) => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return sortLinesByComparator(view, (a, b) => collator.compare(a, b), 'input.sort.natural')
}

// -----------------------------------------------------------------------------
                             
// -----------------------------------------------------------------------------

   
                                 
                             
   
export function exportOutlineToText(source: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) continue
    const level = m[1].length
    const title = m[2].replace(/\s*#*\s*$/, '').trim()
    if (!title) continue
    out.push('  '.repeat(level - 1) + '- ' + title)
  }
  return out.join('\n')
}

                                      
export const trimSectionBlanks: Command = (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const doc = view.state.doc
  const bodyStartLineNo = cur.headingLineNo + 1
  const bodyEndLineNo = cur.endLineNo
  if (bodyStartLineNo > bodyEndLineNo) return false
  const startLine = doc.line(bodyStartLineNo)
  const endLine = doc.line(bodyEndLineNo)
  const from = startLine.from
  const to = endLine.to
  const block = doc.sliceString(from, to)
  const trimmed = block.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '')
  if (trimmed === block) return false
  view.dispatch({
    changes: { from, to, insert: trimmed },
    userEvent: 'input.section.trim',
  })
  view.focus()
  return true
}

                                                         
export const insertAuthorAndDateFrontmatter: Command = (view) => {
  const doc = view.state.doc
  const text = doc.toString()
  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm) {
                     
    const block = `---\nauthor: \ndate: ${dateStr}\n---\n\n`
    view.dispatch({
      changes: { from: 0, insert: block },
      userEvent: 'input.frontmatter.author',
    })
    view.focus()
    return true
  }
  const body = fm[1]
  let nextBody = body
  if (!/^author\s*:/m.test(nextBody)) nextBody = `author: \n${nextBody}`
  if (!/^date\s*:/m.test(nextBody)) nextBody = `${nextBody}\ndate: ${dateStr}`
  if (nextBody === body) return false
  view.dispatch({
    changes: { from: 4, to: 4 + body.length, insert: nextBody },
    userEvent: 'input.frontmatter.author',
  })
  view.focus()
  return true
}

                                
export const expandSelectionToParagraph: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const doc = state.doc
  const startLine = doc.lineAt(main.from)
  const endLine = doc.lineAt(main.to)
  if (!startLine.text.trim() && !endLine.text.trim()) return false
  let s = startLine.number
  while (s > 1 && doc.line(s - 1).text.trim()) s--
  let e = endLine.number
  while (e < doc.lines && doc.line(e + 1).text.trim()) e++
  const from = doc.line(s).from
  const to = doc.line(e).to
  if (from === main.from && to === main.to) return false
  view.dispatch({
    selection: EditorSelection.range(from, to),
    userEvent: 'select.paragraph',
  })
  return true
}

                                 
export const selectToNextHeading: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const main = state.selection.main
  const startLine = doc.lineAt(main.from)
  let nextHeadingLine = -1
  for (let i = startLine.number + 1; i <= doc.lines; i++) {
    if (HEADING_LINE_PATTERN.test(doc.line(i).text)) {
      nextHeadingLine = i
      break
    }
  }
  const to = nextHeadingLine === -1 ? doc.length : doc.line(nextHeadingLine - 1).to
  if (to <= main.from) return false
  view.dispatch({
    selection: EditorSelection.range(main.from, to),
    userEvent: 'select.to-heading',
  })
  return true
}

// -----------------------------------------------------------------------------
// Section duplicate / selection stats / blockquote / heading lowercase
// -----------------------------------------------------------------------------

                                         
export const duplicateCurrentSection: Command = (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const doc = view.state.doc
  const from = doc.line(cur.headingLineNo).from
  const to = doc.line(cur.endLineNo).to
  const text = doc.sliceString(from, to)
  const insertAt = to
  const insert = '\n\n' + text
  view.dispatch({
    changes: { from: insertAt, insert },
    selection: EditorSelection.cursor(insertAt + insert.length),
    userEvent: 'input.section.duplicate',
  })
  view.focus()
  return true
}

   
                           
   
export function getSelectionStats(view: EditorView): {
  chars: number
  charsNoSpaces: number
  words: number
  lines: number
} {
  const state = view.state
  const main = state.selection.main
  const text = main.empty
    ? state.doc.toString()
    : state.doc.sliceString(main.from, main.to)
  const chars = text.length
  const charsNoSpaces = text.replace(/\s+/g, '').length
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const englishWords = (text.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) || []).length
  const cjkChars = (text.match(/\p{Script=Han}/gu) || []).length
  const words = englishWords + cjkChars
  return { chars, charsNoSpaces, words, lines }
}

   
                                      
  
      
      
      
      
  
      
      
      
      
      
      
      
      
   
export function mergeAdjacentBlockquotesText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    if (cur.trim() === '' && i > 0 && i < lines.length - 1) {
                      
      const prev = lines[i - 1]
      const next = lines[i + 1]
      if (/^\s*>/.test(prev) && /^\s*>/.test(next)) continue
    }
    out.push(cur)
  }
  return out.join('\n')
}

                      
export const mergeAdjacentBlockquotes: Command = (view) =>
  applyToSelectionOrAll(view, mergeAdjacentBlockquotesText, 'input.blockquote.merge')

                                  
export function lowercaseHeadingsText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const m = /^(\s*#{1,6}\s+)(.*)$/.exec(line)
      if (!m) return line
      return m[1] + m[2].toLowerCase()
    })
    .join('\n')
}

                 
export const lowercaseAllHeadings: Command = (view) =>
  applyToSelectionOrAll(view, lowercaseHeadingsText, 'input.headings.lowercase')

              
export function uppercaseHeadingsText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const m = /^(\s*#{1,6}\s+)(.*)$/.exec(line)
      if (!m) return line
      return m[1] + m[2].toUpperCase()
    })
    .join('\n')
}

export const uppercaseAllHeadings: Command = (view) =>
  applyToSelectionOrAll(view, uppercaseHeadingsText, 'input.headings.uppercase')

// -----------------------------------------------------------------------------
                                     
// -----------------------------------------------------------------------------

export type TemplateContext = {
                    
  title?: string
                      
  vars?: Record<string, string>
                           
  now?: Date
}

   
          
                                     
                                
                       
                                   
                                 
   
export function expandTemplateVariables(template: string, ctx: TemplateContext = {}): string {
  const now = ctx.now ?? new Date()
  const fmtDate = (pattern = 'YYYY-MM-DD'): string => formatWithPattern(pattern, now)
  return template.replace(/\{\{([^}]+)\}\}/g, (full, raw) => {
    const expr = String(raw).trim()
    if (expr === 'cursor') return '{{cursor}}'
    if (expr === 'date') return fmtDate('YYYY-MM-DD')
    if (expr === 'time') return fmtDate('HH:mm')
    if (expr === 'title') return ctx.title ?? ''
    const colon = expr.indexOf(':')
    if (colon !== -1) {
      const key = expr.slice(0, colon).trim()
      const pattern = expr.slice(colon + 1)
      if (key === 'date' || key === 'time') return fmtDate(pattern)
    }
    if (ctx.vars && expr in ctx.vars) return ctx.vars[expr]
    return full
  })
}

function formatWithPattern(pattern: string, d: Date): string {
  const y = d.getFullYear()
  const mo = d.getMonth() + 1
  const da = d.getDate()
  const h = d.getHours()
  const mi = d.getMinutes()
  const s = d.getSeconds()
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/YY/g, pad(y % 100))
    .replace(/MM/g, pad(mo))
    .replace(/DD/g, pad(da))
    .replace(/HH/g, pad(h))
    .replace(/mm/g, pad(mi))
    .replace(/ss/g, pad(s))
}

   
                                           
   
export function insertTemplateText(view: EditorView, template: string, ctx: TemplateContext = {}): boolean {
  const expanded = expandTemplateVariables(template, ctx)
  const cursorIdx = expanded.indexOf('{{cursor}}')
  const final = cursorIdx === -1 ? expanded : expanded.replace(/\{\{cursor\}\}/, '')
  const state = view.state
  const main = state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: final },
    selection: EditorSelection.cursor(
      main.from + (cursorIdx === -1 ? final.length : cursorIdx),
    ),
    userEvent: 'input.template',
  })
  view.focus()
  return true
}

                                                   
export function getNoteProperties(source: string): { keys: string[]; map: Record<string, string> } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  const keys: string[] = []
  const map: Record<string, string> = {}
  if (!fm) return { keys, map }
  for (const line of fm[1].split('\n')) {
    const m = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, v] = m
    keys.push(k)
    map[k] = v
  }
  return { keys, map }
}

   
                                         
                       
   
export function setNotePropertyText(source: string, key: string, value: string | null): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  const isDelete = value === null
  if (!fm) {
    if (isDelete) return source
    return `---\n${key}: ${value}\n---\n\n${source}`
  }
  const body = fm[1]
  const lines = body.split('\n')
  const idx = lines.findIndex((l) => new RegExp('^' + key + '\\s*:').test(l))
  if (idx === -1) {
    if (isDelete) return source
    const newBody = body + (body.endsWith('\n') ? '' : '\n') + `${key}: ${value}`
    return source.replace(fm[0], `---\n${newBody}\n---`)
  }
  if (isDelete) {
    lines.splice(idx, 1)
  } else {
    lines[idx] = `${key}: ${value}`
  }
  return source.replace(fm[0], `---\n${lines.join('\n')}\n---`)
}

                                
export function setNoteProperty(view: EditorView, key: string, value: string | null): boolean {
  const text = view.state.doc.toString()
  const next = setNotePropertyText(text, key, value)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.property',
  })
  view.focus()
  return true
}

                                                     
export const insertImageEmbedWithSize = (file: string, width = 400): Command => (view) => {
  const text = `![[${file}|${width}]]`
  const state = view.state
  const main = state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: EditorSelection.cursor(main.from + text.length),
    userEvent: 'input.image.embed',
  })
  view.focus()
  return true
}

                                                                      
export function convertImagesToWikilinksText(source: string): string {
  return source.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt, href) => {
    if (/^https?:\/\//i.test(href)) return full
    if (!/\.(?:png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(href)) return full
    const altPart = alt ? `|${alt}` : ''
    return `![[${href}${altPart}]]`
  })
}

export const convertImagesToWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, convertImagesToWikilinksText, 'input.image.wikilink')

                                               
export function convertImageWikilinksToMarkdownText(source: string): string {
  return source.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, href) => {
    return `![](${href})`
  })
}

export const convertImageWikilinksToMarkdown: Command = (view) =>
  applyToSelectionOrAll(view, convertImageWikilinksToMarkdownText, 'input.image.markdown')

// -----------------------------------------------------------------------------
                                                        
// -----------------------------------------------------------------------------

   
                                                 
   
export const surroundSelection = (left: string, right: string): Command => (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    view.dispatch({
      changes: { from: main.from, insert: left + right },
      selection: EditorSelection.cursor(main.from + left.length),
      userEvent: 'input.surround',
    })
    view.focus()
    return true
  }
  const text = state.sliceDoc(main.from, main.to)
  const wrapped = left + text + right
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: wrapped },
    selection: EditorSelection.range(main.from + left.length, main.from + left.length + text.length),
    userEvent: 'input.surround',
  })
  view.focus()
  return true
}

   
                                            
                          
   
export const pasteUrlAsLink = (url: string): Command => (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    const insert = `<${url}>`
    view.dispatch({
      changes: { from: main.from, insert },
      selection: EditorSelection.cursor(main.from + insert.length),
      userEvent: 'input.link.paste',
    })
    view.focus()
    return true
  }
  const text = state.sliceDoc(main.from, main.to)
  const out = `[${text}](${url})`
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: out },
    selection: EditorSelection.cursor(main.from + out.length),
    userEvent: 'input.link.paste',
  })
  view.focus()
  return true
}

                   
export function cleanupZeroWidthCharsText(source: string): string {
  return source.replace(/[​‌‍﻿]/g, '')
}

export const cleanupZeroWidthChars: Command = (view) =>
  applyToSelectionOrAll(view, cleanupZeroWidthCharsText, 'input.cleanup.zerowidth')

                               
export const normalizeUnicodeNFC: Command = (view) =>
  applyToSelectionOrAll(view, (s) => s.normalize('NFC'), 'input.normalize.nfc')

                               
export const normalizeUnicodeNFD: Command = (view) =>
  applyToSelectionOrAll(view, (s) => s.normalize('NFD'), 'input.normalize.nfd')

   
                        
   
export const toggleHighlight: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    view.dispatch({
      changes: { from: main.from, insert: '====' },
      selection: EditorSelection.cursor(main.from + 2),
      userEvent: 'input.highlight',
    })
    view.focus()
    return true
  }
  const text = state.sliceDoc(main.from, main.to)
  if (text.startsWith('==') && text.endsWith('==') && text.length >= 4) {
    const inner = text.slice(2, -2)
    view.dispatch({
      changes: { from: main.from, to: main.to, insert: inner },
      selection: EditorSelection.range(main.from, main.from + inner.length),
      userEvent: 'input.highlight',
    })
    view.focus()
    return true
  }
  const wrapped = `==${text}==`
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: wrapped },
    selection: EditorSelection.range(main.from + 2, main.from + 2 + text.length),
    userEvent: 'input.highlight',
  })
  view.focus()
  return true
}

                                
export function transformToSentenceCaseText(text: string): string {
  if (!text) return text
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export const transformToSentenceCase: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) return false
  const text = state.sliceDoc(main.from, main.to)
  const next = transformToSentenceCaseText(text)
  if (next === text) return false
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: next },
    selection: EditorSelection.range(main.from, main.from + next.length),
    userEvent: 'input.case.sentence',
  })
  view.focus()
  return true
}

// -----------------------------------------------------------------------------
                                    
// -----------------------------------------------------------------------------

export type LinkRef = { label: string; url: string }

                                                  
export function extractAllLinks(source: string): LinkRef[] {
  const out: LinkRef[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const re = /(?<!\!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      out.push({ label: m[1], url: m[2] })
    }
  }
  return out
}

                                   
export function extractAllImages(source: string): LinkRef[] {
  const out: LinkRef[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      out.push({ label: m[1], url: m[2] })
    }
  }
  return out
}

                                                           
export function unwrapAllLinksToPlainTextText(source: string): string {
  return source.replace(/(?<!\!)\[([^\]]+)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, '$1')
}

export const unwrapAllLinksToPlainText: Command = (view) =>
  applyToSelectionOrAll(view, unwrapAllLinksToPlainTextText, 'input.link.unwrap-all')

                       
export const surroundCurrentLineWith = (left: string, right: string): Command => (view) => {
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: left + line.text + right },
    userEvent: 'input.line.surround',
  })
  view.focus()
  return true
}

                                                         
export const insertSeparatorComment = (title = ''): Command => (view) => {
  const inner = title ? ` ${title} ` : ' === '
  const text = `<!-- ${'='.repeat(5)}${inner}${'='.repeat(5)} -->`
  const state = view.state
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  const insert = (line.text === '' ? '' : '\n') + text + '\n'
  view.dispatch({
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(line.to + insert.length),
    userEvent: 'input.separator',
  })
  view.focus()
  return true
}

                                                                
export const insertLinksSummary: Command = (view) => {
  const text = view.state.doc.toString()
  const links = extractAllLinks(text)
  if (links.length === 0) return false
  const unique = Array.from(new Set(links.map((l) => `${l.label} — ${l.url}`)))
  const block = '\n## Links\n\n' + unique.map((l) => `- ${l}`).join('\n') + '\n'
  const state = view.state
  const main = state.selection.main
  view.dispatch({
    changes: { from: main.from, insert: block },
    selection: EditorSelection.cursor(main.from + block.length),
    userEvent: 'input.links.summary',
  })
  view.focus()
  return true
}

                
export const insertImagesSummary: Command = (view) => {
  const text = view.state.doc.toString()
  const imgs = extractAllImages(text)
  if (imgs.length === 0) return false
  const block = '\n## Images\n\n' + imgs.map((i) => `- ${i.label || '(no alt)'} → ${i.url}`).join('\n') + '\n'
  const state = view.state
  const main = state.selection.main
  view.dispatch({
    changes: { from: main.from, insert: block },
    selection: EditorSelection.cursor(main.from + block.length),
    userEvent: 'input.images.summary',
  })
  view.focus()
  return true
}

// -----------------------------------------------------------------------------
// Jump to next code block / task; table ↔ bullet list
// -----------------------------------------------------------------------------

function findFenceLines(doc: { lines: number; line(n: number): { text: string; from: number } }): number[] {
  const out: number[] = []
  for (let i = 1; i <= doc.lines; i++) {
    if (/^\s*```/.test(doc.line(i).text)) out.push(i)
  }
  return out
}

                                    
export const jumpToNextCodeBlock: Command = (view) => {
  const doc = view.state.doc
  const fences = findFenceLines(doc)
  if (fences.length === 0) return false
  const curLine = doc.lineAt(view.state.selection.main.head).number
  for (let i = 0; i < fences.length; i += 2) {
    if (fences[i] > curLine) {
      const pos = doc.line(fences[i]).from
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
      return true
    }
  }
  return false
}

                           
export const jumpToPrevCodeBlock: Command = (view) => {
  const doc = view.state.doc
  const fences = findFenceLines(doc)
  if (fences.length === 0) return false
  const curLine = doc.lineAt(view.state.selection.main.head).number
  for (let i = fences.length - 2; i >= 0; i -= 2) {
    if (fences[i] < curLine) {
      const pos = doc.line(fences[i]).from
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
      return true
    }
  }
  return false
}

const TASK_LINE = /^\s*[-*+]\s+\[[ xX]\]\s+/

                
export const jumpToNextTask: Command = (view) => {
  const doc = view.state.doc
  const curLine = doc.lineAt(view.state.selection.main.head).number
  for (let i = curLine + 1; i <= doc.lines; i++) {
    if (TASK_LINE.test(doc.line(i).text)) {
      const pos = doc.line(i).from
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
      return true
    }
  }
  return false
}

                
export const jumpToPrevTask: Command = (view) => {
  const doc = view.state.doc
  const curLine = doc.lineAt(view.state.selection.main.head).number
  for (let i = curLine - 1; i >= 1; i--) {
    if (TASK_LINE.test(doc.line(i).text)) {
      const pos = doc.line(i).from
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
      return true
    }
  }
  return false
}

   
                             
                                        
                   
   
export function tableToBulletsText(source: string): string {
  const lines = source.split('\n')
  const rows: string[][] = []
  let inTable = false
  let header: string[] = []
  let seenSep = false
  const out: string[] = []
  const flush = () => {
    if (rows.length === 0 && header.length === 0) return
    for (const row of rows) {
      const parts = header.map((h, i) => `${h}: ${row[i] ?? ''}`).join(', ')
      out.push('- ' + parts)
    }
    rows.length = 0
    header = []
    seenSep = false
    inTable = false
  }
  for (const line of lines) {
    if (/^\s*\|/.test(line) && /\|\s*$/.test(line.trim())) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim())
      if (!inTable) {
        inTable = true
        header = cells
        continue
      }
      if (!seenSep) {
        if (cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))) {
          seenSep = true
          continue
        }
        rows.push(header)
        header = []
        seenSep = true
        rows.push(cells)
        continue
      }
      rows.push(cells)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

export const tableToBulletList: Command = (view) =>
  applyToSelectionOrAll(view, tableToBulletsText, 'input.table.bullets')

                                                 
export function bulletsToTableText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let block: string[] = []
  const flush = () => {
    if (block.length === 0) return
    const rows = block.map((l) => {
      const body = l.replace(/^\s*[-*+]\s+/, '')
      return body.split('|').map((c) => c.trim())
    })
    const width = Math.max(...rows.map((r) => r.length))
    const padded = rows.map((r) => r.concat(Array(width - r.length).fill('')))
    const header = padded.shift()!
    const sep = Array(width).fill('---')
    const lines2 = [
      '| ' + header.join(' | ') + ' |',
      '| ' + sep.join(' | ') + ' |',
      ...padded.map((r) => '| ' + r.join(' | ') + ' |'),
    ]
    out.push(lines2.join('\n'))
    block = []
  }
  for (const line of lines) {
    if (/^\s*[-*+]\s+.+\|.+/.test(line)) {
      block.push(line)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

export const bulletListToTable: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToTableText, 'input.bullets.table')

// -----------------------------------------------------------------------------
// Frontmatter key ops + heading slug + clipboard helpers
// -----------------------------------------------------------------------------

/** Toggle a YAML key in frontmatter. Adds `key: value` if missing, deletes if present. */
export function toggleFrontmatterKeyText(source: string, key: string, value = 'true'): string {
  const props = getNoteProperties(source)
  if (props.map[key] === undefined) {
    return setNotePropertyText(source, key, value)
  }
  return setNotePropertyText(source, key, null)
}

export const toggleFrontmatterKey = (key: string, value = 'true'): Command => (view) => {
  const text = view.state.doc.toString()
  const next = toggleFrontmatterKeyText(text, key, value)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.frontmatter.toggle',
  })
  view.focus()
  return true
}

/** Rename a frontmatter key, preserving value and position. */
export function renameFrontmatterKeyText(source: string, oldKey: string, newKey: string): string {
  if (oldKey === newKey) return source
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const lines = fm[1].split('\n')
  let changed = false
  const next = lines.map((line) => {
    const m = new RegExp('^(' + oldKey + ')(\\s*:.*)$').exec(line)
    if (!m) return line
    changed = true
    return newKey + m[2]
  })
  if (!changed) return source
  return source.replace(fm[0], `---\n${next.join('\n')}\n---`)
}

export const renameFrontmatterKey = (oldKey: string, newKey: string): Command => (view) => {
  const text = view.state.doc.toString()
  const next = renameFrontmatterKeyText(text, oldKey, newKey)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.frontmatter.rename',
  })
  view.focus()
  return true
}

/** Sort the list-valued frontmatter value (`tags: [a, c, b]` → `tags: [a, b, c]`). */
export function sortFrontmatterValuesText(source: string, key: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const lines = fm[1].split('\n')
  const idx = lines.findIndex((l) => new RegExp('^' + key + '\\s*:').test(l))
  if (idx === -1) return source
  const line = lines[idx]
  const inline = /^([A-Za-z0-9_\-]+)\s*:\s*\[(.*)\]\s*$/.exec(line)
  if (inline) {
    const items = inline[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    items.sort((a, b) => a.localeCompare(b))
    lines[idx] = `${inline[1]}: [${items.join(', ')}]`
    return source.replace(fm[0], `---\n${lines.join('\n')}\n---`)
  }
  // dash list form: `key:\n  - a\n  - b\n`
  const dashHead = /^([A-Za-z0-9_\-]+)\s*:\s*$/.exec(line)
  if (!dashHead) return source
  let end = idx + 1
  while (end < lines.length && /^\s+-\s+/.test(lines[end])) end++
  const items = lines.slice(idx + 1, end).map((l) => l.replace(/^\s+-\s+/, '').trim())
  items.sort((a, b) => a.localeCompare(b))
  const indent = (lines[idx + 1] || '  ').match(/^\s*/)?.[0] ?? '  '
  const newBlock = [line, ...items.map((it) => `${indent}- ${it}`)]
  const merged = [...lines.slice(0, idx), ...newBlock, ...lines.slice(end)]
  return source.replace(fm[0], `---\n${merged.join('\n')}\n---`)
}

export const sortFrontmatterValues = (key: string): Command => (view) => {
  const text = view.state.doc.toString()
  const next = sortFrontmatterValuesText(text, key)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.frontmatter.sortvalues',
  })
  view.focus()
  return true
}

/** Slugify a heading text into a `block-id`-safe slug. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-]/gu, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

   
                                                
   
export function slugifyHeadingsText(source: string): string {
  const lines = source.split('\n')
  const seen = new Set<string>()
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const tail = m[2]
    if (/\s\^[A-Za-z0-9\-]+$/.test(tail)) continue
    const slug = headingSlug(tail) || 'h'
    let unique = slug
    let n = 1
    while (seen.has(unique)) unique = `${slug}-${++n}`
    seen.add(unique)
    lines[i] = `${m[1]} ${tail} ^${unique}`
  }
  return lines.join('\n')
}

export const slugifyHeadings: Command = (view) => {
  const text = view.state.doc.toString()
  const next = slugifyHeadingsText(text)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.headings.slug',
  })
  view.focus()
  return true
}

                                         
export const copyPlainTextOfSelection: Command = (view) => {
  const main = view.state.selection.main
  const text =
    main.empty
      ? view.state.doc.toString()
      : view.state.sliceDoc(main.from, main.to)
  const plain = stripMarkdownToPlainText(text)
  try {
    void navigator.clipboard?.writeText(plain)
  } catch {
    // ignore — environments without clipboard
  }
  return true
}

                                                              
export function stripMarkdownToPlainText(source: string): string {
  return source
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?(?:#[^\]]+)?\]\]/g, (_, a, b) => b || a)
}

// -----------------------------------------------------------------------------
// Fold current section / unfold all + selection → list + wrap as %% comment %%
// -----------------------------------------------------------------------------

                                                           
export const foldCurrentSection: Command = (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const doc = view.state.doc
  const headingLine = doc.line(cur.headingLineNo)
  const endLine = doc.line(cur.endLineNo)
  if (endLine.to <= headingLine.to) return false
  view.dispatch({
    effects: foldEffect.of({ from: headingLine.to, to: endLine.to }),
  })
  return true
}

                                                                 
export const unfoldAllSections: Command = (view) => {
  return unfoldAll(view)
}

   
                                         
   
export function selectionToBulletListText(source: string): string {
  if (source.length === 0) return source
  return source
    .split('\n')
    .map((l) => (l.trim() ? `- ${l}` : '-'))
    .join('\n')
}

export const selectionToBulletList: Command = (view) =>
  applyToSelectionOrAll(view, selectionToBulletListText, 'input.selection.bullet')

                             
export function selectionToOrderedListText(source: string): string {
  if (source.length === 0) return source
  let n = 0
  return source
    .split('\n')
    .map((l) => {
      if (!l.trim()) return ''
      n += 1
      return `${n}. ${l}`
    })
    .join('\n')
}

export const selectionToOrderedList: Command = (view) =>
  applyToSelectionOrAll(view, selectionToOrderedListText, 'input.selection.olist')

                               
export function selectionToTaskListText(source: string): string {
  if (source.length === 0) return source
  return source
    .split('\n')
    .map((l) => (l.trim() ? `- [ ] ${l}` : ''))
    .join('\n')
}

export const selectionToTaskList: Command = (view) =>
  applyToSelectionOrAll(view, selectionToTaskListText, 'input.selection.tasklist')

                                          
export const wrapSelectionAsComment: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  if (main.empty) {
    const insert = '%%comment%%'
    view.dispatch({
      changes: { from: main.from, insert },
      selection: EditorSelection.cursor(main.from + 2),
      userEvent: 'input.comment',
    })
    view.focus()
    return true
  }
  const text = state.sliceDoc(main.from, main.to)
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: `%%${text}%%` },
    selection: EditorSelection.range(main.from + 2, main.from + 2 + text.length),
    userEvent: 'input.comment',
  })
  view.focus()
  return true
}

                             
export function unwrapCommentText(source: string): string {
  return source.replace(/%%([\s\S]*?)%%/g, (_, inner) => inner)
}

export const unwrapComment: Command = (view) =>
  applyToSelectionOrAll(view, unwrapCommentText, 'input.uncomment')

// -----------------------------------------------------------------------------
// Paragraph swap + document byte size + ordered↔bullet conversions + blockquote author
// -----------------------------------------------------------------------------

type Paragraph = { from: number; to: number; lineFrom: number; lineTo: number }

function findCurrentParagraph(state: EditorState): Paragraph | null {
  const doc = state.doc
  const startNo = doc.lineAt(state.selection.main.from).number
  if (doc.line(startNo).text.trim().length === 0) return null
  let lo = startNo
  while (lo > 1 && doc.line(lo - 1).text.trim().length > 0) lo--
  let hi = startNo
  while (hi < doc.lines && doc.line(hi + 1).text.trim().length > 0) hi++
  return {
    from: doc.line(lo).from,
    to: doc.line(hi).to,
    lineFrom: lo,
    lineTo: hi,
  }
}

function findNextParagraph(state: EditorState, after: number): Paragraph | null {
  const doc = state.doc
  let lo = after + 1
  while (lo <= doc.lines && doc.line(lo).text.trim().length === 0) lo++
  if (lo > doc.lines) return null
  let hi = lo
  while (hi < doc.lines && doc.line(hi + 1).text.trim().length > 0) hi++
  return {
    from: doc.line(lo).from,
    to: doc.line(hi).to,
    lineFrom: lo,
    lineTo: hi,
  }
}

function findPrevParagraph(state: EditorState, before: number): Paragraph | null {
  const doc = state.doc
  let hi = before - 1
  while (hi >= 1 && doc.line(hi).text.trim().length === 0) hi--
  if (hi < 1) return null
  let lo = hi
  while (lo > 1 && doc.line(lo - 1).text.trim().length > 0) lo--
  return {
    from: doc.line(lo).from,
    to: doc.line(hi).to,
    lineFrom: lo,
    lineTo: hi,
  }
}

/** Swap the cursor's paragraph with the next or previous one. */
export const swapAdjacentParagraphs = (dir: 'up' | 'down'): Command => (view) => {
  const cur = findCurrentParagraph(view.state)
  if (!cur) return false
  const other =
    dir === 'down'
      ? findNextParagraph(view.state, cur.lineTo)
      : findPrevParagraph(view.state, cur.lineFrom)
  if (!other) return false
  const state = view.state
  const a = state.sliceDoc(cur.from, cur.to)
  const b = state.sliceDoc(other.from, other.to)
  const first = dir === 'down' ? cur : other
  const second = dir === 'down' ? other : cur
  const firstText = dir === 'down' ? b : a
  const secondText = dir === 'down' ? a : b
  view.dispatch({
    changes: [
      { from: first.from, to: first.to, insert: firstText },
      { from: second.from, to: second.to, insert: secondText },
    ],
    userEvent: 'input.paragraph.swap',
  })
  return true
}

/** Total document size in UTF-8 bytes. */
export function getDocumentSizeBytes(state: EditorState): number {
  return new TextEncoder().encode(state.doc.toString()).length
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const showDocumentByteSize: Command = (view) => {
  const n = getDocumentSizeBytes(view.state)
  try {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(`Document size: ${formatBytes(n)} (${n} bytes)`)
    }
  } catch {
    // ignore
  }
  return true
}

/** Convert `1. foo` style ordered list lines to `- foo` style. Preserve indent. */
export function convertOrderedToBulletText(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/^(\s*)\d+\.\s+/, '$1- '))
    .join('\n')
}

/**
 * Convert `- foo` style bullet lines to `1. foo` style ordered list.
 * Auto-numbers per contiguous block of same indent level (top-level 0).
 */
export function convertBulletToOrderedText(source: string): string {
  const lines = source.split('\n')
  let counter = 0
  let prevWasBullet = false
  const out: string[] = []
  for (const line of lines) {
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (m) {
      if (!prevWasBullet) counter = 0
      counter += 1
      prevWasBullet = true
      out.push(`${m[1]}${counter}. ${m[2]}`)
    } else {
      prevWasBullet = false
      out.push(line)
    }
  }
  return out.join('\n')
}

export const convertOrderedToBullet: Command = (view) =>
  applyToSelectionOrAll(view, convertOrderedToBulletText, 'input.ol.to.ul')

export const convertBulletToOrdered: Command = (view) =>
  applyToSelectionOrAll(view, convertBulletToOrderedText, 'input.ul.to.ol')

   
                                                
   
export const addBlockquoteAuthor = (name: string): Command => (view) => {
  const doc = view.state.doc
  const head = view.state.selection.main.head
  const lineNo = doc.lineAt(head).number
  if (!/^\s*>/.test(doc.line(lineNo).text)) return false
  let endNo = lineNo
  while (endNo < doc.lines && /^\s*>/.test(doc.line(endNo + 1).text)) endNo++
  const endLine = doc.line(endNo)
  const trailing = ` — ${name}`
  if (endLine.text.includes(trailing)) return false
  view.dispatch({
    changes: { from: endLine.to, insert: trailing },
    userEvent: 'input.quote.author',
  })
  view.focus()
  return true
}

                                 
export const stripBlockquoteAuthor: Command = (view) => {
  const doc = view.state.doc
  const head = view.state.selection.main.head
  const lineNo = doc.lineAt(head).number
  if (!/^\s*>/.test(doc.line(lineNo).text)) return false
  let endNo = lineNo
  while (endNo < doc.lines && /^\s*>/.test(doc.line(endNo + 1).text)) endNo++
  const endLine = doc.line(endNo)
  const newText = endLine.text.replace(/\s+—\s+[^\n]+$/, '')
  if (newText === endLine.text) return false
  view.dispatch({
    changes: { from: endLine.from, to: endLine.to, insert: newText },
    userEvent: 'input.quote.author.strip',
  })
  view.focus()
  return true
}

// -----------------------------------------------------------------------------
// Empty image alt fill + inline ↔ reference links + emoji bullets + line numbers
// -----------------------------------------------------------------------------

                                                         
export function fillEmptyImageAltText(source: string): string {
  return source.replace(/!\[\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_, url, title) => {
    const fname = url.split(/[\/\\]/).pop() || ''
    const base = fname.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'image'
    return `![${base}](${url}${title ?? ''})`
  })
}

export const fillEmptyImageAlt: Command = (view) =>
  applyToSelectionOrAll(view, fillEmptyImageAltText, 'input.image.alt.fill')

                                                               
export function expandShortLinksToReferenceText(source: string): string {
  const refs: { url: string; title?: string }[] = []
  const seen = new Map<string, number>()
  const replaced = source.replace(
    /(?<!\!)\[([^\]]+)\]\(([^)\s]+)(\s+"([^"]*)")?\)/g,
    (_, label, url, _all, title) => {
      const key = url + '||' + (title || '')
      let idx = seen.get(key)
      if (idx == null) {
        idx = refs.length + 1
        refs.push({ url, title })
        seen.set(key, idx)
      }
      return `[${label}][${idx}]`
    },
  )
  if (refs.length === 0) return source
  const defs = refs
    .map((r, i) => `[${i + 1}]: ${r.url}${r.title ? ` "${r.title}"` : ''}`)
    .join('\n')
  return replaced.replace(/\n*$/, '') + '\n\n' + defs + '\n'
}

export const expandShortLinksToReference: Command = (view) =>
  applyToSelectionOrAll(view, expandShortLinksToReferenceText, 'input.links.toref')

                                                      
export function inlineReferenceLinksText(source: string): string {
  const refRe = /^\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/gm
  const defs = new Map<string, { url: string; title?: string }>()
  let m: RegExpExecArray | null
  while ((m = refRe.exec(source)) !== null) {
    defs.set(m[1], { url: m[2], title: m[3] })
  }
  if (defs.size === 0) return source
  let next = source.replace(/(?<!\!)\[([^\]]+)\]\[([^\]]+)\]/g, (full, label, key) => {
    const d = defs.get(key)
    if (!d) return full
    return `[${label}](${d.url}${d.title ? ` "${d.title}"` : ''})`
  })
  next = next.replace(refRe, '')
  return next.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
}

export const inlineReferenceLinks: Command = (view) =>
  applyToSelectionOrAll(view, inlineReferenceLinksText, 'input.links.toinline')

                                    
const EMOJI_BULLETS = ['🔹', '✨', '🌱', '⭐', '🍀', '🔸']
export function emojiBulletText(source: string): string {
  let i = 0
  return source
    .split('\n')
    .map((l) => {
      const m = /^(\s*)[-*+]\s+(.*)$/.exec(l)
      if (!m) return l
      const e = EMOJI_BULLETS[i++ % EMOJI_BULLETS.length]
      return `${m[1]}${e} ${m[2]}`
    })
    .join('\n')
}

export const emojiBullet: Command = (view) =>
  applyToSelectionOrAll(view, emojiBulletText, 'input.bullet.emoji')

                               
export function numberLinesText(source: string): string {
  const lines = source.split('\n')
  const w = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(w, ' ')}: ${l}`).join('\n')
}

export const numberLines: Command = (view) =>
  applyToSelectionOrAll(view, numberLinesText, 'input.lines.number')

                                    
export function unnumberLinesText(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/^\s*\d+:\s/, ''))
    .join('\n')
}

export const unnumberLines: Command = (view) =>
  applyToSelectionOrAll(view, unnumberLinesText, 'input.lines.unnumber')

// -----------------------------------------------------------------------------
// URL cleanup + heading rename + dedup tags + wikilink ↔ footnote + strip images
// -----------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'igshid',
  'spm',
])

function cleanTrackingFromUrl(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return url
  const head = url.slice(0, q)
  const rest = url.slice(q + 1)
  const hash = rest.indexOf('#')
  const queryStr = hash === -1 ? rest : rest.slice(0, hash)
  const tail = hash === -1 ? '' : rest.slice(hash)
  const kept = queryStr
    .split('&')
    .filter((kv) => {
      const key = kv.split('=')[0]
      return key && !TRACKING_PARAMS.has(key)
    })
    .join('&')
  return head + (kept ? '?' + kept : '') + tail
}

/** Remove `utm_*`, `gclid`, `fbclid` etc. from every URL in `[label](url)` and `(?<![`)<url>`. */
export function cleanTrackingParamsText(source: string): string {
  let out = source.replace(/(\[[^\]]+\]\()([^)\s]+)(\s+"[^"]*")?(\))/g, (_, a, url, t, c) => {
    return a + cleanTrackingFromUrl(url) + (t ?? '') + c
  })
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => `<${cleanTrackingFromUrl(url)}>`)
  return out
}

export const cleanTrackingParams: Command = (view) =>
  applyToSelectionOrAll(view, cleanTrackingParamsText, 'input.url.clean')

/** decodeURIComponent every link target — useful when pasted URLs have `%20` etc. */
export function decodeUrlsInLinksText(source: string): string {
  return source.replace(/(\[[^\]]+\]\()([^)\s]+)(\s+"[^"]*")?(\))/g, (_, a, url, t, c) => {
    let dec = url
    try {
      dec = decodeURIComponent(url)
    } catch {
      // ignore
    }
    return a + dec + (t ?? '') + c
  })
}

export const decodeUrlsInLinks: Command = (view) =>
  applyToSelectionOrAll(view, decodeUrlsInLinksText, 'input.url.decode')

/** Rename a heading text everywhere (the heading line + wikilink anchors `[[note#heading]]`). */
export function renameHeadingInDocText(source: string, oldText: string, newText: string): string {
  if (!oldText || oldText === newText) return source
  const escOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = source.replace(new RegExp('^(#{1,6})\\s+' + escOld + '(\\s*)$', 'gm'), (_, h, t) => `${h} ${newText}${t}`)
  out = out.replace(new RegExp('\\[\\[([^\\]|#]*)#' + escOld + '(\\|[^\\]]+)?\\]\\]', 'g'), (_, n, alias) => {
    return `[[${n}#${newText}${alias ?? ''}]]`
  })
  out = out.replace(new RegExp('\\[\\[#' + escOld + '(\\|[^\\]]+)?\\]\\]', 'g'), (_, alias) => {
    return `[[#${newText}${alias ?? ''}]]`
  })
  return out
}

export const renameHeadingInDoc = (oldText: string, newText: string): Command => (view) => {
  const text = view.state.doc.toString()
  const next = renameHeadingInDocText(text, oldText, newText)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.heading.rename',
  })
  view.focus()
  return true
}

/** Deduplicate items in `tags: [a, b, a]` or list-form `tags:\n - a\n - a` while preserving order. */
export function dedupFrontmatterTagsText(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const lines = fm[1].split('\n')
  const idx = lines.findIndex((l) => /^tags\s*:/.test(l))
  if (idx === -1) return source
  const inline = /^(tags)\s*:\s*\[(.*)\]\s*$/.exec(lines[idx])
  if (inline) {
    const seen = new Set<string>()
    const items: string[] = []
    for (const raw of inline[2].split(',')) {
      const v = raw.trim()
      if (!v) continue
      if (seen.has(v)) continue
      seen.add(v)
      items.push(v)
    }
    lines[idx] = `${inline[1]}: [${items.join(', ')}]`
    return source.replace(fm[0], `---\n${lines.join('\n')}\n---`)
  }
  // dash form
  let end = idx + 1
  while (end < lines.length && /^\s+-\s+/.test(lines[end])) end++
  const seen = new Set<string>()
  const kept: string[] = []
  for (const l of lines.slice(idx + 1, end)) {
    const v = l.replace(/^\s+-\s+/, '').trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    kept.push(l)
  }
  const merged = [...lines.slice(0, idx + 1), ...kept, ...lines.slice(end)]
  return source.replace(fm[0], `---\n${merged.join('\n')}\n---`)
}

export const dedupFrontmatterTags: Command = (view) => {
  const text = view.state.doc.toString()
  const next = dedupFrontmatterTagsText(text)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.frontmatter.dedup.tags',
  })
  view.focus()
  return true
}

/** Every `[[X]]` becomes `X[^N]` with corresponding `[^N]: [[X]]` definition at the end. */
export function wikilinkToFootnoteText(source: string): string {
  const links: string[] = []
  const replaced = source.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const display = alias || target
    links.push(target)
    return `${display}[^wl${links.length}]`
  })
  if (links.length === 0) return source
  const defs = links.map((t, i) => `[^wl${i + 1}]: [[${t}]]`).join('\n')
  return replaced.replace(/\n*$/, '') + '\n\n' + defs + '\n'
}

export const wikilinkToFootnote: Command = (view) =>
  applyToSelectionOrAll(view, wikilinkToFootnoteText, 'input.wikilink.footnote')

/** Remove every `![alt](url)` and `![[file]]` image embed. */
export function stripAllImagesText(source: string): string {
  return source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[\[[^\]]+\]\]/g, '')
}

export const stripAllImages: Command = (view) =>
  applyToSelectionOrAll(view, stripAllImagesText, 'input.images.strip')

// -----------------------------------------------------------------------------
// Code block language change + setext ↔ ATX heading conversion + wrap per line
// -----------------------------------------------------------------------------

function findEnclosingFence(state: EditorState): { openLine: number; closeLine: number } | null {
  const doc = state.doc
  const curLine = doc.lineAt(state.selection.main.head).number
  let open = -1
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    if (/^\s*```/.test(doc.line(i).text)) {
      if (!inFence) {
        if (i > curLine) break
        open = i
        inFence = true
      } else {
        if (i >= curLine && open !== -1 && open <= curLine) {
          return { openLine: open, closeLine: i }
        }
        inFence = false
        open = -1
      }
    }
  }
  return null
}

                                                  
export const wrapCodeBlockLang = (lang: string): Command => (view) => {
  const f = findEnclosingFence(view.state)
  if (!f) return false
  const doc = view.state.doc
  const openLine = doc.line(f.openLine)
  const cleanLang = lang.replace(/\s+/g, '')
  const m = /^(\s*```)(.*)$/.exec(openLine.text)
  if (!m) return false
  const next = `${m[1]}${cleanLang}`
  if (next === openLine.text) return false
  view.dispatch({
    changes: { from: openLine.from, to: openLine.to, insert: next },
    userEvent: 'input.fence.lang',
  })
  view.focus()
  return true
}

/** Setext H1 (`====`) / H2 (`----`) → ATX (`# `/`## `). */
export function convertSetextHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]
    if (lines[i].trim().length > 0 && next && /^=+\s*$/.test(next)) {
      out.push(`# ${lines[i]}`)
      i++
      continue
    }
    if (lines[i].trim().length > 0 && next && /^-+\s*$/.test(next) && next.trim().length >= 2) {
      out.push(`## ${lines[i]}`)
      i++
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

export const convertSetextHeadings: Command = (view) =>
  applyToSelectionOrAll(view, convertSetextHeadingsText, 'input.heading.setext.toatx')

/** ATX H1/H2 → setext. H3+ untouched. */
export function convertAtxToSetextText(source: string): string {
  return source
    .split('\n')
    .map((l) => {
      const m1 = /^# (.+?)\s*#*\s*$/.exec(l)
      if (m1) return `${m1[1]}\n${'='.repeat(Math.max(3, m1[1].length))}`
      const m2 = /^## (.+?)\s*#*\s*$/.exec(l)
      if (m2) return `${m2[1]}\n${'-'.repeat(Math.max(3, m2[1].length))}`
      return l
    })
    .join('\n')
}

export const convertAtxToSetext: Command = (view) =>
  applyToSelectionOrAll(view, convertAtxToSetextText, 'input.heading.atx.tosetext')

/** Wrap each line in selection/full doc with given prefix and suffix. */
export function wrapEachLineWithText(source: string, prefix: string, suffix: string): string {
  return source
    .split('\n')
    .map((l) => (l.length === 0 ? l : `${prefix}${l}${suffix}`))
    .join('\n')
}

export const wrapEachLineWith = (prefix: string, suffix: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => wrapEachLineWithText(s, prefix, suffix), 'input.line.wrap')

/** Delete headings that have no body (i.e. immediately followed by another heading or EOF). */
export function pruneEmptyHeadingsText(source: string): string {
  const lines = source.split('\n')
  const keep: boolean[] = new Array(lines.length).fill(true)
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s+/.test(lines[i])) continue
    let j = i + 1
    let bodyHasContent = false
    while (j < lines.length && !/^#{1,6}\s+/.test(lines[j])) {
      if (lines[j].trim().length > 0) {
        bodyHasContent = true
        break
      }
      j++
    }
    if (!bodyHasContent) keep[i] = false
  }
  return lines.filter((_, i) => keep[i]).join('\n')
}

export const pruneEmptyHeadings: Command = (view) =>
  applyToSelectionOrAll(view, pruneEmptyHeadingsText, 'input.heading.prune')

/** Annotate fenced code blocks of certain langs with `// N` comment markers per line. */
export function annotateCodeLineNumbersText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let langSupportsSlash = false
  let n = 0
  for (const line of lines) {
    const fence = /^\s*```(\S*)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        const lang = fence[1].toLowerCase()
        langSupportsSlash = ['ts', 'tsx', 'js', 'jsx', 'java', 'go', 'rust', 'c', 'cpp', 'kt', 'swift', 'cs'].includes(lang)
        n = 0
        out.push(line)
        continue
      }
      inFence = false
      langSupportsSlash = false
      out.push(line)
      continue
    }
    if (inFence && langSupportsSlash) {
      n += 1
      out.push(`${line} // ${n}`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

export const annotateCodeLineNumbers: Command = (view) =>
  applyToSelectionOrAll(view, annotateCodeLineNumbersText, 'input.code.linenums')

// -----------------------------------------------------------------------------
// Tag rename / extract + numeric bold + task progress + sentence join + quote swap
// -----------------------------------------------------------------------------

const TAG_BODY = '[\\p{L}\\p{N}_\\-\\/]+'

                                                               
export function renameTagInDocText(source: string, oldTag: string, newTag: string): string {
  if (!oldTag || oldTag === newTag) return source
  const lines = source.split('\n')
  let inFence = false
  const esc = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(^|[^\\p{L}\\p{N}_/])#' + esc + '(?![\\p{L}\\p{N}_\\-\\/])', 'gu')
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = lines[i].replace(/`[^`]*`/g, (s) => '\x00'.repeat(s.length))
    const parts: string[] = []
    let lastEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      parts.push(lines[i].slice(lastEnd, m.index))
      parts.push(m[1] + '#' + newTag)
      lastEnd = m.index + m[0].length
    }
    parts.push(lines[i].slice(lastEnd))
    lines[i] = parts.join('')
  }
  return lines.join('\n')
}

export const renameTagInDoc = (oldTag: string, newTag: string): Command => (view) => {
  const text = view.state.doc.toString()
  const next = renameTagInDocText(text, oldTag, newTag)
  if (next === text) return false
  view.dispatch({
    changes: { from: 0, to: text.length, insert: next },
    userEvent: 'input.tag.rename',
  })
  view.focus()
  return true
}

/** Pull a sorted list of unique tags out of the doc. */
export function extractAllTagsList(source: string): string[] {
  const seen = new Set<string>()
  const lines = source.split('\n')
  let inFence = false
  const re = new RegExp('(^|[^\\p{L}\\p{N}_/])#(' + TAG_BODY + ')', 'gu')
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = line.replace(/`[^`]*`/g, (s) => '\x00'.repeat(s.length))
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      seen.add(m[2])
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** Bold standalone integers ≥ 1000 to make numbers pop. */
export function boldLargeNumbersText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/(^|[\s\(])(\d{4,})(?=\b)/g, (_, lead, n) => `${lead}**${n}**`)
  }
  return lines.join('\n')
}

export const boldLargeNumbers: Command = (view) =>
  applyToSelectionOrAll(view, boldLargeNumbersText, 'input.numbers.bold')

/** Count `- [ ]` vs `- [x]` and write a summary line at the very top of the doc. */
export const insertTaskProgressSummary: Command = (view) => {
  const doc = view.state.doc
  let done = 0
  let total = 0
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(text)) {
      total += 1
      if (/^\s*[-*+]\s+\[[xX]\]/.test(text)) done += 1
    }
  }
  if (total === 0) return false
  const pct = ((done / total) * 100).toFixed(0)
  const line = `**Tasks: ${done}/${total} done (${pct}%)**\n\n`
  view.dispatch({
    changes: { from: 0, insert: line },
    userEvent: 'input.tasks.summary',
  })
  view.focus()
  return true
}

/** Join lines that are not separated by blank line into a single sentence-style line. */
export function joinSentencesText(source: string): string {
  const paragraphs = source.split(/\n\n+/)
  return paragraphs
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' '),
    )
    .join('\n\n')
}

export const joinSentences: Command = (view) =>
  applyToSelectionOrAll(view, joinSentencesText, 'input.sentences.join')

/** Swap straight single quotes for double quotes (text-wide; not respecting code). */
export function convertSingleQuoteToDoubleText(source: string): string {
  // Be careful not to mangle apostrophes inside words (don't, it's).
  return source.replace(/'([^']*?)'/g, (_, inner) => `"${inner}"`)
}

export const convertSingleQuoteToDouble: Command = (view) =>
  applyToSelectionOrAll(view, convertSingleQuoteToDoubleText, 'input.quotes.single.double')

/** Reverse — double → single. */
export function convertDoubleQuoteToSingleText(source: string): string {
  return source.replace(/"([^"]*?)"/g, (_, inner) => `'${inner}'`)
}

export const convertDoubleQuoteToSingle: Command = (view) =>
  applyToSelectionOrAll(view, convertDoubleQuoteToSingleText, 'input.quotes.double.single')

// -----------------------------------------------------------------------------
// Wikilink alias expand/collapse + date math + word-count sort + split-on-semicolons
// -----------------------------------------------------------------------------

/** `[[foo]]` → `[[foo|foo]]` so aliases can be edited without changing the target. */
export function expandWikilinkAliasesText(source: string): string {
  return source.replace(/\[\[([^\]|#]+)\]\]/g, (_, target) => `[[${target}|${target}]]`)
}

export const expandWikilinkAliases: Command = (view) =>
  applyToSelectionOrAll(view, expandWikilinkAliasesText, 'input.wikilink.expandalias')

/** `[[foo|foo]]` → `[[foo]]` (collapse identity aliases). */
export function collapseWikilinkAliasesText(source: string): string {
  return source.replace(/\[\[([^\]|#]+)\|([^\]]+)\]\]/g, (full, target, alias) => {
    return target.trim() === alias.trim() ? `[[${target}]]` : full
  })
}

export const collapseWikilinkAliases: Command = (view) =>
  applyToSelectionOrAll(view, collapseWikilinkAliasesText, 'input.wikilink.collapsealias')

function shiftIsoDate(iso: string, days: number): string {
  const [y, mo, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  const y2 = date.getUTCFullYear()
  const m2 = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d2 = String(date.getUTCDate()).padStart(2, '0')
  return `${y2}-${m2}-${d2}`
}

/** Shift every `[[YYYY-MM-DD]]` wikilink (and the bare ones in alias form) by N days. */
export function addDaysToDateLinksText(source: string, days: number): string {
  return source.replace(/\[\[(\d{4}-\d{2}-\d{2})(\|[^\]]+)?\]\]/g, (_, iso, alias) => {
    return `[[${shiftIsoDate(iso, days)}${alias ?? ''}]]`
  })
}

export const addDaysToDateLinks = (days: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => addDaysToDateLinksText(s, days), 'input.dates.shift')

/** Insert `[[YYYY-MM-DD]] → [[YYYY-MM-DD]]` for the current ISO week (Mon..Sun). */
export const insertCurrentWeekRange: Command = (view) => {
  const now = new Date()
  const day = now.getDay() === 0 ? 7 : now.getDay()
  const mon = new Date(now)
  mon.setDate(now.getDate() - (day - 1))
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const text = `[[${fmt(mon)}]] → [[${fmt(sun)}]]`
  const main = view.state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: EditorSelection.cursor(main.from + text.length),
    userEvent: 'input.week.range',
  })
  view.focus()
  return true
}

/** Sort contiguous bullet/numbered list blocks by word count of each item. */
export function sortListByWordCountText(source: string, direction: 'asc' | 'desc' = 'asc'): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  const isItem = (l: string) => /^\s*([-*+]|\d+\.)\s+/.test(l)
  while (i < lines.length) {
    if (!isItem(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    let j = i
    while (j < lines.length && isItem(lines[j])) j++
    const block = lines.slice(i, j)
    const wc = (s: string) =>
      s
        .replace(/^\s*([-*+]|\d+\.)\s+/, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length
    block.sort((a, b) => (direction === 'asc' ? wc(a) - wc(b) : wc(b) - wc(a)))
    out.push(...block)
    i = j
  }
  return out.join('\n')
}

export const sortListByWordCount = (direction: 'asc' | 'desc' = 'asc'): Command => (view) =>
  applyToSelectionOrAll(view, (s) => sortListByWordCountText(s, direction), 'input.list.sort.wc')

/** Split each line at `;` into separate lines (preserves any leading list marker). */
export function splitOnSemicolonsText(source: string): string {
  return source
    .split('\n')
    .flatMap((l) => {
      if (l.indexOf(';') === -1) return [l]
      const m = /^(\s*[-*+]\s+|\s*\d+\.\s+)?(.*)$/.exec(l)
      const prefix = m?.[1] ?? ''
      const body = m?.[2] ?? l
      return body
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (prefix ? `${prefix}${p}` : p))
    })
    .join('\n')
}

export const splitOnSemicolons: Command = (view) =>
  applyToSelectionOrAll(view, splitOnSemicolonsText, 'input.split.semicolons')

// -----------------------------------------------------------------------------
// List indent normalize + citation + image grid + escape + CJK punctuation split + URL extract
// -----------------------------------------------------------------------------

                                                   
export function normalizeListIndentationText(source: string): string {
  return source
    .split('\n')
    .map((l) => {
      const m = /^( +)([-*+]|\d+\.)\s+/.exec(l)
      if (!m) return l
      const lead = m[1]
      const levels = Math.floor(lead.length / 4)
      const remainder = lead.length % 4
      const newLead = '  '.repeat(levels) + ' '.repeat(remainder)
      return newLead + l.slice(lead.length)
    })
    .join('\n')
}

export const normalizeListIndentation: Command = (view) =>
  applyToSelectionOrAll(view, normalizeListIndentationText, 'input.list.normalizeindent')

export type Citation = {
  title: string
  url?: string
  author?: string
  year?: number | string
}

/** Format a single citation line. */
export function formatCitation(c: Citation): string {
  const parts: string[] = []
  if (c.author) parts.push(c.author)
  if (c.year != null) parts.push(`(${c.year})`)
  if (c.title) {
    parts.push(c.url ? `[${c.title}](${c.url})` : `*${c.title}*`)
  }
  return parts.join(' ').trim()
}

export const insertCitation = (c: Citation): Command => (view) => {
  const text = formatCitation(c)
  if (!text) return false
  const main = view.state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: EditorSelection.cursor(main.from + text.length),
    userEvent: 'input.citation',
  })
  view.focus()
  return true
}

/** Build an HTML image-grid snippet (responsive 3-column CSS grid). */
export function buildImageGridHtml(urls: string[], cols = 3): string {
  if (urls.length === 0) return ''
  const cells = urls
    .map((u) => `  <img src="${u}" alt="" loading="lazy" style="width:100%;height:auto;object-fit:cover;" />`)
    .join('\n')
  return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;">\n${cells}\n</div>`
}

export const insertImageGrid = (urls: string[], cols = 3): Command => (view) => {
  const html = buildImageGridHtml(urls, cols)
  if (!html) return false
  const main = view.state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: html },
    selection: EditorSelection.cursor(main.from + html.length),
    userEvent: 'input.image.grid',
  })
  view.focus()
  return true
}

/** Backslash-escape markdown special chars so the text renders literally. */
export function escapeMarkdownInPlainText(source: string): string {
  return source.replace(/([\\`*_{}\[\]()#+\-!>])/g, '\\$1')
}

export const escapeMarkdownInPlain: Command = (view) =>
  applyToSelectionOrAll(view, escapeMarkdownInPlainText, 'input.md.escape.plain')

/** Insert a newline after sentence-ending punctuation. */
export function splitAfterCjkPunctuationText(source: string): string {
  return source
    .replace(/(\p{Sentence_Terminal})(?!\n)/gu, '$1\n')
    .replace(/([.!?])(\s+)(?=[A-Z])/g, '$1\n')
}

export const splitAfterCjkPunctuation: Command = (view) =>
  applyToSelectionOrAll(view, splitAfterCjkPunctuationText, 'input.split.cjkpunct')

/** Return every URL referenced in the doc (links, bare `<url>`, raw `https://…`). */
export function extractAllUrls(source: string): string[] {
  const set = new Set<string>()
  for (const m of source.matchAll(/\[[^\]]+\]\(([^)\s]+)/g)) set.add(m[1])
  for (const m of source.matchAll(/<(https?:\/\/[^>\s]+)>/g)) set.add(m[1])
  for (const m of source.matchAll(/(?<![\(<])\bhttps?:\/\/\S+/g)) {
    set.add(m[0].replace(/[)\.,;\]!?]+$/, ''))
  }
  return [...set].sort()
}

/** Insert all URLs found in the doc as a bullet list at the end. */
export const insertAllUrlsList: Command = (view) => {
  const urls = extractAllUrls(view.state.doc.toString())
  if (urls.length === 0) return false
  const block = '\n\n## URLs\n\n' + urls.map((u) => `- <${u}>`).join('\n') + '\n'
  view.dispatch({
    changes: { from: view.state.doc.length, insert: block },
    userEvent: 'input.urls.list',
  })
  view.focus()
  return true
}

// -----------------------------------------------------------------------------
// Timestamps + time entries + list increment + per-line prefix/suffix
// -----------------------------------------------------------------------------

export type TimestampFormat = 'iso' | 'datetime' | 'epoch' | 'time'

export function formatTimestamp(d: Date, kind: TimestampFormat): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const da = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  switch (kind) {
    case 'iso':
      return d.toISOString()
    case 'datetime':
      return `${y}-${mo}-${da} ${h}:${mi}:${s}`
    case 'epoch':
      return String(Math.floor(d.getTime() / 1000))
    case 'time':
      return `${h}:${mi}`
  }
}

export const insertTimestampAtCursor = (kind: TimestampFormat = 'datetime'): Command => (view) => {
  const text = formatTimestamp(new Date(), kind)
  const main = view.state.selection.main
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: EditorSelection.cursor(main.from + text.length),
    userEvent: 'input.timestamp',
  })
  view.focus()
  return true
}

/** Wrap selection as `- HH:MM | task` time entry; uses current time for HH:MM. */
export const wrapAsTimeEntry: Command = (view) => {
  const time = formatTimestamp(new Date(), 'time')
  const main = view.state.selection.main
  const body = main.empty ? '' : view.state.sliceDoc(main.from, main.to)
  const text = `- ${time} | ${body}`
  view.dispatch({
    changes: { from: main.from, to: main.to, insert: text },
    selection: EditorSelection.cursor(main.from + text.length),
    userEvent: 'input.timeentry',
  })
  view.focus()
  return true
}

/** Parse `HH:MM` and `Nh Nm` style durations and sum them in minutes. */
export function convertHHMMToMinutes(token: string): number {
  const m = /^(\d+):(\d{1,2})$/.exec(token.trim())
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
  let total = 0
  const re = /(\d+)\s*([hm])/gi
  let any = false
  let r: RegExpExecArray | null
  while ((r = re.exec(token)) !== null) {
    any = true
    const n = parseInt(r[1], 10)
    if (r[2].toLowerCase() === 'h') total += n * 60
    else total += n
  }
  return any ? total : 0
}

/** Sum every duration-looking token in the doc; returns total minutes. */
export function sumTimeEntries(source: string): number {
  const tokens: string[] = source.match(/\b\d+:\d{1,2}\b|\b\d+h(?:\s*\d+m)?\b|\b\d+m\b/g) || []
  let total = 0
  for (const t of tokens) total += convertHHMMToMinutes(t)
  return total
}

export function formatMinutesAsHm(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export const insertTimeEntriesTotal: Command = (view) => {
  const min = sumTimeEntries(view.state.doc.toString())
  if (min === 0) return false
  const line = `\n\n**Total: ${formatMinutesAsHm(min)} (${min} min)**\n`
  view.dispatch({
    changes: { from: view.state.doc.length, insert: line },
    userEvent: 'input.time.total',
  })
  view.focus()
  return true
}

/** Shift every ordered-list `N.` line number by `n`. */
export function incrementOrderedListByText(source: string, n: number): string {
  return source
    .split('\n')
    .map((l) => l.replace(/^(\s*)(\d+)(\.\s+)/, (_, lead, num, tail) => `${lead}${parseInt(num, 10) + n}${tail}`))
    .join('\n')
}

export const incrementOrderedListBy = (n: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => incrementOrderedListByText(s, n), 'input.ol.shift')

export function prependLinesWithText(source: string, prefix: string): string {
  return source
    .split('\n')
    .map((l) => (l.length === 0 ? l : `${prefix}${l}`))
    .join('\n')
}

export const prependLinesWith = (prefix: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => prependLinesWithText(s, prefix), 'input.lines.prepend')

export function appendLinesWithText(source: string, suffix: string): string {
  return source
    .split('\n')
    .map((l) => (l.length === 0 ? l : `${l}${suffix}`))
    .join('\n')
}

export const appendLinesWith = (suffix: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => appendLinesWithText(s, suffix), 'input.lines.append')


                                                                                
                               
                                                                                  

   
                                         
                                 
   
export function safeEvalArithmetic(expr: string): number | null {
  if (!/^[\s\d.+\-*/%()]+$/.test(expr)) return null
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expr});`)
    const v = fn()
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return v
  } catch {
    return null
  }
}

   
                                                       
                      
   
export function evalInlineMathInLinesText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
                              
      const eqCount = (line.match(/=/g) || []).length
      if (eqCount !== 1) return line
      const m = /^(.*?)=\s*([\d.+\-*/%()\s]+?)\s*$/.exec(line)
      if (!m) return line
      const result = safeEvalArithmetic(m[2])
      if (result === null) return line
      const fmt = Number.isInteger(result) ? `${result}` : `${result}`
      return `${m[1]}= ${m[2].trim()} = ${fmt}`
    })
    .join('\n')
}

export const evalInlineMathInLines: Command = (view) =>
  applyToSelectionOrAll(view, evalInlineMathInLinesText, 'input.math.eval')

                                                            
const TASK_STATE_CYCLE = [' ', '/', 'x', '-', '>'] as const

export function cycleTaskStateChar(current: string): string {
  const idx = TASK_STATE_CYCLE.indexOf(current as (typeof TASK_STATE_CYCLE)[number])
  const next = idx < 0 ? 0 : (idx + 1) % TASK_STATE_CYCLE.length
  return TASK_STATE_CYCLE[next]
}

   
                                   
            
   
export const cycleTaskStateAtCursor: Command = (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const text = line.text
  const m = /^(\s*[-*+]\s*\[)([^\]])(\].*)$/.exec(text)
  if (!m) return false
  const next = cycleTaskStateChar(m[2])
  if (next === m[2]) return false
  view.dispatch({
    changes: { from: line.from + m[1].length, to: line.from + m[1].length + 1, insert: next },
    userEvent: 'input.task.cycle',
  })
  return true
}

   
                                                     
                                      
   
export function archiveDoneTasksText(source: string): string {
  const lines = source.split('\n')
  const kept: string[] = []
  const archived: string[] = []
  for (const ln of lines) {
    if (/^\s*[-*+]\s*\[x\]/i.test(ln)) archived.push(ln)
    else kept.push(ln)
  }
  if (archived.length === 0) return source
  const archivedIdx = kept.findIndex((l) => /^##\s+Archived\s*$/.test(l))
  if (archivedIdx >= 0) {
    const before = kept.slice(0, archivedIdx + 1)
    const after = kept.slice(archivedIdx + 1)
    return [...before, ...archived, ...after].join('\n')
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return [...kept, '', '## Archived', ...archived, ''].join('\n')
}

   
                                              
                                                                                       
   
export const cutCurrentSectionToClipboard: Command = (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const doc = view.state.doc
  const from = doc.line(cur.headingLineNo).from
  const to = doc.line(cur.endLineNo).to
  const text = view.state.sliceDoc(from, to)
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  void navigator.clipboard.writeText(text)
  view.dispatch({
    changes: { from, to, insert: '' },
    userEvent: 'cut.section',
  })
  return true
}

                                    
export function stripHighlightsText(source: string): string {
  return source.replace(/==([^=]+)==/g, '$1')
}

export const stripHighlights: Command = (view) =>
  applyToSelectionOrAll(view, stripHighlightsText, 'input.highlights.strip')

                                      
export function stripBoldText(source: string): string {
  return source.replace(/\*\*([^*]+)\*\*/g, '$1')
}

export const stripBold: Command = (view) =>
  applyToSelectionOrAll(view, stripBoldText, 'input.bold.strip')

                                             
export function stripItalicText(source: string): string {
  let out = source.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '$1')
  out = out.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, '$1')
  return out
}

export const stripItalic: Command = (view) =>
  applyToSelectionOrAll(view, stripItalicText, 'input.italic.strip')

                                                           
export function ensureUpdatedFrontmatterText(source: string, now: Date): string {
  const date = now.toISOString().slice(0, 10)
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (fm) {
    const body = fm[1]
    if (/^updated:\s*.*$/m.test(body)) {
      const newBody = body.replace(/^updated:\s*.*$/m, `updated: ${date}`)
      return `---\n${newBody}\n---\n${source.slice(fm[0].length)}`
    }
    return `---\n${body}\nupdated: ${date}\n---\n${source.slice(fm[0].length)}`
  }
  return `---\nupdated: ${date}\n---\n${source}`
}

export const stampUpdatedFrontmatter: Command = (view) => {
  const next = ensureUpdatedFrontmatterText(view.state.doc.toString(), new Date())
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.updated',
  })
  return true
}

                                                      
export function hardBreaksToSpaceText(source: string): string {
  return source
    .split('\n')
    .map((l) => (l.trim().length === 0 ? l : `${l.replace(/\s+$/, '')}  `))
    .join('\n')
}

export const hardBreaksToSpace: Command = (view) =>
  applyToSelectionOrAll(view, hardBreaksToSpaceText, 'input.hardbreaks.normalize')

                                                                                
                                                      
                                                                                  

   
                            
         
                  
    
       
                
   
export function bulletPairsToDefinitionListText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1] ?? ''
    const m1 = /^[-*+]\s+(.+)$/.exec(cur)
    const m2 = /^\s{2,}[-*+]\s+(.+)$/.exec(next)
    if (m1 && m2) {
      out.push(m1[1])
      out.push(`: ${m2[1]}`)
      i += 1
    } else {
      out.push(cur)
    }
  }
  return out.join('\n')
}

export const bulletPairsToDefinitionList: Command = (view) =>
  applyToSelectionOrAll(view, bulletPairsToDefinitionListText, 'input.deflist.convert')

   
                                                           
   
export function sortFrontmatterAliasesText(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const body = fm[1]
  // inline: aliases: [a, b, c]
  const inline = /^aliases:\s*\[([^\]]*)\]\s*$/m.exec(body)
  if (inline) {
    const items = inline[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    const newLine = `aliases: [${items.join(', ')}]`
    const newBody = body.replace(/^aliases:\s*\[[^\]]*\]\s*$/m, newLine)
    return `---\n${newBody}\n---${source.slice(fm[0].length)}`
  }
  // block:
  // aliases:
  //   - x
  //   - y
  const block = /^aliases:\s*\n((?:\s*-\s.+\n?)+)/m.exec(body)
  if (block) {
    const items = block[1]
      .split('\n')
      .map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1] ?? '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    const newBlock = `aliases:\n${items.map((i) => `  - ${i}`).join('\n')}`
    const newBody = body.replace(block[0], newBlock + '\n')
    return `---\n${newBody.replace(/\n$/, '')}\n---${source.slice(fm[0].length)}`
  }
  return source
}

export const sortFrontmatterAliases: Command = (view) => {
  const next = sortFrontmatterAliasesText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.aliases.sort',
  })
  return true
}

                                         
export function blockquoteLinesText(source: string): string {
  return source
    .split('\n')
    .map((l) => (l.length === 0 ? '>' : `> ${l}`))
    .join('\n')
}

export const blockquoteLines: Command = (view) =>
  applyToSelectionOrAll(view, blockquoteLinesText, 'input.blockquote.lines')

                     
export function unblockquoteLinesText(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n')
}

export const unblockquoteLines: Command = (view) =>
  applyToSelectionOrAll(view, unblockquoteLinesText, 'input.blockquote.unlines')

   
                                                  
           
   
export function injectTopTOCText(source: string): string {
  const lines = source.split('\n')
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l))
  if (h1Idx === -1) return source
  // collect headings from after h1
  const tocLines: string[] = ['## Table of Contents']
  let inFence = false
  for (let i = h1Idx + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (/^\s*```/.test(ln)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,6})\s+(.+?)\s*$/.exec(ln)
    if (m) {
      const depth = m[1].length - 2
      tocLines.push(`${'  '.repeat(depth)}- [[#${m[2]}]]`)
    }
  }
  if (tocLines.length === 1) return source
  // detect previous TOC block immediately after H1 (## Table of Contents block)
  const after = lines.slice(h1Idx + 1)
  let removeUntil = 0
  if (after.length > 0 && /^##\s+Table of Contents/.test(after[0])) {
    let j = 1
    while (j < after.length && !/^#{1,2}\s+/.test(after[j])) j += 1
    removeUntil = j
  }
  const before = lines.slice(0, h1Idx + 1)
  const rest = lines.slice(h1Idx + 1 + removeUntil)
  return [...before, '', ...tocLines, '', ...rest].join('\n')
}

export const injectTopTOC: Command = (view) => {
  const next = injectTopTOCText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.toc.inject',
  })
  return true
}

                                                                                
                                                                
                                                                                  

   
                      
                                             
   
export const changeCalloutTypeAtCursor = (newType: string): Command => (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const text = line.text
  const m = /^(\s*>\s*\[!)([A-Za-z0-9_-]+)(\][+-]?)(.*)$/.exec(text)
  if (!m) return false
  const newText = `${m[1]}${newType.trim().toLowerCase()}${m[3]}${m[4]}`
  if (newText === text) return false
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newText },
    userEvent: 'input.callout.changetype',
  })
  return true
}

                                                      
export const insertKanbanColumn = (name: string): Command => (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const insert = `\n\n## ${name}\n\n- [ ] \n`
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: line.to + insert.length - 1 },
    userEvent: 'input.kanban.column',
  })
  return true
}

                                                     
export const insertKanbanCard = (text: string): Command => (view) => {
  const doc = view.state.doc
  const headOn = view.state.selection.main.head
  const lineNo = doc.lineAt(headOn).number
  // walk up to find ## column heading
  let h2 = -1
  for (let i = lineNo; i >= 1; i--) {
    if (/^##\s+/.test(doc.line(i).text)) {
      h2 = i
      break
    }
  }
  if (h2 === -1) return false
  // walk down to find end of column (next ## or eof)
  let end = doc.lines
  for (let i = h2 + 1; i <= doc.lines; i++) {
    if (/^##\s+/.test(doc.line(i).text)) {
      end = i - 1
      break
    }
  }
  const insertPos = doc.line(end).to
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: `\n- [ ] ${text}` },
    userEvent: 'input.kanban.card',
  })
  return true
}

   
                                                                 
                 
   
export function renameInlineDataviewFieldText(
  source: string,
  oldKey: string,
  newKey: string,
): string {
  if (!oldKey || !newKey || oldKey === newKey) return source
  const safe = oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // match at line start, after space, or inside brackets like [oldKey:: value]
  const re = new RegExp(`(^|\\s|\\[|\\()(${safe})(\\s*::)`, 'g')
  return source.replace(re, (_, pre, _key, suf) => `${pre}${newKey}${suf}`)
}

export const renameInlineDataviewField = (oldKey: string, newKey: string): Command => (view) => {
  const next = renameInlineDataviewFieldText(view.state.doc.toString(), oldKey, newKey)
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.dataview.rename',
  })
  return true
}

                    
export const swapWithNextLine: Command = (view) => {
  const sel = view.state.selection.main
  const cur = view.state.doc.lineAt(sel.head)
  if (cur.number >= view.state.doc.lines) return false
  const next = view.state.doc.line(cur.number + 1)
  const newText = `${next.text}\n${cur.text}`
  view.dispatch({
    changes: { from: cur.from, to: next.to, insert: newText },
    userEvent: 'move.line.down',
  })
  return true
}

                    
export const swapWithPrevLine: Command = (view) => {
  const sel = view.state.selection.main
  const cur = view.state.doc.lineAt(sel.head)
  if (cur.number <= 1) return false
  const prev = view.state.doc.line(cur.number - 1)
  const newText = `${cur.text}\n${prev.text}`
  view.dispatch({
    changes: { from: prev.from, to: cur.to, insert: newText },
    userEvent: 'move.line.up',
  })
  return true
}

                                         
export function numberCodeBlockLinesText(source: string): string {
  const lines = source.split('\n')
  // find first fenced code block
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      if (start === -1) start = i
      else if (end === -1) {
        end = i
        break
      }
    }
  }
  if (start === -1 || end === -1) return source
  const body = lines.slice(start + 1, end)
  const width = String(body.length).length
  const numbered = body.map((l, i) => `${String(i + 1).padStart(width, ' ')} | ${l}`)
  return [...lines.slice(0, start + 1), ...numbered, ...lines.slice(end)].join('\n')
}

export const numberFirstCodeBlockLines: Command = (view) => {
  const next = numberCodeBlockLinesText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.codeblock.number',
  })
  return true
}

                                        
export function stripHtmlCommentsText(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

export const stripHtmlComments: Command = (view) =>
  applyToSelectionOrAll(view, stripHtmlCommentsText, 'input.htmlcomments.strip')

                                    
export function purgeDoneTasksUnderTasksHeadingText(source: string): string {
  const lines = source.split('\n')
  let inside = false
  const out: string[] = []
  for (const ln of lines) {
    if (/^##\s+Tasks\s*$/.test(ln)) {
      inside = true
      out.push(ln)
      continue
    }
    if (inside && /^#{1,2}\s+/.test(ln)) inside = false
    if (inside && /^\s*[-*+]\s*\[x\]/i.test(ln)) continue
    out.push(ln)
  }
  return out.join('\n')
}

export const purgeDoneTasksUnderTasksHeading: Command = (view) => {
  const next = purgeDoneTasksUnderTasksHeadingText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.tasks.purge',
  })
  return true
}

                                                                                
                                                     
                                                                                  

   
                                                              
                                   
                              
   
export const extractWikilinkToOwnLine: Command = (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const text = line.text
  const re = /\[\[[^\]]+\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (sel.head >= line.from + start && sel.head <= line.from + end) {
      const before = text.slice(0, start).replace(/\s+$/, '')
      const after = text.slice(end).replace(/^\s+/, '')
      const parts: string[] = []
      if (before) parts.push(before)
      parts.push(m[0])
      if (after) parts.push(after)
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: parts.join('\n') },
        userEvent: 'input.wikilink.extract',
      })
      return true
    }
  }
  return false
}

   
                                                   
                
   
export function swapLinkTextWithUrlText(source: string): string {
  return source.replace(/(?<!\!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, t, u, title) => {
    const titlePart = title ? ` "${title}"` : ''
    return `[${u}](${t}${titlePart})`
  })
}

export const swapLinkTextWithUrl: Command = (view) =>
  applyToSelectionOrAll(view, swapLinkTextWithUrlText, 'input.link.swap')

   
                              
   
export const insertTitledDivider = (title: string): Command => (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const insert = `\n\n---\n## ${title}\n---\n`
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: line.to + insert.length },
    userEvent: 'input.divider.titled',
  })
  return true
}

   
                                             
         
          
          
          
   
export function frontmatterFieldInlineToBlockText(source: string, key: string): string {
  if (!key) return source
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const body = fm[1]
  const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${safe}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm')
  const m = re.exec(body)
  if (!m) return source
  const items = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (items.length === 0) return source
  const block = `${key}:\n${items.map((i) => `  - ${i}`).join('\n')}`
  const newBody = body.replace(m[0], block)
  return `---\n${newBody}\n---${source.slice(fm[0].length)}`
}

export const frontmatterFieldInlineToBlock = (key: string): Command => (view) => {
  const next = frontmatterFieldInlineToBlockText(view.state.doc.toString(), key)
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.inline2block',
  })
  return true
}

   
                                   
   
export function frontmatterFieldBlockToInlineText(source: string, key: string): string {
  if (!key) return source
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const body = fm[1]
  const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${safe}:\\s*\\n((?:\\s*-\\s+.+\\n?)+)`, 'm')
  const m = re.exec(body)
  if (!m) return source
  const items = m[1]
    .split('\n')
    .map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1] ?? '')
    .filter(Boolean)
  if (items.length === 0) return source
  const inline = `${key}: [${items.join(', ')}]`
  const newBody = body.replace(m[0], inline + '\n')
  return `---\n${newBody.replace(/\n$/, '')}\n---${source.slice(fm[0].length)}`
}

export const frontmatterFieldBlockToInline = (key: string): Command => (view) => {
  const next = frontmatterFieldBlockToInlineText(view.state.doc.toString(), key)
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.block2inline',
  })
  return true
}

                                                               
export const swapWikilinkAliasAndTargetAtCursor: Command = (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const text = line.text
  const re = /\[\[([^\]|]+)\|([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (sel.head >= line.from + start && sel.head <= line.from + end) {
      const replaced = `[[${m[2]}|${m[1]}]]`
      view.dispatch({
        changes: { from: line.from + start, to: line.from + end, insert: replaced },
        userEvent: 'input.wikilink.swap',
      })
      return true
    }
  }
  return false
}

                                           
export function stampLinesWithDateText(source: string, date: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      if (l.trim().length === 0) return l
      return `[${date}] ${l}`
    })
    .join('\n')
}

export const stampLinesWithDate = (date: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => stampLinesWithDateText(s, date), 'input.lines.datestamp')

                                                                 
         
        
   
export function unwrapDetailsBlocksText(source: string): string {
  return source.replace(
    /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
    (_m, summary, body) => `### ${summary.trim()}\n${body.trim()}`,
  )
}

export const unwrapDetailsBlocks: Command = (view) =>
  applyToSelectionOrAll(view, unwrapDetailsBlocksText, 'input.details.unwrap')

                                                                                
                          
                                                                                  

                                        
export function collapseExcessiveBlankLinesText(source: string): string {
  return source.replace(/\n{3,}/g, '\n\n')
}

export const collapseExcessiveBlankLines: Command = (view) =>
  applyToSelectionOrAll(view, collapseExcessiveBlankLinesText, 'input.lint.blanks')

                                                
export function singleSpaceAfterListMarkerText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      return l.replace(/^(\s*[-*+])\s+/, '$1 ').replace(/^(\s*\d+\.)\s+/, '$1 ')
    })
    .join('\n')
}

export const singleSpaceAfterListMarker: Command = (view) =>
  applyToSelectionOrAll(view, singleSpaceAfterListMarkerText, 'input.lint.listspace')

                                  
export function ensureBlankAroundHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^\s*```/.test(ln)) inFence = !inFence
    const isHeading = !inFence && /^#{1,6}\s+/.test(ln)
    if (isHeading) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(ln)
      if (i + 1 < lines.length && lines[i + 1] !== '') out.push('')
      continue
    }
    out.push(ln)
  }
  return out.join('\n')
}

export const ensureBlankAroundHeadings: Command = (view) =>
  applyToSelectionOrAll(view, ensureBlankAroundHeadingsText, 'input.lint.headingspace')

                      
export function ensureSingleTrailingNewlineText(source: string): string {
  return source.replace(/\n*$/, '\n')
}

export const ensureSingleTrailingNewline: Command = (view) => {
  const next = ensureSingleTrailingNewlineText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.lint.eol',
  })
  return true
}

                                         
export function sortFrontmatterTopKeysText(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!fm) return source
  const body = fm[1]
  type Entry = { key: string; lines: string[] }
  const entries: Entry[] = []
  let current: Entry | null = null
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (m) {
      if (current) entries.push(current)
      current = { key: m[1], lines: [line] }
    } else if (current) {
      current.lines.push(line)
    } else {
      // stray line before any key — preserve at top by adding pseudo-key
      entries.push({ key: '', lines: [line] })
    }
  }
  if (current) entries.push(current)
  entries.sort((a, b) => a.key.localeCompare(b.key))
  const newBody = entries.map((e) => e.lines.join('\n')).join('\n')
  return `---\n${newBody}\n---${source.slice(fm[0].length)}`
}

export const sortFrontmatterTopKeys: Command = (view) => {
  const next = sortFrontmatterTopKeysText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.sortkeys',
  })
  return true
}

                                                       
export function normalizeEmphasisToAsteriskText(source: string): string {
  return source.replace(/(?<![_\w])_(?!_)([^_\n]+?)(?<!_)_(?!_)/g, '*$1*')
}

export const normalizeEmphasisToAsterisk: Command = (view) =>
  applyToSelectionOrAll(view, normalizeEmphasisToAsteriskText, 'input.lint.emphasis.asterisk')

                                           
export function normalizeEmphasisToUnderscoreText(source: string): string {
  return source.replace(/(?<![*\w])\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '_$1_')
}

export const normalizeEmphasisToUnderscore: Command = (view) =>
  applyToSelectionOrAll(view, normalizeEmphasisToUnderscoreText, 'input.lint.emphasis.underscore')

                                                       
export function normalizeStrongToAsteriskText(source: string): string {
  return source.replace(/__([^_\n]+?)__/g, '**$1**')
}

export const normalizeStrongToAsterisk: Command = (view) =>
  applyToSelectionOrAll(view, normalizeStrongToAsteriskText, 'input.lint.strong.asterisk')

                                       
export function trimTrailingNonBreakWhitespaceText(source: string): string {
  return source
    .split('\n')
    .map((l) => {
      const m = /^(.*?)([ \t]*)$/.exec(l)
      if (!m) return l
      const trailing = m[2]
      // preserve exactly two trailing spaces (markdown hard break)
      if (trailing === '  ') return l
      return m[1]
    })
    .join('\n')
}

export const trimTrailingNonBreakWhitespace: Command = (view) => {
  const next = trimTrailingNonBreakWhitespaceText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.lint.trimwhite',
  })
  return true
}

                                                     
export const fixCommonMarkdownLints: Command = (view) => {
  let src = view.state.doc.toString()
  src = collapseExcessiveBlankLinesText(src)
  src = singleSpaceAfterListMarkerText(src)
  src = ensureBlankAroundHeadingsText(src)
  src = trimTrailingNonBreakWhitespaceText(src)
  src = ensureSingleTrailingNewlineText(src)
  if (src === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: src },
    userEvent: 'input.lint.fixall',
  })
  return true
}

                                                                                
                                                   
                                                                                  

   
                        
                                        
   
export const splitSectionAtCursor = (title: string): Command => (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const level = cur.headingLevel
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const heading = `${'#'.repeat(level)} ${title}\n`
  const insertAt = line.from
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: heading + '\n' },
    selection: { anchor: insertAt + heading.length },
    userEvent: 'input.section.split',
  })
  return true
}

                                            
export function flattenNestedListsText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      const m = /^\s*([-*+])\s+(.+)$/.exec(l)
      if (m) return `- ${m[2]}`
      return l
    })
    .join('\n')
}

export const flattenNestedLists: Command = (view) =>
  applyToSelectionOrAll(view, flattenNestedListsText, 'input.list.flatten')

                               
export function indentLinesBySpacesText(source: string, n: number): string {
  if (n <= 0) return source
  const pad = ' '.repeat(n)
  return source
    .split('\n')
    .map((l) => (l.length === 0 ? l : pad + l))
    .join('\n')
}

export const indentLinesBySpaces = (n: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => indentLinesBySpacesText(s, n), 'input.lines.indent')

                              
export function dedentLinesBySpacesText(source: string, n: number): string {
  if (n <= 0) return source
  return source
    .split('\n')
    .map((l) => {
      let cut = 0
      while (cut < n && cut < l.length && l[cut] === ' ') cut += 1
      return l.slice(cut)
    })
    .join('\n')
}

export const dedentLinesBySpaces = (n: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => dedentLinesBySpacesText(s, n), 'input.lines.dedent')

                                                                         
export function plainUrlToAutolinkText(source: string): string {
                                                  
                                  
  return source
    .split('\n')
    .map((line) => {
                                        
      const masks: { from: number; to: number }[] = []
      const re1 = /\[[^\]\n]*\]\([^)\n]+\)/g
      let m1: RegExpExecArray | null
      while ((m1 = re1.exec(line)) !== null) {
        masks.push({ from: m1.index, to: m1.index + m1[0].length })
      }
      const re2 = /<[^>\n]+>/g
      let m2: RegExpExecArray | null
      while ((m2 = re2.exec(line)) !== null) {
        masks.push({ from: m2.index, to: m2.index + m2[0].length })
      }
      const re3 = /`[^`]+`/g
      let m3: RegExpExecArray | null
      while ((m3 = re3.exec(line)) !== null) {
        masks.push({ from: m3.index, to: m3.index + m3[0].length })
      }
      const isMasked = (i: number) => masks.some((mm) => i >= mm.from && i < mm.to)
      const url = /\bhttps?:\/\/[^\s<>()\[\]]+/g
      let out = ''
      let last = 0
      let mU: RegExpExecArray | null
      while ((mU = url.exec(line)) !== null) {
        if (isMasked(mU.index)) continue
        out += line.slice(last, mU.index) + `<${mU[0]}>`
        last = mU.index + mU[0].length
      }
      out += line.slice(last)
      return out
    })
    .join('\n')
}

export const plainUrlToAutolink: Command = (view) =>
  applyToSelectionOrAll(view, plainUrlToAutolinkText, 'input.url.autolink')

                                           
export function applyFrontmatterTemplateText(
  source: string,
  template: Record<string, string>,
): string {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (fm) {
    const body = fm[1]
    const lines = body.split('\n')
    const existing = new Set(
      lines.map((l) => /^([A-Za-z0-9_-]+):/.exec(l)?.[1] ?? '').filter(Boolean),
    )
    const additions: string[] = []
    for (const [k, v] of Object.entries(template)) {
      if (!existing.has(k)) additions.push(`${k}: ${v}`)
    }
    if (additions.length === 0) return source
    return `---\n${body}\n${additions.join('\n')}\n---\n${source.slice(fm[0].length)}`
  }
  const items = Object.entries(template).map(([k, v]) => `${k}: ${v}`)
  return `---\n${items.join('\n')}\n---\n${source}`
}

export const applyFrontmatterTemplate = (
  tpl: Record<string, string>,
): Command => (view) => {
  const next = applyFrontmatterTemplateText(view.state.doc.toString(), tpl)
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.template',
  })
  return true
}

                                
export const promoteFirstLineToH2: Command = (view) => {
  const sel = view.state.selection.main
  if (sel.empty) return false
  const from = sel.from
  const startLine = view.state.doc.lineAt(from)
  const text = startLine.text
  if (/^#{1,6}\s+/.test(text)) return false
  view.dispatch({
    changes: { from: startLine.from, to: startLine.from, insert: '## ' },
    userEvent: 'input.heading.promote',
  })
  return true
}

                                                       
export function shiftHeadingsUpOneLevelText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      const m = /^(#{2,6})(\s+.+)$/.exec(l)
      return m ? m[1].slice(1) + m[2] : l
    })
    .join('\n')
}

export const shiftHeadingsUpOneLevel: Command = (view) =>
  applyToSelectionOrAll(view, shiftHeadingsUpOneLevelText, 'input.headings.up')

                        
export function shiftHeadingsDownOneLevelText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      const m = /^(#{1,5})(\s+.+)$/.exec(l)
      return m ? '#' + m[1] + m[2] : l
    })
    .join('\n')
}

export const shiftHeadingsDownOneLevel: Command = (view) =>
  applyToSelectionOrAll(view, shiftHeadingsDownOneLevelText, 'input.headings.down')

                                        
export function brTagsToHardBreaksText(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/<br\s*\/?>(\s*)$/i, '  '))
    .join('\n')
}

export const brTagsToHardBreaks: Command = (view) =>
  applyToSelectionOrAll(view, brTagsToHardBreaksText, 'input.brtags.normalize')

                                                                                
                                 
                                                                                  

                                                            
export const wrapSelectionWithPair = (left: string, right: string): Command => (view) => {
  const sel = view.state.selection.main
  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.from, to: sel.from, insert: left + right },
      selection: { anchor: sel.from + left.length },
      userEvent: 'input.wrap.pair',
    })
    return true
  }
  const text = view.state.sliceDoc(sel.from, sel.to)
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: left + text + right },
    selection: { anchor: sel.from + left.length + text.length + right.length },
    userEvent: 'input.wrap.pair',
  })
  return true
}

   
                                                       
                           
   
export function convertLinksToFootnotesText(source: string): string {
  // pick next footnote id
  const usedIds = new Set<number>()
  const usedRe = /\[\^(\d+)\]/g
  let mU: RegExpExecArray | null
  while ((mU = usedRe.exec(source)) !== null) {
    usedIds.add(parseInt(mU[1], 10))
  }
  let next = 1
  function nextId(): number {
    while (usedIds.has(next)) next += 1
    const v = next
    usedIds.add(v)
    next += 1
    return v
  }
  const definitions: string[] = []
  const replaced = source.replace(
    /(?<!\!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, text, url, title) => {
      const id = nextId()
      const def = title ? `[^${id}]: ${url} "${title}"` : `[^${id}]: ${url}`
      definitions.push(def)
      return `${text}[^${id}]`
    },
  )
  if (definitions.length === 0) return source
  const trimmed = replaced.replace(/\n+$/, '')
  return `${trimmed}\n\n${definitions.join('\n')}\n`
}

export const convertLinksToFootnotes: Command = (view) => {
  const next = convertLinksToFootnotesText(view.state.doc.toString())
  if (next === view.state.doc.toString()) return false
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.link.tofootnote',
  })
  return true
}

   
                                                     
                         
   
export function headingsToOutlineText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(l)
      if (m) {
        const depth = m[1].length - 1
        return `${'  '.repeat(depth)}- ${m[2]}`
      }
      return l
    })
    .join('\n')
}

export const headingsToOutline: Command = (view) =>
  applyToSelectionOrAll(view, headingsToOutlineText, 'input.headings.outline')

                                    
export function surroundEachLineWithTagText(source: string, tag: string): string {
  if (!tag) return source
  return source
    .split('\n')
    .map((l) => {
      if (l.trim().length === 0) return l
      const m = /^(\s*)(.*)$/.exec(l)!
      return `${m[1]}<${tag}>${m[2]}</${tag}>`
    })
    .join('\n')
}

export const surroundEachLineWithTag = (tag: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => surroundEachLineWithTagText(s, tag), 'input.lines.tagsurround')

                                               
export function htmlSupToCaretText(source: string): string {
  return source.replace(/<sup>([^<\n]+)<\/sup>/gi, '^$1')
}

export const htmlSupToCaret: Command = (view) =>
  applyToSelectionOrAll(view, htmlSupToCaretText, 'input.sup.normalize')

                                                
export function htmlSubToTildeText(source: string): string {
  return source.replace(/<sub>([^<\n]+)<\/sub>/gi, '~$1~')
}

export const htmlSubToTilde: Command = (view) =>
  applyToSelectionOrAll(view, htmlSubToTildeText, 'input.sub.normalize')

                                              
export function calloutsToHeadingsText(source: string): string {
  return source.replace(/^>\s*\[!([A-Za-z0-9_-]+)\][+-]?\s*(.*)$/gm, (_m, type, title) => {
    const cleanTitle = title.trim() || type
    return `## ${cleanTitle}`
  })
}

export const calloutsToHeadings: Command = (view) =>
  applyToSelectionOrAll(view, calloutsToHeadingsText, 'input.callouts.toheading')

   
                                   
                                        
   
export function inlineFootnotesText(source: string): string {
  const defs = new Map<string, string>()
  const defRe = /^\[\^([^\]]+)\]:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = defRe.exec(source)) !== null) {
    defs.set(m[1], m[2])
  }
  if (defs.size === 0) return source
  return source.replace(/\[\^([^\]]+)\]/g, (whole, id) => {
    const v = defs.get(id)
    if (!v) return whole
                
    return `${whole}(${v})`
  }).replace(/^\[\^([^\]]+)\]:\s*(.+?)\(\2\)$/gm, (_, id, body) => `[^${id}]: ${body}`)
}

export const inlineFootnotes: Command = (view) =>
  applyToSelectionOrAll(view, inlineFootnotesText, 'input.footnote.inline')

                                                                                
                                       
                                                                                  

                                           
export function countHashtagsText(source: string): Map<string, number> {
  const counts = new Map<string, number>()
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^#{1,6}\s+/.test(line)) continue
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const re = /(?<![\p{L}\p{N}_/])#([\p{L}\p{N}_\-/]+)/gu
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const t = m[1]
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return counts
}

                           
export const insertHashtagStats: Command = (view) => {
  const counts = countHashtagsText(view.state.doc.toString())
  if (counts.size === 0) return false
  const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  const lines = ['', '## Tag Stats', '', '| Tag | Count |', '| --- | ---: |']
  for (const [t, n] of rows) lines.push(`| #${t} | ${n} |`)
  const text = lines.join('\n') + '\n'
  view.dispatch({
    changes: { from: view.state.doc.length, to: view.state.doc.length, insert: text },
    userEvent: 'input.tagstats.insert',
  })
  return true
}

                                                           
export type LinkTarget = { kind: 'wikilink' | 'image' | 'mdlink'; target: string; line: number }

export function collectAllLinkTargets(source: string): LinkTarget[] {
  const out: LinkTarget[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const wl = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
    let m: RegExpExecArray | null
    while ((m = wl.exec(line)) !== null) {
      out.push({ kind: 'wikilink', target: m[1].trim(), line: i + 1 })
    }
    const img = /!\[[^\]\n]*\]\(([^)\s]+)\)/g
    while ((m = img.exec(line)) !== null) {
      out.push({ kind: 'image', target: m[1], line: i + 1 })
    }
    const md = /(?<!\!)\[[^\]\n]+\]\(([^)\s]+)\)/g
    while ((m = md.exec(line)) !== null) {
      out.push({ kind: 'mdlink', target: m[1], line: i + 1 })
    }
  }
  return out
}

                     
export const insertAllLinksReport: Command = (view) => {
  const targets = collectAllLinkTargets(view.state.doc.toString())
  if (targets.length === 0) return false
  const lines = ['', '## Links Report', '', '| # | Kind | Target | Line |', '| --: | --- | --- | --: |']
  targets.forEach((t, i) => {
    lines.push(`| ${i + 1} | ${t.kind} | ${t.target} | ${t.line} |`)
  })
  const text = lines.join('\n') + '\n'
  view.dispatch({
    changes: { from: view.state.doc.length, to: view.state.doc.length, insert: text },
    userEvent: 'input.linksreport.insert',
  })
  return true
}

   
                                                 
                                       
                     
   
export const convertParagraphToFlashcard: Command = (view) => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const text = line.text
  const idx = text.lastIndexOf('?')
  if (idx < 0 || idx === text.length - 1) {
                        
    if (idx < 0) {
      const newText = `${text}?::`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: newText },
        userEvent: 'input.flashcard.empty',
      })
      return true
    }
    return false
  }
  const q = text.slice(0, idx + 1).trim()
  const a = text.slice(idx + 1).trim()
  const newText = `${q}::${a}`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newText },
    userEvent: 'input.flashcard.qa',
  })
  return true
}

                                                                      
export const insertFlashcardSeparator: Command = (view) => {
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.head, to: sel.head, insert: '::' },
    selection: { anchor: sel.head + 2 },
    userEvent: 'input.flashcard.sep',
  })
  return true
}

                                 
export function findDuplicateHeadings(source: string): { title: string; lines: number[] }[] {
  const map = new Map<string, number[]>()
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i])
    if (m) {
      const t = m[1].toLowerCase()
      const arr = map.get(t) ?? []
      arr.push(i + 1)
      map.set(t, arr)
    }
  }
  const dup: { title: string; lines: number[] }[] = []
  for (const [t, arr] of map.entries()) {
    if (arr.length > 1) dup.push({ title: t, lines: arr })
  }
  return dup
}

                     
export const insertDuplicateHeadingsReport: Command = (view) => {
  const dup = findDuplicateHeadings(view.state.doc.toString())
  if (dup.length === 0) return false
  const lines = ['', '## Duplicate Headings', '']
  for (const { title, lines: lineNos } of dup) {
    lines.push(`- "${title}" — lines ${lineNos.join(', ')}`)
  }
  const text = lines.join('\n') + '\n'
  view.dispatch({
    changes: { from: view.state.doc.length, to: view.state.doc.length, insert: text },
    userEvent: 'input.dupheadings.insert',
  })
  return true
}

                            
export function lowercaseAllTagsText(source: string): string {
  return source.replace(
    /(?<![\p{L}\p{N}_/])#([\p{L}\p{N}_\-/]+)/gu,
    (_m, t) => `#${t.toLowerCase()}`,
  )
}

export const lowercaseAllTags: Command = (view) =>
  applyToSelectionOrAll(view, lowercaseAllTagsText, 'input.tags.lower')

                            
export function uppercaseAllTagsText(source: string): string {
  return source.replace(
    /(?<![\p{L}\p{N}_/])#([\p{L}\p{N}_\-/]+)/gu,
    (_m, t) => `#${t.toUpperCase()}`,
  )
}

export const uppercaseAllTags: Command = (view) =>
  applyToSelectionOrAll(view, uppercaseAllTagsText, 'input.tags.upper')

   
                                                       
   
export function paragraphsToHtmlBreaksText(source: string): string {
  return source.replace(/\n{2,}/g, '<br><br>')
}

export const paragraphsToHtmlBreaks: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToHtmlBreaksText, 'input.paragraphs.htmlbr')

                                                                                
                                     
                                                                                  

                                                        
export function convertMarkdownImagesToWikiEmbedsText(source: string): string {
  return source.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, alt, path) => {
    if (alt) return `![[${path}|${alt}]]`
    return `![[${path}]]`
  })
}

export const convertMarkdownImagesToWikiEmbeds: Command = (view) =>
  applyToSelectionOrAll(view, convertMarkdownImagesToWikiEmbedsText, 'input.image.toembed')

                                           
export function convertDocumentEmbedToMdImageText(source: string): string {
  return source.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, path, alt) => {
    return `![${(alt ?? '').trim()}](${path.trim()})`
  })
}

export const convertDocumentEmbedToMdImage: Command = (view) =>
  applyToSelectionOrAll(view, convertDocumentEmbedToMdImageText, 'input.image.toMd')

                                                 
export function setImageWidthForEmbedsText(source: string, width: number): string {
  return source.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, path, attrs) => {
    if (attrs && /\d+/.test(attrs)) return `![[${path}|${attrs}]]` // already has width
    if (attrs) return `![[${path}|${attrs}|${width}]]`
    return `![[${path}|${width}]]`
  })
}

export const setImageWidthForEmbeds = (width: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => setImageWidthForEmbedsText(s, width), 'input.image.width')

                                                            
export function injectHtmlAnchorsBeforeHeadingsText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence
        return l
      }
      if (inFence) return l
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(l)
      if (!m) return l
      const slug = m[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/(^-|-$)/g, '')
      if (!slug) return l
      // skip if previous line already has anchor for this slug
      return `<a id="${slug}"></a>\n${l}`
    })
    .join('\n')
}

export const injectHtmlAnchorsBeforeHeadings: Command = (view) =>
  applyToSelectionOrAll(
    view,
    injectHtmlAnchorsBeforeHeadingsText,
    'input.headings.htmlanchor',
  )

                                          
export function compressTableCellWhitespaceText(source: string): string {
  return source
    .split('\n')
    .map((l) => {
      if (!l.trim().startsWith('|')) return l
      return l.replace(/\|([^|]+)/g, (_m, cell) => {
        const inner = cell.replace(/\s+/g, ' ').trim()
        return `| ${inner}`
      }) + ' |'.slice(l.trim().endsWith('|') ? 0 : 0)
    })
    .join('\n')
}

export const compressTableCellWhitespace: Command = (view) =>
  applyToSelectionOrAll(view, compressTableCellWhitespaceText, 'input.table.whitespace')

/** Replace Markdown link labels with the destination hostname. */
export function abbreviateLinksToHostText(source: string): string {
  return source.replace(
    /(?<!\!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (whole, _text, url) => {
      try {
        const host = new URL(url).host.replace(/^www\./, '')
        return `[${host}](${url})`
      } catch {
        return whole
      }
    },
  )
}

export const abbreviateLinksToHost: Command = (view) =>
  applyToSelectionOrAll(view, abbreviateLinksToHostText, 'input.links.abbreviate')

                                                                 
                                                                   
                        
                                                     
                         
           
                                                            
                                  
               
                 
       
      
   
 

                                                       
                                                                                  

                                                           
export function relativeMdLinksToWikilinksText(source: string): string {
  return source.replace(
    /(?<!\!)\[([^\]\n]+)\]\(([^):\s]+)\)/g,
    (whole, text, href) => {
      if (/[?#]/.test(href)) return whole
      if (/\.[a-z0-9]+$/i.test(href)) return whole
      if (text === href) return `[[${href}]]`
      return `[[${href}|${text}]]`
    },
  )
}

export const relativeMdLinksToWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, relativeMdLinksToWikilinksText, 'input.links.toWiki')

                                               
export function defaultCalloutTitlesText(source: string): string {
  return source.replace(/^(>\s*\[!([A-Za-z0-9_-]+)\][+-]?)(\s*)$/gm, (_m, head, type) => {
    const cap = type.charAt(0).toUpperCase() + type.slice(1)
    return `${head} ${cap}`
  })
}

export const defaultCalloutTitles: Command = (view) =>
  applyToSelectionOrAll(view, defaultCalloutTitlesText, 'input.callouts.titles')

   
                                   
                   
                              
   
export function numberHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const counters: number[] = []
  let prevLevel = 0
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const level = m[1].length
    const title = m[2].replace(/^(\d+(?:\.\d+)*\.?)\s+/, '')
    if (level > prevLevel) {
      for (let i = prevLevel; i < level; i++) counters.push(0)
    } else if (level < prevLevel) {
      while (counters.length > level) counters.pop()
    }
    counters[level - 1] = (counters[level - 1] ?? 0) + 1
    for (let i = level; i < counters.length; i++) counters[i] = 0
    const num = counters.slice(0, level).join('.')
    prevLevel = level
    out.push(`${m[1]} ${num} ${title}`)
  }
  return out.join('\n')
}

                                         
export function unnumberHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(#{1,6})\s+(\d+(?:\.\d+)*\.?)\s+/, '$1 ')
    })
    .join('\n')
}

                                                                       
export function tidyLinkTextFromSlugText(source: string): string {
  return source.replace(
    /(?<!\!)\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (whole, text, href) => {
      if (text !== href) return whole
      try {
        const u = new URL(href)
        const segs = u.pathname.split('/').filter(Boolean)
        const last = segs[segs.length - 1] ?? u.host
        const clean = last
          .replace(/\.(html?|md|php|aspx?)$/i, '')
          .replace(/[-_]+/g, ' ')
          .trim()
        if (!clean) return whole
        return `[${clean}](${href})`
      } catch {
        return whole
      }
    },
  )
}

export const tidyLinkTextFromSlug: Command = (view) =>
  applyToSelectionOrAll(view, tidyLinkTextFromSlugText, 'input.links.slugText')

                                                        
export function prefixTasksWithEmojiInRange(
  source: string,
  fromLine: number,
  toLine: number,
  emoji: string,
): string {
  const lines = source.split('\n')
  for (let i = fromLine; i <= toLine && i < lines.length; i++) {
    const m = /^(\s*[-*+]\s\[[ xX/\->!?]\]\s)(.*)$/.exec(lines[i])
    if (!m) continue
    if (m[2].startsWith(`${emoji} `)) continue
    lines[i] = `${m[1]}${emoji} ${m[2]}`
  }
  return lines.join('\n')
}

export function prefixSectionTasksWithEmoji(emoji: string): Command {
  return (view) => {
    const cur = findCurrentSection(view.state)
    if (!cur) return false
    const doc = view.state.doc
    const fromLine = cur.headingLineNo + 1
    const toLine = cur.endLineNo
    const src = doc.toString()
    const next = prefixTasksWithEmojiInRange(src, fromLine - 1, toLine - 1, emoji)
    if (next === src) return false
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: next },
      userEvent: 'input.tasks.prefixEmoji',
    })
    return true
  }
}

                                                       
export function normalizeHorizontalRulesText(source: string, style: '---' | '***' | '___'): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) return style
      return line
    })
    .join('\n')
}

export function normalizeHorizontalRules(style: '---' | '***' | '___'): Command {
  return (view) => applyToSelectionOrAll(view, (s) => normalizeHorizontalRulesText(s, style), 'input.hr.normalize')
}

                                                         
export function fillImageAltFromFilenameText(source: string): string {
  return source.replace(/!\[\s*\]\(([^)\s]+)([^)]*)\)/g, (_whole, href, rest) => {
    const seg = href.split(/[\\/]/).pop() ?? ''
    const base = seg.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim()
    if (!base) return `![](${href}${rest})`
    return `![${base}](${href}${rest})`
  })
}

export const fillImageAltFromFilename: Command = (view) =>
  applyToSelectionOrAll(view, fillImageAltFromFilenameText, 'input.images.altFromFilename')

                                        
export function sortSectionsByHeadingText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const blocks: { title: string; lines: string[] }[] = []
  const prefix: string[] = []
  let current: { title: string; lines: string[] } | null = null
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      if (current) current.lines.push(line)
      else prefix.push(line)
      continue
    }
    if (!inFence && /^##\s+/.test(line)) {
      if (current) blocks.push(current)
      const title = line.replace(/^##\s+/, '').trim().toLowerCase()
      current = { title, lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
    else prefix.push(line)
  }
  if (current) blocks.push(current)
  blocks.sort((a, b) => a.title.localeCompare(b.title))
  const flat: string[] = [...prefix]
  for (const b of blocks) flat.push(...b.lines)
  return flat.join('\n')
}

export const sortSectionsByHeading: Command = (view) =>
  applyToSelectionOrAll(view, sortSectionsByHeadingText, 'input.sections.sortByHeading')

                                                
export function insertTodayWikilinkAtCursor(view: EditorView): boolean {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const link = `[[${yyyy}-${mm}-${dd}]]`
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: link },
    selection: { anchor: sel.from + link.length },
    userEvent: 'input.daily.wikilink',
  })
  return true
}

                                       
export function tabsToListText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(\t+)(.*)$/.exec(line)
      if (!m) return line
      const depth = m[1].length
      const indent = '  '.repeat(depth - 1)
      return `${indent}- ${m[2]}`
    })
    .join('\n')
}

export const tabsToList: Command = (view) =>
  applyToSelectionOrAll(view, tabsToListText, 'input.list.fromTabs')

   
                                   
   
export function tagCurrentSection(tag: string): Command {
  return (view) => {
    const cur = findCurrentSection(view.state)
    if (!cur) return false
    const tagged = tag.startsWith('#') ? tag : `#${tag}`
    const doc = view.state.doc
    const line = doc.line(cur.headingLineNo)
    if (line.text.includes(tagged)) return false
    const insert = `${line.text} ${tagged}`
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      userEvent: 'input.section.tag',
    })
    return true
  }
}

                                    
export function paragraphsToQuotesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (line.trim() === '') return line
      if (/^[#>\-*+]|^\d+\./.test(line)) return line
      return `> ${line}`
    })
    .join('\n')
}

export const paragraphsToQuotes: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToQuotesText, 'input.paragraphs.toQuotes')

                                     
export function unquoteParagraphsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^>\s?/, '')
    })
    .join('\n')
}

export const unquoteParagraphs: Command = (view) =>
  applyToSelectionOrAll(view, unquoteParagraphsText, 'input.paragraphs.unquote')

                                  
export function redactSelection(view: EditorView): boolean {
  const sel = view.state.selection.main
  if (sel.empty) return false
  const text = view.state.sliceDoc(sel.from, sel.to)
  const redacted = text
    .split('')
    .map((c) => (c === '\n' || c === ' ' || c === '\t' ? c : '●'))
    .join('')
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: redacted },
    selection: { anchor: sel.from + redacted.length },
    userEvent: 'input.redact',
  })
  return true
}

                           
export function listSummaryText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  let count = 0
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) count += 1
  }
  if (count === 0) return source
  return `${source.replace(/\n+$/, '')}\n\n${count} items\n`
}

export const insertListSummary: Command = (view) =>
  applyToSelectionOrAll(view, listSummaryText, 'input.list.summary')

                                 
export function stripFrontmatterText(source: string): string {
  if (!source.startsWith('---\n')) return source
  const end = source.indexOf('\n---', 4)
  if (end === -1) return source
  return source.slice(end + 4).replace(/^\n/, '')
}

   
                                        
   
export function surroundSelectionWithPair(left: string, right: string): Command {
  return (view) => {
    const sel = view.state.selection.main
    const inside = view.state.sliceDoc(sel.from, sel.to)
    const insert = `${left}${inside}${right}`
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: sel.empty
        ? { anchor: sel.from + left.length }
        : EditorSelection.range(sel.from + left.length, sel.from + left.length + inside.length),
      userEvent: 'input.surround',
    })
    return true
  }
}

                                                              
export function wikilinksToFootnotesInRange(
  source: string,
  from: number,
  to: number,
): string {
  const head = source.slice(0, from)
  const middle = source.slice(from, to)
  const tail = source.slice(to)
  const refs: string[] = []
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  const rewritten = middle.replace(re, (_w, target, alias) => {
    const idx = refs.length + 1
    refs.push(`[^${idx}]: [[${target}]]`)
    return `${alias ?? target}[^${idx}]`
  })
  if (refs.length === 0) return source
  return `${head}${rewritten}${tail.replace(/\n*$/, '\n\n')}${refs.join('\n')}\n`
}

export const wikilinksInSectionToFootnotes: Command = (view) => {
  const cur = findCurrentSection(view.state)
  if (!cur) return false
  const doc = view.state.doc
  const from = doc.line(cur.headingLineNo).from
  const to = doc.line(cur.endLineNo).to
  const src = doc.toString()
  const next = wikilinksToFootnotesInRange(src, from, to)
  if (next === src) return false
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: next },
    userEvent: 'input.section.wikilinks.toFootnotes',
  })
  return true
}

   
                                           
                
   
export function extractTableColumnAsListText(source: string, colIndex: number): string {
  const lines = source.split('\n')
  let tableStart = -1
  let sepLine = -1
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      tableStart = i
      sepLine = i + 1
      break
    }
  }
  if (tableStart === -1) return source
  const items: string[] = []
  for (let i = sepLine + 1; i < lines.length; i++) {
    if (!lines[i].includes('|')) break
    const cells = parseTableRow(lines[i])
    if (colIndex - 1 < cells.length) items.push(`- ${cells[colIndex - 1].trim()}`)
  }
  if (items.length === 0) return source
  return `${source.replace(/\n+$/, '')}\n\n${items.join('\n')}\n`
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
}

export function extractTableColumnAsList(colIndex: number): Command {
  return (view) =>
    applyToSelectionOrAll(
      view,
      (s) => extractTableColumnAsListText(s, colIndex),
      'input.table.colToList',
    )
}

                                  
export function transformTableCellsText(
  source: string,
  fn: (s: string) => string,
): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line, idx) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (!line.includes('|')) return line
      if (idx + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[idx + 1])) return line
      if (/^\s*\|?\s*[-:]+/.test(line)) return line
      const cells = parseTableRow(line).map((c) => fn(c.trim()))
      return `| ${cells.join(' | ')} |`
    })
    .join('\n')
}

export const tableCellsToUpper: Command = (view) =>
  applyToSelectionOrAll(view, (s) => transformTableCellsText(s, (x) => x.toUpperCase()), 'input.table.upper')

export const tableCellsToLower: Command = (view) =>
  applyToSelectionOrAll(view, (s) => transformTableCellsText(s, (x) => x.toLowerCase()), 'input.table.lower')

                             
export function filterListItemsText(source: string, keyword: string): string {
  if (!keyword) return source
  const lines = source.split('\n')
  let inFence = false
  return lines
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return true
      }
      if (inFence) return true
      const isItem = /^\s*([-*+]|\d+\.)\s+/.test(line)
      if (!isItem) return true
      return line.toLowerCase().includes(keyword.toLowerCase())
    })
    .join('\n')
}

export function filterListItems(keyword: string): Command {
  return (view) => applyToSelectionOrAll(view, (s) => filterListItemsText(s, keyword), 'input.list.filter')
}

                                  
export function keepCheckedTasksOnlyText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return true
      }
      if (inFence) return true
      const m = /^\s*[-*+]\s\[([ xX])\]/.exec(line)
      if (!m) return true
      return m[1].toLowerCase() === 'x'
    })
    .join('\n')
}

export const keepCheckedTasksOnly: Command = (view) =>
  applyToSelectionOrAll(view, keepCheckedTasksOnlyText, 'input.tasks.keepChecked')

                                        
export function removeInlineCodeBackticksText(source: string): string {
  return source.replace(/`([^`\n]+)`/g, '$1')
}

export const removeInlineCodeBackticks: Command = (view) =>
  applyToSelectionOrAll(view, removeInlineCodeBackticksText, 'input.code.unfence')

   
                               
                        
   
export function singleLineFenceToInlineText(source: string): string {
  return source.replace(/```([a-zA-Z0-9_-]*)\n([^\n`]+)\n```/g, (_w, _lang, body) => {
    return `\`${body}\``
  })
}

export const singleLineFenceToInline: Command = (view) =>
  applyToSelectionOrAll(view, singleLineFenceToInlineText, 'input.code.toInline')

                                                   
export function calloutHeaderToHeadingText(source: string): string {
  return source.replace(/^>\s*\[![A-Za-z0-9_-]+\][+-]?\s*(.*)$/gm, (_w, title) => {
    const t = title.trim()
    return t ? `## ${t}` : '## Note'
  })
}

export const calloutHeaderToHeading: Command = (view) =>
  applyToSelectionOrAll(view, calloutHeaderToHeadingText, 'input.callout.toHeading')

                                    
export function inlineMathToBlockText(source: string): string {
  return source.replace(/^([ \t]*)\$([^$\n]+)\$\s*$/gm, (_w, indent, body) => {
    return `${indent}$$\n${indent}${body}\n${indent}$$`
  })
}

export const inlineMathToBlock: Command = (view) =>
  applyToSelectionOrAll(view, inlineMathToBlockText, 'input.math.toBlock')

                                             
export function detectLangByHeuristic(text: string): string {
  if (/^\s*(?:import|from|def |class |print\()/m.test(text)) return 'python'
  if (/^\s*(?:func |package |import \("|var .*=.*)/m.test(text)) return 'go'
  if (/^\s*(?:const |let |function |=>|console\.)/m.test(text)) return 'ts'
  if (/^\s*(?:SELECT |INSERT |UPDATE |DELETE )/im.test(text)) return 'sql'
  if (/^\s*(?:#include|int main|::)/m.test(text)) return 'cpp'
  if (/^\s*<\?(?:php|=)/m.test(text)) return 'php'
  if (/^\s*(?:fn |let mut|use std)/m.test(text)) return 'rust'
  if (/^\s*\{/m.test(text) && /[":,]/.test(text)) return 'json'
  return ''
}

export function wrapSelectionAsAutodetectedCode(view: EditorView): boolean {
  const sel = view.state.selection.main
  if (sel.empty) return false
  const text = view.state.sliceDoc(sel.from, sel.to)
  const lang = detectLangByHeuristic(text)
  const insert = `\`\`\`${lang}\n${text.replace(/\n+$/, '')}\n\`\`\``
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    userEvent: 'input.code.autodetect',
  })
  return true
}

                              
export function insertDataviewQuery(kind: 'list' | 'table' | 'tasks'): Command {
  return (view) => {
    const sel = view.state.selection.main
    const body =
      kind === 'list'
        ? 'list from #tag\nsort file.mtime desc'
        : kind === 'table'
          ? 'table file.mtime as Modified from #tag\nsort file.mtime desc'
          : 'task from ""\nwhere !completed'
    const block = `\`\`\`dataview\n${body}\n\`\`\``
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: block },
      selection: { anchor: sel.from + block.length },
      userEvent: 'input.dataview.insert',
    })
    return true
  }
}

                                         
export function highlightsToMarkText(source: string): string {
  return source.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
}

export const highlightsToMark: Command = (view) =>
  applyToSelectionOrAll(view, highlightsToMarkText, 'input.highlight.toMark')

                                     
export function markToHighlightsText(source: string): string {
  return source.replace(/<mark>([\s\S]*?)<\/mark>/gi, '==$1==')
}

export const markToHighlights: Command = (view) =>
  applyToSelectionOrAll(view, markToHighlightsText, 'input.mark.toHighlight')

                                 
export function normalizeBulletsToDashText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(\s*)[*+](\s)/, '$1-$2')
    })
    .join('\n')
}

export const normalizeBulletsToDash: Command = (view) =>
  applyToSelectionOrAll(view, normalizeBulletsToDashText, 'input.bullets.normalize')

                                       
export function atxHeadingCloseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
      if (!m) return line
      if (m[2].endsWith(m[1])) return line
      return `${m[1]} ${m[2]} ${m[1]}`
    })
    .join('\n')
}

export const atxHeadingClose: Command = (view) =>
  applyToSelectionOrAll(view, atxHeadingCloseText, 'input.headings.close')

                        
export function stripAtxCloseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(#{1,6})\s+(.*?)\s+#{1,6}\s*$/, '$1 $2')
    })
    .join('\n')
}

export const stripAtxClose: Command = (view) =>
  applyToSelectionOrAll(view, stripAtxCloseText, 'input.headings.stripClose')

                             
export function insertNoteMetadataBlock(view: EditorView): boolean {
  const now = new Date()
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const block = `---\ncreated: ${ymd}\nupdated: ${ymd}\ntags: []\naliases: []\n---\n`
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: 0, to: 0, insert: block },
    selection: { anchor: sel.from + block.length },
    userEvent: 'input.metadata.insert',
  })
  return true
}

                            
export function insertTableEmptyRowText(source: string): string {
  const lines = source.split('\n')
  let lastTableEnd = -1
  let cols = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|')) {
      if (cols === 0) {
        cols = lines[i].split('|').filter((c) => c.trim() !== '').length
      }
      lastTableEnd = i
    } else if (lastTableEnd !== -1) {
      break
    }
  }
  if (lastTableEnd === -1 || cols === 0) return source
  const empty = `| ${Array(cols).fill('').join(' | ')} |`
  return [...lines.slice(0, lastTableEnd + 1), empty, ...lines.slice(lastTableEnd + 1)].join('\n')
}

export const insertTableEmptyRow: Command = (view) =>
  applyToSelectionOrAll(view, insertTableEmptyRowText, 'input.table.emptyRow')

                                   
export function annotateWikilinksWithEmojiText(source: string, emoji: string): string {
  return source.replace(/\[\[[^\]\n]+\]\]/g, (m) => {
    return `${m} ${emoji}`
  })
}

export function annotateWikilinksWithEmoji(emoji: string): Command {
  return (view) =>
    applyToSelectionOrAll(
      view,
      (s) => annotateWikilinksWithEmojiText(s, emoji),
      'input.wikilinks.annotate',
    )
}

                                            
export function unifyFrontmatterTagsText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const fm = m[1]
  const tagLines = fm.match(/^tags?:\s*(.*)$/gm) ?? []
  if (tagLines.length <= 1) return source
  const all = new Set<string>()
  for (const line of tagLines) {
    const after = line.replace(/^tags?:\s*/, '').trim()
    if (after.startsWith('[')) {
      after
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
        .forEach((t) => all.add(t))
    } else if (after) {
      after.split(/[\s,]+/).filter(Boolean).forEach((t) => all.add(t))
    }
  }
  const remaining = fm
    .split('\n')
    .filter((l) => !/^tags?:/.test(l))
    .join('\n')
  const tagsLine = `tags: [${Array.from(all).map((t) => `"${t}"`).join(', ')}]`
  return source.replace(/^---\n[\s\S]*?\n---/, `---\n${remaining}\n${tagsLine}\n---`)
}

export const unifyFrontmatterTags: Command = (view) =>
  applyToSelectionOrAll(view, unifyFrontmatterTagsText, 'input.frontmatter.unifyTags')

                                   
export function buildScopedTOCText(source: string, maxDepth: number): string {
  const lines = source.split('\n')
  let inFence = false
  const items: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,6})\s+(.+)$/.exec(line)
    if (!m) continue
    const level = m[1].length
    if (level > maxDepth) continue
    const indent = '  '.repeat(level - 2)
    items.push(`${indent}- ${m[2].trim()}`)
  }
  return items.join('\n')
}

export function insertScopedTOC(maxDepth: number): Command {
  return (view) => {
    const sel = view.state.selection.main
    const src = view.state.doc.toString()
    const toc = buildScopedTOCText(src, maxDepth)
    if (!toc) return false
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: toc },
      selection: { anchor: sel.from + toc.length },
      userEvent: 'input.toc.scoped',
    })
    return true
  }
}

                                                    
export function promoteH1ToFrontmatterTitleText(source: string): string {
  const h1 = /^#\s+(.+)$/m.exec(source)
  if (!h1) return source
  const title = h1[1].trim()
  if (source.startsWith('---\n')) {
    const end = source.indexOf('\n---', 4)
    if (end !== -1) {
      const fm = source.slice(4, end)
      if (/^title:/m.test(fm)) return source
      return `---\ntitle: ${title}\n${fm}${source.slice(end)}`
    }
  }
  return `---\ntitle: ${title}\n---\n${source}`
}

export const promoteH1ToFrontmatterTitle: Command = (view) =>
  applyToSelectionOrAll(view, promoteH1ToFrontmatterTitleText, 'input.frontmatter.fromH1')

                                              
const TASK_STATE_ROTATION = [' ', 'x', '-', '?'] as const

export function rotateTaskStateAtCursor(view: EditorView): boolean {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const m = /^(\s*[-*+]\s\[)([ xX\-?/])(\].*)$/.exec(line.text)
  if (!m) return false
  const cur = m[2].toLowerCase()
  const idx = TASK_STATE_ROTATION.indexOf(cur as any)
  const next = TASK_STATE_ROTATION[(idx + 1) % TASK_STATE_ROTATION.length]
  const insert = `${m[1]}${next}${m[3]}`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    userEvent: 'input.task.rotateState',
  })
  return true
}

                                           
export function insertBreadcrumbAtTop(path: string): Command {
  return (view) => {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return false
    const last = parts.pop() ?? ''
    const base = last.replace(/\.[a-z0-9]+$/i, '')
    const crumb = [...parts, base].join(' / ')
    const line = `> ${crumb}\n\n`
    view.dispatch({
      changes: { from: 0, to: 0, insert: line },
      userEvent: 'input.breadcrumb.insert',
    })
    return true
  }
}

                                        
export function splitLongLinesAtSentencesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || /^[#>\-*+]|^\d+\./.test(line) || line.length < 60) {
      out.push(line)
      continue
    }
    const parts = line
      .split(/(?<=\p{Sentence_Terminal})\s+/u)
      .filter((p) => p.length > 0)
    out.push(...parts)
  }
  return out.join('\n')
}

export const splitLongLinesAtSentences: Command = (view) =>
  applyToSelectionOrAll(view, splitLongLinesAtSentencesText, 'input.lines.splitSentences')

                   
export function dedupAdjacentParagraphsText(source: string): string {
  const lines = source.split('\n')
  let prev: string | null = null
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() && line === prev) continue
    out.push(line)
    prev = line
  }
  return out.join('\n')
}

export const dedupAdjacentParagraphs: Command = (view) =>
  applyToSelectionOrAll(view, dedupAdjacentParagraphsText, 'input.paragraphs.dedupAdj')

                                                                
export function alignImagesText(source: string, align: 'center' | 'right' | 'left'): string {
  return source.replace(/^(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))$/gm, (_w, img) => {
    return `<p align="${align}">${img}</p>`
  })
}

export function alignImages(align: 'center' | 'right' | 'left'): Command {
  return (view) => applyToSelectionOrAll(view, (s) => alignImagesText(s, align), 'input.images.align')
}

                                             
export function tagSectionTasksInRange(
  source: string,
  fromLine: number,
  toLine: number,
  tag: string,
): string {
  const tagged = tag.startsWith('#') ? tag : `#${tag}`
  const lines = source.split('\n')
  for (let i = fromLine; i <= toLine && i < lines.length; i++) {
    const m = /^(\s*[-*+]\s\[[ xX\-?/]\]\s.*?)\s*$/.exec(lines[i])
    if (!m) continue
    if (m[1].includes(tagged)) continue
    lines[i] = `${m[1]} ${tagged}`
  }
  return lines.join('\n')
}

export function tagSectionTasks(tag: string): Command {
  return (view) => {
    const cur = findCurrentSection(view.state)
    if (!cur) return false
    const doc = view.state.doc
    const src = doc.toString()
    const next = tagSectionTasksInRange(src, cur.headingLineNo, cur.endLineNo - 1, tag)
    if (next === src) return false
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: next },
      userEvent: 'input.section.tasks.tag',
    })
    return true
  }
}

                                              
export type TagTreeNode = { name: string; children: Map<string, TagTreeNode>; count: number }

export function collectTagTree(source: string): TagTreeNode {
  const root: TagTreeNode = { name: '', children: new Map(), count: 0 }
  const lines = source.split('\n')
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const re = /(?:^|[\s,;()\[\]])#([\p{L}\p{N}_\-/]+)/gu
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const parts = m[1].split('/').filter(Boolean)
      let node = root
      for (const p of parts) {
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, children: new Map(), count: 0 })
        }
        node = node.children.get(p)!
        node.count += 1
      }
    }
  }
  return root
}

export function renderTagTree(tree: TagTreeNode, depth = 0): string {
  const out: string[] = []
  const entries = Array.from(tree.children.values()).sort((a, b) => a.name.localeCompare(b.name))
  for (const node of entries) {
    out.push(`${'  '.repeat(depth)}- #${node.name} (${node.count})`)
    if (node.children.size > 0) out.push(renderTagTree(node, depth + 1))
  }
  return out.filter(Boolean).join('\n')
}

export const insertTagTree: Command = (view) => {
  const src = view.state.doc.toString()
  const tree = collectTagTree(src)
  const rendered = renderTagTree(tree)
  if (!rendered) return false
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: rendered },
    selection: { anchor: sel.from + rendered.length },
    userEvent: 'input.tags.tree',
  })
  return true
}

   
                                              
                                      
   
export function buildMermaidFromWikilinks(source: string, direction: 'TD' | 'LR' = 'TD'): string {
  const targets = new Set<string>()
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) targets.add(m[1].trim())
  if (targets.size === 0) return ''
  const lines = [`\`\`\`mermaid`, `graph ${direction}`, `  N["This document"]`]
  let i = 0
  for (const t of targets) {
    const id = `T${i++}`
    lines.push(`  ${id}["${t.replace(/"/g, '\\"')}"]`)
    lines.push(`  N --> ${id}`)
  }
  lines.push('```')
  return lines.join('\n')
}

export function insertMermaidGraphFromSection(direction: 'TD' | 'LR'): Command {
  return (view) => {
    const cur = findCurrentSection(view.state)
    const doc = view.state.doc
    const src = doc.toString()
    let sectionText = src
    if (cur) {
      const fromOff = doc.line(cur.headingLineNo).from
      const toOff = doc.line(cur.endLineNo).to
      sectionText = src.slice(fromOff, toOff)
    }
    const graph = buildMermaidFromWikilinks(sectionText, direction)
    if (!graph) return false
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: graph },
      selection: { anchor: sel.from + graph.length },
      userEvent: 'input.mermaid.fromSection',
    })
    return true
  }
}

                                                 
export function swapMermaidDirectionText(source: string): string {
  return source.replace(
    /(```mermaid\n)(\s*graph\s+)(TD|LR|TB|RL|BT)/g,
    (_w, head, label, dir) => {
      const next = dir === 'TD' || dir === 'TB' ? 'LR' : 'TD'
      return `${head}${label}${next}`
    },
  )
}

export const swapMermaidDirection: Command = (view) =>
  applyToSelectionOrAll(view, swapMermaidDirectionText, 'input.mermaid.swapDirection')

                                                       
export function renameWikilinkText(source: string, oldName: string, newName: string): string {
  if (!oldName || !newName || oldName === newName) return source
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(\\[\\[)${escaped}(\\||\\]\\])`, 'g')
  return source.replace(re, (_w, open, tail) => `${open}${newName}${tail}`)
}

export function renameWikilinkInDoc(oldName: string, newName: string): Command {
  return (view) =>
    applyToSelectionOrAll(view, (s) => renameWikilinkText(s, oldName, newName), 'input.wikilink.rename')
}

                                        
export function tagsToWikilinksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const masked = line
      return masked.replace(
        /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu,
        (_w, lead, tag) => `${lead}[[${tag}]]`,
      )
    })
    .join('\n')
}

export const tagsToWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, tagsToWikilinksText, 'input.tags.toWikilinks')

                                      
export function addFrontmatterAliasText(source: string, alias: string): string {
  if (!alias) return source
  const headM = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!headM) return `---\naliases: ["${alias}"]\n---\n${source}`
  const fm = headM[1]
  const aliasLineM = /^aliases:\s*\[([^\]]*)\]\s*$/m.exec(fm)
  if (!aliasLineM) {
    return source.replace(headM[0], `---\n${fm}\naliases: ["${alias}"]\n---`)
  }
  const current = aliasLineM[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  if (current.includes(alias)) return source
  current.push(alias)
  const next = `aliases: [${current.map((s) => `"${s}"`).join(', ')}]`
  return source.replace(aliasLineM[0], next)
}

export function addFrontmatterAlias(alias: string): Command {
  return (view) =>
    applyToSelectionOrAll(view, (s) => addFrontmatterAliasText(s, alias), 'input.frontmatter.addAlias')
}

                                                        
export function addReadingCssclassText(source: string, cssclass: string): string {
  const headM = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!headM) return `---\ncssclasses: ["${cssclass}"]\n---\n${source}`
  const fm = headM[1]
  const cssM = /^cssclasses?:\s*\[([^\]]*)\]\s*$/m.exec(fm)
  if (!cssM) {
    return source.replace(headM[0], `---\n${fm}\ncssclasses: ["${cssclass}"]\n---`)
  }
  const current = cssM[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  if (current.includes(cssclass)) return source
  current.push(cssclass)
  const next = `cssclasses: [${current.map((s) => `"${s}"`).join(', ')}]`
  return source.replace(cssM[0], next)
}

export function addReadingCssclass(cssclass: string): Command {
  return (view) =>
    applyToSelectionOrAll(view, (s) => addReadingCssclassText(s, cssclass), 'input.frontmatter.cssclass')
}

                                            
export function insertSnippet(template: string): Command {
  return (view) => {
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: template },
      selection: { anchor: sel.from + template.length },
      userEvent: 'input.snippet.insert',
    })
    return true
  }
}

                     
export function buildReviewNoteSnippet(): string {
  const now = new Date()
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `# Review ${ymd}\n\n## Highlights\n- \n\n## Challenges / Reflections\n- \n\n## Next Steps\n- [ ] \n`
}

export function buildMeetingNoteSnippet(): string {
  const now = new Date()
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `# Meeting ${ymd}\n\n**Attendees:** \n**Agenda:** \n\n## Discussion\n- \n\n## Decisions\n- \n\n## Action Items\n- [ ] @someone — \n`
}

export function buildWeeklyReviewSnippet(): string {
  const now = new Date()
  const week = Math.ceil(((+now - +new Date(now.getFullYear(), 0, 1)) / 86400000 + 1) / 7)
  return `# Week ${week} Review\n\n## Done\n- \n\n## Not Done\n- [ ] \n\n## Lessons Learned\n- \n\n## Next Week\n- [ ] \n`
}

                                                           
export function applyColorHighlight(color: string): Command {
  return (view) => {
    const sel = view.state.selection.main
    const text = view.state.sliceDoc(sel.from, sel.to)
    const insert = `<span style="background:${color}">${text}</span>`
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      userEvent: 'input.color.highlight',
    })
    return true
  }
}

                                          
export function swapAdjacentTableColumnsText(source: string, col: number): string {
  const lines = source.split('\n')
  let tableStart = -1
  let sepLine = -1
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      tableStart = i
      sepLine = i + 1
      break
    }
  }
  if (tableStart === -1) return source
  const headCells = parseTableRow(lines[tableStart])
  if (col < 1 || col >= headCells.length) return source

  const swap = (cells: string[]): string[] => {
    const next = cells.slice()
    ;[next[col - 1], next[col]] = [next[col], next[col - 1]]
    return next
  }

  const rewriteRow = (line: string): string => {
    const cells = parseTableRow(line)
    if (cells.length < col + 1) return line
    return `| ${swap(cells).map((c) => c.trim()).join(' | ')} |`
  }

  const out = lines.slice()
  out[tableStart] = rewriteRow(lines[tableStart])
  out[sepLine] = rewriteRow(lines[sepLine])
  for (let i = sepLine + 1; i < lines.length && lines[i].includes('|'); i++) {
    out[i] = rewriteRow(lines[i])
  }
  return out.join('\n')
}

export function swapAdjacentTableColumns(col: number): Command {
  return (view) =>
    applyToSelectionOrAll(view, (s) => swapAdjacentTableColumnsText(s, col), 'input.table.swapCols')
}

                              
export function insertLightboxImage(view: EditorView): boolean {
  const url = window.prompt?.('Image URL:') ?? null
  if (!url) return false
  const alt = window.prompt?.('Alt text (optional):', '') ?? ''
  const block = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${alt}" /></a>`
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: block },
    selection: { anchor: sel.from + block.length },
    userEvent: 'input.image.lightbox',
  })
  return true
}

                                   
export function forceHardBreaksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line, idx) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (line.trim() === '') return line
      if (idx === lines.length - 1) return line
      return `${line.replace(/\s+$/, '')}  `
    })
    .join('\n')
}

export const forceHardBreaks: Command = (view) =>
  applyToSelectionOrAll(view, forceHardBreaksText, 'input.lines.forceHardBreaks')

                                       
export function toggleCalloutFoldText(source: string): string {
  return source.replace(/^(>\s*\[![A-Za-z0-9_-]+\])([+-]?)/gm, (_w, head, mark) => {
    if (mark === '-') return head
    if (mark === '+') return `${head}-`
    return `${head}+`
  })
}

export const toggleCalloutFold: Command = (view) =>
  applyToSelectionOrAll(view, toggleCalloutFoldText, 'input.callout.toggleFold')

                                                             
export function videoLinksToEmbedText(source: string): string {
  return source.replace(
    /(?<!\!)\[([^\]\n]+)\]\(([^):\s]+\.(?:mp4|webm|ogv|mov))\)/gi,
    (_w, _label, href) => `![[${href}]]`,
  )
}

export const videoLinksToEmbed: Command = (view) =>
  applyToSelectionOrAll(view, videoLinksToEmbedText, 'input.video.toEmbed')

                                       
export function audioLinksToEmbedText(source: string): string {
  return source.replace(
    /(?<!\!)\[([^\]\n]+)\]\(([^):\s]+\.(?:mp3|wav|ogg|m4a|flac))\)/gi,
    (_w, _label, href) => `![[${href}]]`,
  )
}

export const audioLinksToEmbed: Command = (view) =>
  applyToSelectionOrAll(view, audioLinksToEmbedText, 'input.audio.toEmbed')

   
                       
                                                               
                      
                               
   
export type TemplaterContext = {
  title?: string
  now?: Date
}

export function applyTemplaterText(template: string, ctx: TemplaterContext = {}): string {
  const now = ctx.now ?? new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (pattern: string): string => {
    return pattern
      .replace(/YYYY/g, `${now.getFullYear()}`)
      .replace(/YY/g, `${now.getFullYear() % 100}`.padStart(2, '0'))
      .replace(/MM/g, pad(now.getMonth() + 1))
      .replace(/DD/g, pad(now.getDate()))
      .replace(/HH/g, pad(now.getHours()))
      .replace(/mm/g, pad(now.getMinutes()))
      .replace(/ss/g, pad(now.getSeconds()))
  }
  return template
    .replace(/\{\{date(?::([^}]+))?\}\}/g, (_w, p) => fmt(p ?? 'YYYY-MM-DD'))
    .replace(/\{\{time(?::([^}]+))?\}\}/g, (_w, p) => fmt(p ?? 'HH:mm'))
    .replace(/\{\{title\}\}/g, ctx.title ?? '')
}

export function insertTemplate(template: string, ctx: TemplaterContext = {}): Command {
  return (view) => {
    const expanded = applyTemplaterText(template, ctx)
    const cursorIdx = expanded.indexOf('{{cursor}}')
    const sel = view.state.selection.main
    if (cursorIdx === -1) {
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: expanded },
        selection: { anchor: sel.from + expanded.length },
        userEvent: 'input.templater',
      })
    } else {
      const cleaned = expanded.replace('{{cursor}}', '')
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: cleaned },
        selection: { anchor: sel.from + cursorIdx },
        userEvent: 'input.templater',
      })
    }
    return true
  }
}

                                                    
export function swapDollarMathText(source: string, toBlock: boolean): string {
  if (toBlock) {
    return source.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, '$$$$$1$$$$')
  }
  return source.replace(/\$\$([^$\n]+)\$\$/g, '$$$1$$')
}

export const inlineDollarToBlock: Command = (view) =>
  applyToSelectionOrAll(view, (s) => swapDollarMathText(s, true), 'input.math.toBlock')

export const blockDollarToInline: Command = (view) =>
  applyToSelectionOrAll(view, (s) => swapDollarMathText(s, false), 'input.math.toInline')

                                           
export function appendBlockIdAtCursor(view: EditorView): boolean {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  if (/\^[a-z0-9]+\s*$/.test(line.text)) return false
  const id = 'b' + Math.random().toString(36).slice(2, 7)
  const insert = ` ^${id}`
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: line.to + insert.length },
    userEvent: 'input.blockid.append',
  })
  return true
}

                                          
export function incrementBlockIdAtCursor(view: EditorView): boolean {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const m = /\^([a-z0-9-]+?)(?:-(\d+))?\s*$/.exec(line.text)
  if (!m) return false
  const base = m[1]
  const n = (parseInt(m[2] ?? '1', 10) || 1) + 1
  const replaced = line.text.replace(/\^[a-z0-9-]+(?:-\d+)?\s*$/, `^${base}-${n}`)
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replaced },
    userEvent: 'input.blockid.increment',
  })
  return true
}

                       
export function sortLinesByLengthText(source: string, desc = false): string {
  const lines = source.split('\n')
  lines.sort((a, b) => (desc ? b.length - a.length : a.length - b.length))
  return lines.join('\n')
}

export const sortLinesByLengthAsc: Command = (view) =>
  applyToSelectionOrAll(view, (s) => sortLinesByLengthText(s, false), 'input.lines.sortLenAsc')

export const sortLinesByLengthDesc: Command = (view) =>
  applyToSelectionOrAll(view, (s) => sortLinesByLengthText(s, true), 'input.lines.sortLenDesc')

                                           
export function reportDuplicateLinesText(source: string): string {
  const lines = source.split('\n')
  const counts = new Map<string, number[]>()
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    if (!counts.has(t)) counts.set(t, [])
    counts.get(t)!.push(i + 1)
  }
  const dups = Array.from(counts.entries()).filter(([, arr]) => arr.length > 1)
  if (dups.length === 0) return ''
  const items = dups
    .sort((a, b) => b[1].length - a[1].length)
    .map(([t, arr]) => `- "${t.slice(0, 60)}" × ${arr.length} (line ${arr.join(', ')})`)
  return items.join('\n')
}

export const insertDuplicateLinesReport: Command = (view) => {
  const out = reportDuplicateLinesText(view.state.doc.toString())
  if (!out) return false
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: out },
    selection: { anchor: sel.from + out.length },
    userEvent: 'input.lines.dupReport',
  })
  return true
}

                                                                       
export function mdImagesToDocumentEmbedText(source: string): string {
  return source.replace(/!\[([^\]]*)\]\(([^):\s]+)\)/g, (_w, _alt, href) => {
    if (/^https?:\/\//i.test(href)) return _w
    return `![[${href}]]`
  })
}

export const mdImagesToDocumentEmbed: Command = (view) =>
  applyToSelectionOrAll(view, mdImagesToDocumentEmbedText, 'input.images.toEmbed')

                                            
export function documentEmbedToMdImagesText(source: string): string {
  return source.replace(/!\[\[([^\]\n]+?)\]\]/g, (_w, href) => {
    return `![](${href})`
  })
}

export const documentEmbedToMdImages: Command = (view) =>
  applyToSelectionOrAll(view, documentEmbedToMdImagesText, 'input.images.fromEmbed')

                                            
const CALLOUT_ALIAS_MAP: Record<string, string> = {
  i: 'info',
  w: 'warning',
  e: 'error',
  s: 'success',
  q: 'question',
  t: 'tip',
  n: 'note',
}

export function expandCalloutAliasesText(source: string): string {
  return source.replace(/^(>\s*\[!)([A-Za-z])(\][+-]?)/gm, (whole, head, letter, tail) => {
    const expanded = CALLOUT_ALIAS_MAP[letter.toLowerCase()]
    if (!expanded) return whole
    return `${head}${expanded}${tail}`
  })
}

export const expandCalloutAliases: Command = (view) =>
  applyToSelectionOrAll(view, expandCalloutAliasesText, 'input.callout.expandAliases')

                                                                   
export function unwrapSelfLinksText(source: string): string {
  return source.replace(/(?<!\!)\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, href) => {
    if (text !== href) return whole
    return `<${href}>`
  })
}

export const unwrapSelfLinks: Command = (view) =>
  applyToSelectionOrAll(view, unwrapSelfLinksText, 'input.links.unwrapSelf')

// =====================================================================
// Batch #159: outline filter / checkbox cycle / URL shortcut / etc.
// =====================================================================

   
                                                      
                         
   
export function filterOutlineByLevelText(source: string, keepLevel: number): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^(#{1,6})\s+/.exec(line)
    if (m && m[1].length > keepLevel) continue
    out.push(line)
  }
  return out.join('\n')
}

export const filterOutlineByLevel =
  (keepLevel: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => filterOutlineByLevelText(s, keepLevel), 'input.outline.filter')

const CHECKBOX_CYCLE = [' ', 'x', '-', '/', '?']

                                                
export const cycleTaskCheckboxAtCursor: Command = (view) => {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const m = /^(\s*[-*+]\s\[)([^\]])(\]\s)/.exec(line.text)
  if (!m) return false
  const cur = m[2]
  const idx = CHECKBOX_CYCLE.indexOf(cur)
  const next = CHECKBOX_CYCLE[(idx + 1) % CHECKBOX_CYCLE.length]
  const from = line.from + m[1].length
  view.dispatch({
    changes: { from, to: from + 1, insert: next },
    userEvent: 'input.task.cycleCheckbox',
  })
  return true
}

   
                                            
                                                         
   
export function autoLinkBareUrlsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
               
      let masked = line
      const codeRanges: Array<[number, number]> = []
      masked = line.replace(/`[^`]*`/g, (s, off: number) => {
        codeRanges.push([off, off + s.length])
        return ' '.repeat(s.length)
      })
                         
      const skip: Array<[number, number]> = [...codeRanges]
      const md = /\[[^\]]*\]\([^)\s]+\)/g
      let mm: RegExpExecArray | null
      while ((mm = md.exec(masked)) !== null) {
        skip.push([mm.index, mm.index + mm[0].length])
      }
      const auto = /<https?:\/\/[^>]+>/g
      while ((mm = auto.exec(masked)) !== null) {
        skip.push([mm.index, mm.index + mm[0].length])
      }
      const inSkip = (i: number) => skip.some(([a, b]) => i >= a && i < b)
      const re = /\bhttps?:\/\/[^\s)]+/g
      let result = ''
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        if (inSkip(m.index)) continue
        result += line.slice(last, m.index)
        const url = m[0].replace(/[.,;:!?)]+$/, '')
        let host = url
        try {
          host = new URL(url).host.replace(/^www\./, '')
        } catch {
          host = url
        }
        result += `[${host}](${url})`
        const tail = m[0].slice(url.length)
        result += tail
        last = m.index + m[0].length
      }
      result += line.slice(last)
      return result
    })
    .join('\n')
}

export const autoLinkBareUrls: Command = (view) =>
  applyToSelectionOrAll(view, autoLinkBareUrlsText, 'input.links.autoLink')

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
]

                             
export const insertLoremIpsum =
  (wordCount = 12): Command =>
  (view) => {
    const words: string[] = []
    for (let i = 0; i < wordCount; i++) {
      words.push(LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)])
    }
    const text = words.join(' ') + '.'
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.lorem',
    })
    return true
  }

                                             
export function titleCaseFrontmatterKeysText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const yaml = m[1]
  const newYaml = yaml
    .split('\n')
    .map((line) => {
      const km = /^([A-Za-z_][\w-]*)(\s*:.*)$/.exec(line)
      if (!km) return line
      const key = km[1]
      const title = key
        .split(/[-_]/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(' ')
      return title + km[2]
    })
    .join('\n')
  return source.slice(0, m.index) + '---\n' + newYaml + '\n---' + source.slice(m.index + m[0].length)
}

export const titleCaseFrontmatterKeys: Command = (view) =>
  applyToSelectionOrAll(view, titleCaseFrontmatterKeysText, 'input.frontmatter.titleCaseKeys')

                                                 
export const splitParagraphAtCursor: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const col = head - line.from
  if (col === 0 || col === line.text.length) return false
  const left = line.text.slice(0, col).trimEnd()
  const right = line.text.slice(col).trimStart()
  if (!left || !right) return false
  const replacement = left + '\n\n' + right
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replacement },
    selection: { anchor: line.from + left.length + 2 },
    userEvent: 'input.paragraph.split',
  })
  return true
}

                                     
export function trimHeadingPunctuationText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(#{1,6}\s+.*?)([\p{Sentence_Terminal},:;]+)\s*$/u.exec(line)
      if (!m) return line
      return m[1]
    })
    .join('\n')
}

export const trimHeadingPunctuation: Command = (view) =>
  applyToSelectionOrAll(view, trimHeadingPunctuationText, 'input.heading.trimPunct')

   
                                                   
                                  
   
export function splitLongTableText(source: string, chunkRows: number): string {
  if (chunkRows < 1) chunkRows = 25
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const sep = lines[i + 1] ?? ''
    if (
      /^\s*\|.*\|\s*$/.test(header) &&
      /^\s*\|?\s*:?-{3,}/.test(sep)
    ) {
      const rows: string[] = []
      let j = i + 2
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(lines[j])
        j++
      }
      if (rows.length > chunkRows) {
        let cursor = 0
        const chunks: string[] = []
        while (cursor < rows.length) {
          const part = rows.slice(cursor, cursor + chunkRows)
          chunks.push([header, sep, ...part].join('\n'))
          cursor += chunkRows
        }
        out.push(chunks.join('\n\n'))
      } else {
        out.push([header, sep, ...rows].join('\n'))
      }
      i = j
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out.join('\n')
}

export const splitLongTable =
  (chunkRows = 25): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => splitLongTableText(s, chunkRows), 'input.table.split')

   
                                                                       
              
   
export const swapListItems =
  (a: number, b: number): Command =>
  (view) => {
    const { state } = view
    const head = state.selection.main.head
    const lineNo = state.doc.lineAt(head).number
    let startLine = lineNo
    let endLine = lineNo
    while (startLine > 1) {
      const ln = state.doc.line(startLine - 1)
      if (!/^\s*([-*+]|\d+\.)\s/.test(ln.text)) break
      startLine--
    }
    while (endLine < state.doc.lines) {
      const ln = state.doc.line(endLine + 1)
      if (!/^\s*([-*+]|\d+\.)\s/.test(ln.text)) break
      endLine++
    }
    const items: { from: number; to: number; text: string }[] = []
    for (let n = startLine; n <= endLine; n++) {
      const ln = state.doc.line(n)
      items.push({ from: ln.from, to: ln.to, text: ln.text })
    }
    if (a < 1 || b < 1 || a > items.length || b > items.length || a === b) return false
    const ai = a - 1
    const bi = b - 1
    const newItems = items.slice()
    ;[newItems[ai], newItems[bi]] = [newItems[bi], newItems[ai]]
    const block = newItems.map((it) => it.text).join('\n')
    view.dispatch({
      changes: { from: items[0].from, to: items[items.length - 1].to, insert: block },
      userEvent: 'input.list.swap',
    })
    return true
  }

                                         
export const insertStickyNote =
  (type = 'note', title = 'Note'): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const atLineStart = head === line.from
    const prefix = atLineStart ? '' : '\n'
    const snippet = `${prefix}> [!${type}]- ${title}\n> Content…\n`
    view.dispatch({
      changes: { from: head, to: head, insert: snippet },
      selection: { anchor: head + snippet.length },
      userEvent: 'input.callout.sticky',
    })
    return true
  }

   
                           
                                                 
                                                                                 
   
export function embedKnownVideoIframesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(
        /\bhttps?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]{6,})\b\S*/g,
        (_w, id: string) =>
          `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen></iframe>`,
      ).replace(
        /\bhttps?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[\w]+)\b\S*/g,
        (_w, bv: string) =>
          `<iframe width="560" height="315" src="https://player.bilibili.com/player.html?bvid=${bv}" frameborder="0" allowfullscreen></iframe>`,
      ).replace(
        /\bhttps?:\/\/youtu\.be\/([\w-]{6,})\b\S*/g,
        (_w, id: string) =>
          `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen></iframe>`,
      )
    })
    .join('\n')
}

export const embedKnownVideoIframes: Command = (view) =>
  applyToSelectionOrAll(view, embedKnownVideoIframesText, 'input.media.embedVideo')

   
                                                   
   
export const collapseParagraphAsDetails: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const startLn = state.doc.lineAt(head).number
  if (!state.doc.line(startLn).text.trim()) return false
  let s = startLn
  let e = startLn
  while (s > 1 && state.doc.line(s - 1).text.trim()) s--
  while (e < state.doc.lines && state.doc.line(e + 1).text.trim()) e++
  const fromPos = state.doc.line(s).from
  const toPos = state.doc.line(e).to
  const text = state.doc.sliceString(fromPos, toPos)
  const firstLine = text.split('\n')[0]
  const summary = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
  const replaced = `<details>\n<summary>${summary}</summary>\n\n${text}\n\n</details>`
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert: replaced },
    userEvent: 'input.paragraph.collapse',
  })
  return true
}

// =====================================================================
// Batch #160: wikilink nav / list indent / section tag / mixed bullets
// =====================================================================

                                          
export function findWikilinkPositions(source: string): number[] {
  const lines = source.split('\n')
  const positions: number[] = []
  let inFence = false
  let off = 0
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      off += line.length + 1
      continue
    }
    if (!inFence) {
      const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
      const re = /\[\[[^\]\n]+\]\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(masked)) !== null) {
        positions.push(off + m.index)
      }
    }
    off += line.length + 1
  }
  return positions
}

                           
export const jumpToNextWikilink: Command = (view) => {
  const head = view.state.selection.main.head
  const positions = findWikilinkPositions(view.state.doc.toString())
  const next = positions.find((p) => p > head)
  if (next === undefined) return false
  view.dispatch({
    selection: EditorSelection.cursor(next),
    scrollIntoView: true,
    userEvent: 'select.wikilink.next',
  })
  return true
}

                           
export const jumpToPrevWikilink: Command = (view) => {
  const head = view.state.selection.main.head
  const positions = findWikilinkPositions(view.state.doc.toString())
  const prev = [...positions].reverse().find((p) => p < head)
  if (prev === undefined) return false
  view.dispatch({
    selection: EditorSelection.cursor(prev),
    scrollIntoView: true,
    userEvent: 'select.wikilink.prev',
  })
  return true
}

   
                                          
                  
   
export function promoteListIndentText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (/^\s*([-*+]|\d+\.)\s/.test(line)) return '  ' + line
      return line
    })
    .join('\n')
}

export const promoteListIndent: Command = (view) =>
  applyToSelectionOrAll(view, promoteListIndentText, 'input.list.promote')

                                
export function demoteListIndentText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (/^\s*([-*+]|\d+\.)\s/.test(line)) return line.replace(/^ {1,2}/, '')
      return line
    })
    .join('\n')
}

export const demoteListIndent: Command = (view) =>
  applyToSelectionOrAll(view, demoteListIndentText, 'input.list.demote')

                                    
export function unifyBulletMarkersText(source: string, marker: '-' | '*' | '+' = '-'): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(\s*)[-*+](\s)/, `$1${marker}$2`)
    })
    .join('\n')
}

export const unifyBulletMarkers =
  (marker: '-' | '*' | '+' = '-'): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => unifyBulletMarkersText(s, marker), 'input.list.unifyBullet')

                                              
export function buildDocumentMapText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const items: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const indent = '  '.repeat(m[1].length - 1)
    items.push(`${indent}- ${m[2]}`)
  }
  if (!items.length) return source
  const map = `## Document Map\n\n${items.join('\n')}\n`
  return source.replace(/\s*$/, '') + '\n\n' + map
}

export const insertDocumentMap: Command = (view) => {
  const next = buildDocumentMapText(view.state.doc.toString())
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.map.insert',
  })
  return true
}

                                                                                 
export const selectInsideInlineMark: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const col = head - line.from
  const patterns: Array<{ open: string; close: string }> = [
    { open: '**', close: '**' },
    { open: '__', close: '__' },
    { open: '~~', close: '~~' },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
    { open: '`', close: '`' },
  ]
  for (const p of patterns) {
    const left = line.text.lastIndexOf(p.open, col)
    if (left === -1) continue
    const right = line.text.indexOf(p.close, left + p.open.length)
    if (right === -1) continue
    if (col < left + p.open.length || col > right) continue
    view.dispatch({
      selection: EditorSelection.range(line.from + left + p.open.length, line.from + right),
      userEvent: 'select.inlineMark',
    })
    return true
  }
  return false
}

                                 
export const insertCheckboxStatsAtCursor: Command = (view) => {
  const source = view.state.doc.toString()
  const lines = source.split('\n')
  let inFence = false
  let total = 0
  let done = 0
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^\s*[-*+]\s\[([ xX/\-?])\]\s/.exec(line)
    if (!m) continue
    total++
    if (m[1].toLowerCase() === 'x') done++
  }
  if (total === 0) return false
  const text = `${done}/${total} done`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.stats.tasks',
  })
  return true
}

                                                       
export const tagSectionLines =
  (tag: string): Command =>
  (view) => {
    const section = findCurrentSection(view.state)
    if (!section) return false
    const tagText = tag.startsWith('#') ? tag : `#${tag}`
    const fromLn = section.headingLineNo + 1
    const toLn = section.endLineNo
    const changes: { from: number; to: number; insert: string }[] = []
    for (let n = fromLn; n <= toLn; n++) {
      const ln = view.state.doc.line(n)
      if (!ln.text.trim()) continue
      if (ln.text.includes(tagText)) continue
      changes.push({ from: ln.to, to: ln.to, insert: ` ${tagText}` })
    }
    if (!changes.length) return false
    view.dispatch({ changes, userEvent: 'input.section.tagLines' })
    return true
  }

                                  
export function countCharsInRangeText(source: string, from: number, to: number): number {
  return Math.max(0, source.slice(from, to).length)
}

                                                             
export function extractHtmlCommentsAsSectionText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const comments: string[] = []
  const newLines = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.replace(/<!--\s*(.*?)\s*-->/g, (_w, c: string) => {
      comments.push(c)
      return ''
    })
  })
  if (!comments.length) return source
  const block = `\n\n## Annotations\n\n${comments.map((c) => `- ${c}`).join('\n')}\n`
  return newLines.join('\n').replace(/\s+$/g, '') + block
}

export const extractHtmlCommentsAsSection: Command = (view) =>
  applyToSelectionOrAll(view, extractHtmlCommentsAsSectionText, 'input.comments.extract')

// =====================================================================
// Batch #161: reading progress / heading move / callout fold-all / etc
// =====================================================================

                                        
export function renderProgressBarText(percent: number, width = 20): string {
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${p}%`
}

                                   
export const insertSectionTaskProgressBar: Command = (view) => {
  const section = findCurrentSection(view.state)
  if (!section) return false
  let total = 0
  let done = 0
  for (let n = section.headingLineNo + 1; n <= section.endLineNo; n++) {
    const t = view.state.doc.line(n).text
    const m = /^\s*[-*+]\s\[([ xX/\-?])\]\s/.exec(t)
    if (!m) continue
    total++
    if (m[1].toLowerCase() === 'x') done++
  }
  if (total === 0) return false
  const pct = Math.round((done / total) * 100)
  const bar = renderProgressBarText(pct)
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: bar },
    selection: { anchor: head + bar.length },
    userEvent: 'input.section.progressBar',
  })
  return true
}

                                               
export function foldAllCalloutsText(source: string): string {
  return source.replace(/^(> \[![A-Za-z]+\])([-+]?)(.*)$/gm, (_w, head, _fold, rest) => `${head}-${rest}`)
}

export const foldAllCallouts: Command = (view) =>
  applyToSelectionOrAll(view, foldAllCalloutsText, 'input.callout.foldAll')

                                     
export function expandAllCalloutsText(source: string): string {
  return source.replace(/^(> \[![A-Za-z]+\])[-+]/gm, '$1')
}

export const expandAllCallouts: Command = (view) =>
  applyToSelectionOrAll(view, expandAllCalloutsText, 'input.callout.expandAll')

                                                                       
export function ensureTimestampsInFrontmatterText(source: string, nowIso: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) {
    const block = `---\ncreated: ${nowIso}\nmodified: ${nowIso}\n---\n\n`
    return block + source
  }
  let yaml = m[1]
  if (!/^created\s*:/m.test(yaml)) yaml += `\ncreated: ${nowIso}`
  if (/^modified\s*:/m.test(yaml)) yaml = yaml.replace(/^modified\s*:.*$/m, `modified: ${nowIso}`)
  else yaml += `\nmodified: ${nowIso}`
  return source.slice(0, m.index) + '---\n' + yaml + '\n---' + source.slice(m.index + m[0].length)
}

export const ensureTimestampsInFrontmatter: Command = (view) => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const next = ensureTimestampsInFrontmatterText(view.state.doc.toString(), now)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    userEvent: 'input.frontmatter.timestamps',
  })
  return true
}

                                
export const surroundWithStyledMark =
  (color: string): Command =>
  (view) => {
    const r = view.state.selection.main
    if (r.empty) return false
    const open = `<mark style="background:${color}">`
    const close = `</mark>`
    view.dispatch({
      changes: [
        { from: r.from, to: r.from, insert: open },
        { from: r.to, to: r.to, insert: close },
      ],
      selection: { anchor: r.to + open.length + close.length },
      userEvent: 'input.format.mark',
    })
    return true
  }

                             
export const insertHrWith =
  (char: '---' | '***' | '___' = '---'): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const atLineStart = head === line.from
    const text = `${atLineStart ? '' : '\n'}\n${char}\n\n`
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.hr',
    })
    return true
  }

   
                                                 
   
export function cleanupAllWhitespaceText(source: string): string {
  return source
    .replace(/^﻿/, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').replace(/[ \t]+$/g, ''))
    .join('\n')
}

export const cleanupAllWhitespace: Command = (view) =>
  applyToSelectionOrAll(view, cleanupAllWhitespaceText, 'input.cleanup.whitespace')

                                            
export function linksToQrShortcutText(source: string, base = 'https://api.qrserver.com/v1/create-qr-code/?data='): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/(?<!\!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_w, text, url) => {
        return `[${text}](${base}${encodeURIComponent(url)})`
      })
    })
    .join('\n')
}

export const linksToQrShortcut: Command = (view) =>
  applyToSelectionOrAll(view, linksToQrShortcutText, 'input.links.toQr')

                                              
export function extractTasksToSummarySectionText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const tasks: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*[-*+]\s\[[ xX/\-?]\]\s/.test(line)) {
      tasks.push(line.trim())
    }
  }
  if (!tasks.length) return source
  return source.replace(/\s*$/, '') + `\n\n## Task List\n\n${tasks.join('\n')}\n`
}

export const extractTasksToSummarySection: Command = (view) =>
  applyToSelectionOrAll(view, extractTasksToSummarySectionText, 'input.tasks.summary')

   
                                                   
               
   
export const promoteHeadingTree: Command = (view) => {
  const section = findCurrentSection(view.state)
  if (!section) return false
  if (section.headingLevel <= 1) return false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = section.headingLineNo; n <= section.endLineNo; n++) {
    const ln = view.state.doc.line(n)
    const m = /^(#{1,6})(\s+)/.exec(ln.text)
    if (!m) continue
    if (m[1].length <= 1) continue
    const newPrefix = '#'.repeat(m[1].length - 1) + m[2]
    changes.push({ from: ln.from, to: ln.from + m[0].length, insert: newPrefix })
  }
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.heading.promoteTree' })
  return true
}

                                                
export const demoteHeadingTree: Command = (view) => {
  const section = findCurrentSection(view.state)
  if (!section) return false
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = section.headingLineNo; n <= section.endLineNo; n++) {
    const ln = view.state.doc.line(n)
    const m = /^(#{1,6})(\s+)/.exec(ln.text)
    if (!m) continue
    if (m[1].length >= 6) continue
    const newPrefix = '#'.repeat(m[1].length + 1) + m[2]
    changes.push({ from: ln.from, to: ln.from + m[0].length, insert: newPrefix })
  }
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.heading.demoteTree' })
  return true
}

// =====================================================================
// Batch #162: daily/weekly notes / footnote conv / list reorder / etc.
// =====================================================================

function isoWeek(d: Date): { year: number; week: number } {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((+target - +yearStart) / 86400000 + 1) / 7)
  return { year: target.getUTCFullYear(), week }
}

                                                
export const insertTodayDailyWikilink: Command = (view) => {
  const d = new Date()
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const text = `[[${iso}]]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.dailyLink',
  })
  return true
}

                                               
export const insertWeeklyWikilink: Command = (view) => {
  const { year, week } = isoWeek(new Date())
  const text = `[[W-${year}-${String(week).padStart(2, '0')}]]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.weeklyLink',
  })
  return true
}

   
                                                                        
   
export function inlineFootnotesToReferenceText(source: string): string {
  let counter = 0
  const collected: { id: number; text: string }[] = []
  const replaced = source.replace(/\^\[([^\]\n]+)\]/g, (_w, text: string) => {
    counter++
    collected.push({ id: counter, text })
    return `[^${counter}]`
  })
  if (!collected.length) return source
  const block = collected.map((c) => `[^${c.id}]: ${c.text}`).join('\n')
  return replaced.replace(/\s*$/, '') + '\n\n' + block + '\n'
}

export const inlineFootnotesToReference: Command = (view) =>
  applyToSelectionOrAll(view, inlineFootnotesToReferenceText, 'input.footnote.inlineToRef')

   
                                         
                        
   
export const reorderTasksByStatus: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const startLine = state.doc.lineAt(head).number
  let s = startLine
  let e = startLine
  const isTask = (n: number) => /^\s*[-*+]\s\[[ xX/\-?]\]\s/.test(state.doc.line(n).text)
  if (!isTask(s)) return false
  while (s > 1 && isTask(s - 1)) s--
  while (e < state.doc.lines && isTask(e + 1)) e++
  const items: { text: string; done: boolean }[] = []
  for (let n = s; n <= e; n++) {
    const t = state.doc.line(n).text
    const m = /\[([^\]])\]/.exec(t)
    items.push({ text: t, done: !!(m && m[1].toLowerCase() === 'x') })
  }
  const sorted = [...items.filter((x) => !x.done), ...items.filter((x) => x.done)]
  if (sorted.every((x, i) => x.text === items[i].text)) return false
  const fromPos = state.doc.line(s).from
  const toPos = state.doc.line(e).to
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert: sorted.map((x) => x.text).join('\n') },
    userEvent: 'input.tasks.reorder',
  })
  return true
}

                                                 
export function explodeListToParagraphsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  let prevWasItem = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      prevWasItem = false
      continue
    }
    if (inFence) {
      out.push(line)
      prevWasItem = false
      continue
    }
    const m = /^(\s*)(?:[-*+]|\d+\.)\s(.*)$/.exec(line)
    if (m) {
      if (prevWasItem) out.push('')
      out.push(m[2])
      prevWasItem = true
    } else {
      out.push(line)
      prevWasItem = false
    }
  }
  return out.join('\n')
}

export const explodeListToParagraphs: Command = (view) =>
  applyToSelectionOrAll(view, explodeListToParagraphsText, 'input.list.explode')

   
                                                           
   
export function mergeAdjacentDuplicateHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }
    const m1 = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (m1) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      const m2 = j < lines.length ? /^(#{1,6})\s+(.+?)\s*$/.exec(lines[j]) : null
      if (m2 && m1[1] === m2[1] && m1[2] === m2[2]) {
        out.push(line)
        i = j + 1
        continue
      }
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

export const mergeAdjacentDuplicateHeadings: Command = (view) =>
  applyToSelectionOrAll(view, mergeAdjacentDuplicateHeadingsText, 'input.heading.mergeDup')

   
                                                        
   
export function tableColumnToWikilinksText(source: string, colIndex: number): string {
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      out.push(line)
      continue
    }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) {
      out.push(line)
      continue
    }
    const isHeader = i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])
    if (isHeader) {
      out.push(line)
      continue
    }
    const cells = parseTableRow(line)
    if (colIndex < 0 || colIndex >= cells.length) {
      out.push(line)
      continue
    }
    const cell = cells[colIndex].trim()
    if (cell && !/^\[\[.+\]\]$/.test(cell)) {
      cells[colIndex] = ` [[${cell}]] `
    }
    out.push(`| ${cells.map((c) => c.trim()).join(' | ')} |`)
  }
  return out.join('\n')
}

export const tableColumnToWikilinks =
  (colIndex: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => tableColumnToWikilinksText(s, colIndex), 'input.table.colToWikilink')

                        
export const insertQuoteWithAttribution =
  (author = 'Anonymous'): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const atLineStart = head === line.from
    const text = `${atLineStart ? '' : '\n'}> Quote text…\n>\n> — ${author}\n`
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.quoteAttr',
    })
    return true
  }

                                                             
export function wrapHeadingsAsBlockLinksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(#{1,6})\s+(?!\[\[#)(.+?)\s*$/.exec(line)
      if (!m) return line
      return `${m[1]} [[#${m[2]}]]`
    })
    .join('\n')
}

export const wrapHeadingsAsBlockLinks: Command = (view) =>
  applyToSelectionOrAll(view, wrapHeadingsAsBlockLinksText, 'input.heading.wrapWikilink')

// =====================================================================
// Batch #163: numbered↔bullet / selection→footnote / word cloud / etc.
// =====================================================================

                                              
export function bulletsToOrderedText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  let counter = 0
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      counter = 0
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^(\s*)[-*+]\s(.*)$/.exec(line)
    if (m && !m[1]) {
      counter++
      out.push(`${counter}. ${m[2]}`)
    } else {
      if (!m) counter = 0
      out.push(line)
    }
  }
  return out.join('\n')
}

export const bulletsToOrdered: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToOrderedText, 'input.list.bulletsToOrdered')

                                
export function orderedToBulletsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(\s*)\d+\.\s/, '$1- ')
    })
    .join('\n')
}

export const orderedToBullets: Command = (view) =>
  applyToSelectionOrAll(view, orderedToBulletsText, 'input.list.orderedToBullets')

   
                                            
               
   
export const convertSelectionToFootnote: Command = (view) => {
  const r = view.state.selection.main
  if (r.empty) return false
  const selected = view.state.sliceDoc(r.from, r.to).trim()
  if (!selected) return false
  const source = view.state.doc.toString()
  const existing = source.match(/\[\^(\d+)\]:/g) ?? []
  const nextId = existing.length + 1
  const ref = `[^${nextId}]`
  const tailFootnote = `[^${nextId}]: ${selected}`
  const docEnd = view.state.doc.length
  const tailIsClean = source.endsWith('\n')
  const insertTail = (tailIsClean ? '' : '\n') + '\n' + tailFootnote + '\n'
  view.dispatch({
    changes: [
      { from: r.from, to: r.to, insert: ref },
      { from: docEnd, to: docEnd, insert: insertTail },
    ],
    userEvent: 'input.footnote.fromSelection',
  })
  return true
}

                               
export const insertSectionDividerWithTitle =
  (title: string, char: '─' | '━' | '═' = '─'): Command =>
  (view) => {
    const t = title.trim() || 'Section'
    const bar = char.repeat(16)
    const text = `\n${bar} ${t} ${bar}\n\n`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.sectionDivider',
    })
    return true
  }

                                                     
export function suggestFilenameFromH1(source: string): string | null {
  const lines = source.split('\n')
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^#\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    return m[1]
      .toLowerCase()
      .replace(/\p{Script=Han}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-') || null
  }
  return null
}

   
                                
                           
   
export const insertCurrentHeadingPermalink =
  (notePath = ''): Command =>
  (view) => {
    const section = findCurrentSection(view.state)
    if (!section) return false
    const heading = view.state.doc.line(section.headingLineNo).text.replace(/^#+\s+/, '').trim()
    const text = `[[${notePath}#${heading}]]`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.permalink',
    })
    return true
  }

   
                                                    
                     
   
export function buildWordCloudSnapshotText(source: string, topN = 30): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#*_~\[\]()<>]/g, ' ')
    .toLowerCase()
  const tokens = text.match(/[\p{L}\p{N}_]{2,}/gu) ?? []
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  if (!sorted.length) return source
  const cloud = sorted.map(([w, n]) => `\`${w}×${n}\``).join(' ')
  return source.replace(/\s*$/, '') + `\n\n## Word Cloud\n\n${cloud}\n`
}

export const insertWordCloudSnapshot =
  (topN = 30): Command =>
  (view) => {
    const next = buildWordCloudSnapshotText(view.state.doc.toString(), topN)
    if (next === view.state.doc.toString()) return false
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      userEvent: 'input.insert.wordCloud',
    })
    return true
  }

   
                                          
          
   
export function shuffleParagraphsText(source: string, rng: () => number = Math.random): string {
  const blocks = source.split(/\n\n+/)
  const paraIdx: number[] = []
  const paraValues: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i].trim()
    if (!b) continue
    if (/^#{1,6}\s/.test(b)) continue
    if (/^[-*+]\s|^\d+\.\s/.test(b)) continue
    if (/^```/.test(b)) continue
    if (/^>\s/.test(b)) continue
    if (/^\|.*\|/.test(b)) continue
    paraIdx.push(i)
    paraValues.push(blocks[i])
  }
  // Fisher–Yates
  for (let i = paraValues.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[paraValues[i], paraValues[j]] = [paraValues[j], paraValues[i]]
  }
  for (let i = 0; i < paraIdx.length; i++) blocks[paraIdx[i]] = paraValues[i]
  return blocks.join('\n\n')
}

export const shuffleParagraphs: Command = (view) =>
  applyToSelectionOrAll(view, (s) => shuffleParagraphsText(s), 'input.paragraph.shuffle')

                                    
export const insertKbdSpan =
  (keys = 'Ctrl+K'): Command =>
  (view) => {
    const text = `<kbd>${keys}</kbd>`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.kbd',
    })
    return true
  }

                                                            
export function sortFrontmatterArrayValuesText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const yaml = m[1]
  const newYaml = yaml
    .split('\n')
    .map((line) => {
      const km = /^(\s*[\w-]+\s*:\s*)\[([^\]]*)\]\s*$/.exec(line)
      if (!km) return line
      const items = km[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
      return `${km[1]}[${items.join(', ')}]`
    })
    .join('\n')
  return source.slice(0, m.index) + '---\n' + newYaml + '\n---' + source.slice(m.index + m[0].length)
}

export const sortFrontmatterArrayValues: Command = (view) =>
  applyToSelectionOrAll(view, sortFrontmatterArrayValuesText, 'input.frontmatter.sortArrays')

                                    
export const insertMathEquationRef: Command = (view) => {
  const source = view.state.doc.toString()
  const used = [...source.matchAll(/\[eq:(\d+)\]/g)].map((m) => parseInt(m[1], 10))
  const next = used.length ? Math.max(...used) + 1 : 1
  const text = `[eq:${next}]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.eqRef',
  })
  return true
}

// =====================================================================
// Batch #164: section sort by date / roman list / redact / etc.
// =====================================================================

   
                                    
                       
   
export function sortH2SectionsByDateText(source: string): string {
  const lines = source.split('\n')
                                  
  const blocks: { headerLine: number; lines: string[] }[] = []
  let cur: string[] = []
  let curHeader = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      if (curHeader !== -1 || cur.length) blocks.push({ headerLine: curHeader, lines: cur })
      cur = [lines[i]]
      curHeader = i
    } else {
      cur.push(lines[i])
    }
  }
  if (curHeader !== -1 || cur.length) blocks.push({ headerLine: curHeader, lines: cur })
  if (blocks.length < 2) return source
  const intro = blocks[0].headerLine === -1 ? blocks.shift()! : null
  const withDate: { date: string; block: typeof blocks[number] }[] = []
  const noDate: typeof blocks = []
  for (const b of blocks) {
    const h = b.lines[0]
    const m = /(\d{4}-\d{2}-\d{2})/.exec(h)
    if (m) withDate.push({ date: m[1], block: b })
    else noDate.push(b)
  }
  withDate.sort((a, b) => a.date.localeCompare(b.date))
  const ordered = [...withDate.map((x) => x.block), ...noDate]
  const out: string[] = []
  if (intro) out.push(...intro.lines)
  for (const b of ordered) out.push(...b.lines)
  return out.join('\n')
}

export const sortH2SectionsByDate: Command = (view) =>
  applyToSelectionOrAll(view, sortH2SectionsByDateText, 'input.section.sortByDate')

                                                            
export const insertSectionLastReviewedStamp: Command = (view) => {
  const section = findCurrentSection(view.state)
  if (!section) return false
  const d = new Date()
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const stamp = `\n_last reviewed: ${iso}_\n`
  const headLine = view.state.doc.line(section.headingLineNo)
  view.dispatch({
    changes: { from: headLine.to, to: headLine.to, insert: stamp },
    userEvent: 'input.section.reviewedStamp',
  })
  return true
}

const ROMAN_MAP: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
]

function toRoman(n: number): string {
  let s = ''
  let x = n
  for (const [v, r] of ROMAN_MAP) {
    while (x >= v) {
      s += r
      x -= v
    }
  }
  return s
}

                                               
export function orderedToRomanText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  let counter = 0
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        counter = 0
        return line
      }
      if (inFence) return line
      const m = /^(\d+\.)\s(.*)$/.exec(line)
      if (m) {
        counter++
        return `${toRoman(counter).toLowerCase()}. ${m[2]}`
      }
      const indented = /^\s+([-*+]|\d+\.)\s/.test(line)
      if (!indented) counter = 0
      return line
    })
    .join('\n')
}

export const orderedToRoman: Command = (view) =>
  applyToSelectionOrAll(view, orderedToRomanText, 'input.list.toRoman')

                                                          
export function tasksToDefinitionListText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^\s*[-*+]\s\[([ xX/\-?])\]\s(.+?)\s*$/.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const status = m[1].toLowerCase() === 'x' ? 'Completed' : 'Not completed'
    out.push(`${m[2]}\n: Status: ${status}`)
  }
  return out.join('\n')
}

export const tasksToDefinitionList: Command = (view) =>
  applyToSelectionOrAll(view, tasksToDefinitionListText, 'input.tasks.toDefList')

                                                                 
export const insertCollapsibleTOC: Command = (view) => {
  const source = view.state.doc.toString()
  const lines = source.split('\n')
  let inFence = false
  const items: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    items.push(`${'  '.repeat(m[1].length - 1)}- [[#${m[2]}]]`)
  }
  if (!items.length) return false
  const block = `<details>\n<summary>Table of Contents</summary>\n\n${items.join('\n')}\n\n</details>\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: block },
    selection: { anchor: head + block.length },
    userEvent: 'input.insert.collapsibleTOC',
  })
  return true
}

   
                                                       
   
export function redactSensitivePatternsText(source: string): string {
  const mask = (s: string) => {
    if (s.length <= 4) return '█'.repeat(s.length)
    return s.slice(0, 2) + '█'.repeat(s.length - 4) + s.slice(-2)
  }
  return source
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask)
    .replace(/\b\d[\d -]{10,}\d\b/g, (s) => mask(s.replace(/\D/g, '')))
}

export const redactSensitivePatterns: Command = (view) =>
  applyToSelectionOrAll(view, redactSensitivePatternsText, 'input.redact.sensitive')

                                                   
export const insertChecklistFromPromptedLines: Command = (view) => {
  const raw = window.prompt('One item per line (paste here):') ?? ''
  if (!raw) return false
  const items = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!items.length) return false
  const text = items.map((s) => `- [ ] ${s}`).join('\n') + '\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.checklistFromPrompt',
  })
  return true
}

                                         
export const splitCurrentHeading =
  (sep = ' / '): Command =>
  (view) => {
    const { state } = view
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text)
    if (!m) return false
    if (!m[2].includes(sep)) return false
    const parts = m[2].split(sep).map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) return false
    const replaced = parts.map((t) => `${m[1]} ${t}`).join('\n')
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: replaced },
      userEvent: 'input.heading.split',
    })
    return true
  }

   
                                                                   
   
export function mergeDuplicateWikilinksText(source: string): string {
  return source.replace(/\[\[([^\]\n|]+)\|[^\]\n]+\]\]/g, '[[$1]]')
}

export const mergeDuplicateWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, mergeDuplicateWikilinksText, 'input.wikilink.mergeDup')

                                                                  
export const linkPromptForSelection: Command = (view) => {
  const r = view.state.selection.main
  const url = window.prompt('URL:')
  if (!url) return false
  if (r.empty) {
    const text = `[${url}](${url})`
    view.dispatch({
      changes: { from: r.from, to: r.from, insert: text },
      selection: { anchor: r.from + text.length },
      userEvent: 'input.insert.linkPrompt',
    })
    return true
  }
  const sel = view.state.sliceDoc(r.from, r.to)
  const text = `[${sel}](${url})`
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: r.from + text.length },
    userEvent: 'input.insert.linkPrompt',
  })
  return true
}

// =====================================================================
// Batch #165: blockquote↔callout / sentence split / deadline / etc.
// =====================================================================

   
                                                  
                                         
   
export function blockquoteToCalloutText(source: string, type = 'note'): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      out.push(lines[i])
      i++
      continue
    }
    if (inFence) {
      out.push(lines[i])
      i++
      continue
    }
    if (/^>\s?/.test(lines[i])) {
      const block: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        block.push(lines[i])
        i++
      }
                           
      if (/^>\s+\[![A-Za-z]+\]/.test(block[0])) {
        out.push(...block)
        continue
      }
      const first = block[0].replace(/^>\s?(.*)$/, (_w, body: string) =>
        body ? `> [!${type}] ${body}` : `> [!${type}]`,
      )
      out.push(first, ...block.slice(1))
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

export const blockquoteToCallout =
  (type = 'note'): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => blockquoteToCalloutText(s, type), 'input.callout.fromBlockquote')

                                                       
export function calloutToBlockquoteText(source: string): string {
  return source.replace(/^(>\s?)\[![A-Za-z]+\][-+]?\s?(.*)$/gm, (_w, q, body) => `${q}${body}`)
}

export const calloutToBlockquote: Command = (view) =>
  applyToSelectionOrAll(view, calloutToBlockquoteText, 'input.callout.toBlockquote')

   
                                                    
   
export function paragraphsToSentenceBulletsText(source: string): string {
  const blocks = source.split(/\n\n+/)
  return blocks
    .map((b) => {
      const t = b.trim()
      if (!t) return b
      if (/^#{1,6}\s/.test(t)) return b
      if (/^[-*+]\s|^\d+\.\s/.test(t)) return b
      if (/^```/.test(t)) return b
      if (/^>\s/.test(t)) return b
      if (/^\|.*\|/.test(t)) return b
      const sentences = t
        .split(/(?<=\p{Sentence_Terminal})\s+|(?<=\p{Sentence_Terminal})(?=\p{L})/u)
        .map((s) => s.trim())
        .filter(Boolean)
      if (sentences.length < 2) return b
      return sentences.map((s) => `- ${s}`).join('\n')
    })
    .join('\n\n')
}

export const paragraphsToSentenceBullets: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToSentenceBulletsText, 'input.paragraph.toBullets')

const HEADING_EMOJI_POOL = ['📌', '🔖', '✨', '🧭', '🎯', '📚', '🧠', '💡', '🔥', '⚡️', '🌱']

                                   
export function emojifyHeadingsText(source: string, rng: () => number = Math.random): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (!m) return line
      const headFirst = m[2].slice(0, 2)
      if (HEADING_EMOJI_POOL.some((e) => headFirst.includes(e))) return line
      const emoji = HEADING_EMOJI_POOL[Math.floor(rng() * HEADING_EMOJI_POOL.length)]
      return `${m[1]} ${emoji} ${m[2]}`
    })
    .join('\n')
}

export const emojifyHeadings: Command = (view) =>
  applyToSelectionOrAll(view, (s) => emojifyHeadingsText(s), 'input.heading.emojify')

                               
export const toggleLineStrikethrough: Command = (view) => {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const body = line.text
  const m = /^(\s*)(.*)$/.exec(body)
  if (!m) return false
  const lead = m[1]
  const rest = m[2]
  if (!rest) return false
  let replaced: string
  if (rest.startsWith('~~') && rest.endsWith('~~')) {
    replaced = lead + rest.slice(2, -2)
  } else {
    replaced = lead + '~~' + rest + '~~'
  }
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replaced },
    userEvent: 'input.line.strike',
  })
  return true
}

                                                         
export function stripMarkdownToPlainTextV2(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, (s) => s.replace(/^```\w*\n?|```$/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t, alias) => alias || t)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?\[![A-Za-z]+\][-+]?\s?/gm, '')
    .replace(/^>\s?/gm, '')
}

export const stripMarkdownToPlainCommand: Command = (view) =>
  applyToSelectionOrAll(view, stripMarkdownToPlainTextV2, 'input.format.toPlain')

                            
export const insertTaskWithDeadline =
  (offsetDays = 0, title = 'Task'): Command =>
  (view) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const text = `- [ ] ${title} 📅 ${iso}`
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const atLineStart = head === line.from
    const insert = (atLineStart ? '' : '\n') + text + '\n'
    view.dispatch({
      changes: { from: head, to: head, insert },
      selection: { anchor: head + insert.length },
      userEvent: 'input.insert.taskDeadline',
    })
    return true
  }

                                                            
export function annotateUrlsWithTitlePlaceholderText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
                                           
      const skip: Array<[number, number]> = []
      const md = /\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/g
      const auto = /<https?:\/\/[^>]+>/g
      let mm: RegExpExecArray | null
      while ((mm = md.exec(line)) !== null) skip.push([mm.index, mm.index + mm[0].length])
      while ((mm = auto.exec(line)) !== null) skip.push([mm.index, mm.index + mm[0].length])
      const inSkip = (i: number) => skip.some(([a, b]) => i >= a && i < b)
      const re = /\bhttps?:\/\/[^\s)]+/g
      let result = ''
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        if (inSkip(m.index)) continue
        result += line.slice(last, m.index)
        const cleaned = m[0].replace(/[.,;:!?)]+$/, '')
        const tail = m[0].slice(cleaned.length)
        result += `[${cleaned}](${cleaned} "TODO: title")${tail}`
        last = m.index + m[0].length
      }
      result += line.slice(last)
      return result
    })
    .join('\n')
}

export const annotateUrlsWithTitlePlaceholder: Command = (view) =>
  applyToSelectionOrAll(view, annotateUrlsWithTitlePlaceholderText, 'input.links.annotateTitle')

                                              
export function removeOrphanListMarkersText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return true
      }
      if (inFence) return true
      return !/^\s*([-*+]|\d+\.)\s*$/.test(line)
    })
    .join('\n')
}

export const removeOrphanListMarkers: Command = (view) =>
  applyToSelectionOrAll(view, removeOrphanListMarkersText, 'input.list.removeOrphan')

                               
export function sortFrontmatterKeysAlphaText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const yaml = m[1]
  const items: { key: string; block: string }[] = []
  const rawLines = yaml.split('\n')
  let i = 0
  let currentBlock = ''
  let currentKey = ''
  const flush = () => {
    if (currentKey) items.push({ key: currentKey, block: currentBlock })
    currentBlock = ''
    currentKey = ''
  }
  while (i < rawLines.length) {
    const line = rawLines[i]
    const km = /^([A-Za-z_][\w-]*)\s*:/.exec(line)
    if (km) {
      flush()
      currentKey = km[1]
      currentBlock = line
    } else {
      currentBlock += '\n' + line
    }
    i++
  }
  flush()
  items.sort((a, b) => a.key.localeCompare(b.key))
  const newYaml = items.map((x) => x.block).join('\n')
  return source.slice(0, m.index) + '---\n' + newYaml + '\n---' + source.slice(m.index + m[0].length)
}

export const sortFrontmatterKeysAlpha: Command = (view) =>
  applyToSelectionOrAll(view, sortFrontmatterKeysAlphaText, 'input.frontmatter.sortKeys')

// =====================================================================
// Batch #166: list→table / collapse H3 / figure caption / etc.
// =====================================================================

   
                                    
               
   
export const listToSingleColumnTable: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const startLine = state.doc.lineAt(head).number
  const isItem = (n: number) =>
    n >= 1 && n <= state.doc.lines && /^\s*(?:[-*+]|\d+\.)\s/.test(state.doc.line(n).text)
  if (!isItem(startLine)) return false
  let s = startLine
  let e = startLine
  while (s > 1 && isItem(s - 1)) s--
  while (e < state.doc.lines && isItem(e + 1)) e++
  const rows: string[] = []
  for (let n = s; n <= e; n++) {
    const t = state.doc.line(n).text.replace(/^\s*(?:[-*+]|\d+\.)\s/, '').trim()
    rows.push(`| ${t} |`)
  }
  const table = ['| Item |', '| --- |', ...rows].join('\n')
  const fromPos = state.doc.line(s).from
  const toPos = state.doc.line(e).to
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert: table },
    userEvent: 'input.list.toTable',
  })
  return true
}

   
                              
                                                  
   
export function mergeConsecutiveCodeBlocksText(source: string): string {
                                 
  const re = /^```([\w-]*)\s*\n([\s\S]*?)\n```/gm
  const segments: Array<{ kind: 'code' | 'text'; lang?: string; body?: string; raw: string; index: number }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) {
      segments.push({ kind: 'text', raw: source.slice(last, m.index), index: last })
    }
    segments.push({ kind: 'code', lang: m[1], body: m[2], raw: m[0], index: m.index })
    last = m.index + m[0].length
  }
  if (last < source.length) segments.push({ kind: 'text', raw: source.slice(last), index: last })

  const out: typeof segments = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    const prevPrev = out[out.length - 2]
    if (
      seg.kind === 'code' &&
      prev?.kind === 'text' &&
      /^\s*$/.test(prev.raw) &&
      prevPrev?.kind === 'code' &&
      prevPrev.lang === seg.lang
    ) {
      out.pop()
      out.pop()
      const merged: typeof seg = {
        kind: 'code',
        lang: seg.lang,
        body: `${prevPrev.body}\n${seg.body}`,
        raw: `\`\`\`${seg.lang ?? ''}\n${prevPrev.body}\n${seg.body}\n\`\`\``,
        index: prevPrev.index,
      }
      out.push(merged)
      continue
    }
    out.push(seg)
  }
  return out.map((s) => s.raw).join('')
}

export const mergeConsecutiveCodeBlocks: Command = (view) =>
  applyToSelectionOrAll(view, mergeConsecutiveCodeBlocksText, 'input.code.mergeAdjacent')

   
                                                    
                              
   
export function applyWikilinkAliasMapText(
  source: string,
  aliasMap: Record<string, string>,
): string {
  const lines = source.split('\n')
  let inFence = false
  const keys = Object.keys(aliasMap).sort((a, b) => b.length - a.length)
  if (!keys.length) return source
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
                                   
      const skip: Array<[number, number]> = []
      const wikilink = /\[\[[^\]\n]+\]\]/g
      const md = /\[[^\]]*\]\([^)]+\)/g
      const code = /`[^`]*`/g
      let mm: RegExpExecArray | null
      for (const re of [wikilink, md, code]) {
        while ((mm = re.exec(line)) !== null) skip.push([mm.index, mm.index + mm[0].length])
      }
      const inSkip = (i: number) => skip.some(([a, b]) => i >= a && i < b)
      let result = ''
      let pos = 0
      while (pos < line.length) {
        let matched = false
        for (const alias of keys) {
          if (line.startsWith(alias, pos)) {
            if (!inSkip(pos)) {
              result += `[[${aliasMap[alias]}|${alias}]]`
              skip.push([pos, pos + alias.length])
              pos += alias.length
              matched = true
              break
            }
          }
        }
        if (!matched) {
          result += line[pos]
          pos++
        }
      }
      return result
    })
    .join('\n')
}

   
                                                                                                             
   
export function imagesToFigureCaptionText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_w, alt: string, url: string) => {
        const caption = alt.trim() || 'Image'
        return `<figure><img src="${url}" alt="${alt}"/><figcaption>${caption}</figcaption></figure>`
      })
    })
    .join('\n')
}

export const imagesToFigureCaption: Command = (view) =>
  applyToSelectionOrAll(view, imagesToFigureCaptionText, 'input.image.toFigure')

   
                                               
   
export const sortH3InCurrentH2: Command = (view) => {
  const section = findCurrentSection(view.state)
  if (!section || section.headingLevel !== 2) return false
  const { state } = view
            
  const subSections: { headLine: number; lines: string[] }[] = []
  const pre: string[] = []
  let i = section.headingLineNo + 1
  while (i <= section.endLineNo) {
    const text = state.doc.line(i).text
    const m = /^###\s+/.exec(text)
    if (m) {
      const sub: string[] = [text]
      i++
      while (i <= section.endLineNo && !/^##\s+|^###\s+/.test(state.doc.line(i).text)) {
        sub.push(state.doc.line(i).text)
        i++
      }
      subSections.push({ headLine: 0, lines: sub })
    } else {
      pre.push(text)
      i++
    }
  }
  if (subSections.length < 2) return false
  subSections.sort((a, b) => a.lines[0].localeCompare(b.lines[0]))
  const block = [...pre, ...subSections.flatMap((s) => s.lines)].join('\n')
  const fromPos = state.doc.line(section.headingLineNo + 1).from
  const toPos = state.doc.line(section.endLineNo).to
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert: block },
    userEvent: 'input.section.sortH3',
  })
  return true
}

   
                                                       
   
export function expandInlineYamlObjectsText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const yaml = m[1]
  const newYaml = yaml
    .split('\n')
    .map((line) => {
      const km = /^(\s*)([\w-]+)\s*:\s*\{([^}]*)\}\s*$/.exec(line)
      if (!km) return line
      const indent = km[1] ?? ''
      const key = km[2]
      const inner = km[3]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const expanded = inner.map((kv) => {
        const idx = kv.indexOf(':')
        if (idx === -1) return `${indent}  ${kv}:`
        return `${indent}  ${kv.slice(0, idx).trim()}: ${kv.slice(idx + 1).trim()}`
      })
      return [`${indent}${key}:`, ...expanded].join('\n')
    })
    .join('\n')
  return source.slice(0, m.index) + '---\n' + newYaml + '\n---' + source.slice(m.index + m[0].length)
}

export const expandInlineYamlObjects: Command = (view) =>
  applyToSelectionOrAll(view, expandInlineYamlObjectsText, 'input.frontmatter.expandInline')

const EPIGRAPH_POOL = [
  '"To know your limits is to start growing." — Ancient proverb',
  '"Code is documentation; documentation is understanding." — Author',
  '"A book unread is not yet owned." — Montaigne',
  '"Solve one problem at a time." — Brooks',
  '"The most dangerous thing is a plausible assumption." — Feynman',
  '"The future is already here — it\'s just not evenly distributed." — Gibson',
]

                               
export const insertRandomEpigraph: Command = (view) => {
  const pick = EPIGRAPH_POOL[Math.floor(Math.random() * EPIGRAPH_POOL.length)]
  const text = `> ${pick}\n`
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const insert = (head === line.from ? '' : '\n') + text
  view.dispatch({
    changes: { from: head, to: head, insert },
    selection: { anchor: head + insert.length },
    userEvent: 'input.insert.epigraph',
  })
  return true
}

                                                                         
export const stampTaskDone: Command = (view) => {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const m = /^(\s*[-*+]\s\[)([^\]])(\]\s)(.*)$/.exec(line.text)
  if (!m) return false
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const body = m[4].replace(/\s*\(✓ done at [^)]+\)\s*$/, '').trimEnd()
  const replaced = `${m[1]}x${m[3]}${body} (✓ done at ${stamp})`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replaced },
    userEvent: 'input.task.stampDone',
  })
  return true
}

                                                  
export const insertQuoteWithTag =
  (tag: string): Command =>
  (view) => {
    const tagText = tag.startsWith('#') ? tag : `#${tag}`
    const text = `\n> Quote text…\n>\n> ${tagText}\n`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.quoteWithTag',
    })
    return true
  }

                                               
export function wrapH3SectionsAsDetailsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = /^###\s+(.+?)\s*$/.exec(line)
    if (!m) {
      out.push(line)
      i++
      continue
    }
    const title = m[1]
    const body: string[] = []
    i++
    while (
      i < lines.length &&
      !/^#{1,3}\s+/.test(lines[i])
    ) {
      body.push(lines[i])
      i++
    }
    out.push(`<details><summary>${title}</summary>`)
    out.push('')
    out.push(...body)
    out.push('</details>')
  }
  return out.join('\n')
}

export const wrapH3SectionsAsDetails: Command = (view) =>
  applyToSelectionOrAll(view, wrapH3SectionsAsDetailsText, 'input.heading.h3ToDetails')

// =====================================================================
// Batch #167: smart join / JSON-YAML format / admonition / etc.
// =====================================================================

   
                                             
                   
   
export function smartJoinSoftWrapsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }
    if (
      i + 1 < lines.length &&
      line.trim() &&
      !/^[-*+>#]|^\d+\.\s/.test(line.trim()) &&
      lines[i + 1].trim() &&
      !/^[-*+>#]|^\d+\.\s|^\|/.test(lines[i + 1].trim())
    ) {
      let merged = line.replace(/\s+$/, '')
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        !/^[-*+>#]|^\d+\.\s|^\|/.test(lines[i + 1].trim())
      ) {
        merged += ' ' + lines[i + 1].trim()
        i++
      }
      out.push(merged.replace(/\s{2,}/g, ' '))
      i++
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

export const smartJoinSoftWraps: Command = (view) =>
  applyToSelectionOrAll(view, smartJoinSoftWrapsText, 'input.format.smartJoin')

                                                      
export function wikipediaUrlsToWikilinksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(
        /\bhttps?:\/\/([a-z]{2,3})\.wikipedia\.org\/wiki\/([^\s)#]+)/g,
        (_w, lang: string, title: string) => {
          const t = decodeURIComponent(title.replace(/_/g, ' '))
          return `[[${lang}.wp:${t}]]`
        },
      )
    })
    .join('\n')
}

export const wikipediaUrlsToWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, wikipediaUrlsToWikilinksText, 'input.links.wpToWikilink')

                                            
export function formatJsonCodeBlocksText(source: string): string {
  return source.replace(/```json\s*\n([\s\S]*?)\n```/g, (whole, body: string) => {
    try {
      const parsed = JSON.parse(body)
      return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
    } catch {
      return whole
    }
  })
}

export const formatJsonCodeBlocks: Command = (view) =>
  applyToSelectionOrAll(view, formatJsonCodeBlocksText, 'input.code.formatJson')

   
                                            
   
export function formatYamlCodeBlocksText(source: string): string {
  return source.replace(/```ya?ml\s*\n([\s\S]*?)\n```/g, (whole, body: string) => {
    const normalized = body
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\t/g, '  ').replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
    const langTag = whole.startsWith('```yml') ? 'yml' : 'yaml'
    return '```' + langTag + '\n' + normalized + '\n```'
  })
}

export const formatYamlCodeBlocks: Command = (view) =>
  applyToSelectionOrAll(view, formatYamlCodeBlocksText, 'input.code.formatYaml')

                                                                      
export function calloutsToAdmonitionText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }
    const m = /^>\s\[!([A-Za-z]+)\][-+]?\s?(.*)$/.exec(line)
    if (m) {
      const kind = m[1].toLowerCase()
      const title = m[2].trim()
      out.push(`!!! ${kind}${title ? ` "${title}"` : ''}`)
      i++
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        out.push('    ' + lines[i].replace(/^>\s?/, ''))
        i++
      }
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

export const calloutsToAdmonition: Command = (view) =>
  applyToSelectionOrAll(view, calloutsToAdmonitionText, 'input.callout.toAdmonition')

                              
export const insertColorSwatch =
  (hex: string): Command =>
  (view) => {
    const safe = hex.startsWith('#') ? hex : '#' + hex
    const text = `<span style="display:inline-block;width:1em;height:1em;background:${safe};border:1px solid #ccc;vertical-align:middle"></span> \`${safe}\``
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.colorSwatch',
    })
    return true
  }

                   
export function rot13Text(source: string): string {
  return source.replace(/[A-Za-z]/g, (c) => {
    const base = c >= 'a' ? 97 : 65
    return String.fromCharCode(base + ((c.charCodeAt(0) - base + 13) % 26))
  })
}

export const rot13Selection: Command = (view) =>
  applyToSelectionOrAll(view, rot13Text, 'input.format.rot13')

                           
export const insertRfc3339Timestamp: Command = (view) => {
  const text = new Date().toISOString()
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.rfc3339',
  })
  return true
}

   
                                          
                       
   
export function checklistToBarText(source: string, width = 10): string {
  const lines = source.split('\n')
  let total = 0
  let done = 0
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^\s*[-*+]\s\[([ xX/\-?])\]\s/.exec(line)
    if (!m) continue
    total++
    if (m[1].toLowerCase() === 'x') done++
  }
  if (total === 0) return source
  const pct = Math.round((done / total) * 100)
  const filled = Math.round((pct / 100) * width)
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${pct}% (${done}/${total})`
}

                               
export const insertChecklistBarAtCursor: Command = (view) => {
  const bar = checklistToBarText(view.state.doc.toString())
  if (bar === view.state.doc.toString()) return false
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: bar },
    selection: { anchor: head + bar.length },
    userEvent: 'input.insert.checklistBar',
  })
  return true
}

   
                                                         
                               
   
export const breakHeadingBeforeParagraph: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text)
  if (!m) return false
                  
  let next = line.number + 1
  while (next <= state.doc.lines && !state.doc.line(next).text.trim()) next++
  if (next > state.doc.lines) return false
  const para = state.doc.line(next)
  if (/^#{1,6}\s/.test(para.text)) return false
  const continueHeading = `${m[1]} (cont.)`
  view.dispatch({
    changes: { from: para.from, to: para.from, insert: `${continueHeading}\n\n` },
    userEvent: 'input.heading.breakBeforePara',
  })
  return true
}

   
                                          
                          
   
export function wordWrapParagraphsText(source: string, width = 80): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const t = line.trim()
    if (!t || /^[-*+>#]|^\d+\.\s|^\|/.test(t)) {
      out.push(line)
      continue
    }
    const words = line.split(/\s+/).filter(Boolean)
    let buf = ''
    for (const w of words) {
      if (!buf) {
        buf = w
      } else if (buf.length + 1 + w.length <= width) {
        buf += ' ' + w
      } else {
        out.push(buf)
        buf = w
      }
    }
    if (buf) out.push(buf)
  }
  return out.join('\n')
}

export const wordWrapParagraphs =
  (width = 80): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => wordWrapParagraphsText(s, width), 'input.format.wordWrap')

   
                                           
                                                
   
export function toggleSetextHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      i++
      continue
    }
    if (inFence) {
      out.push(line)
      i++
      continue
    }
    const atxH1 = /^# (.+?)\s*$/.exec(line)
    const atxH2 = /^## (.+?)\s*$/.exec(line)
    if (atxH1) {
      out.push(atxH1[1])
      out.push('='.repeat(Math.max(3, atxH1[1].length)))
      i++
      continue
    }
    if (atxH2) {
      out.push(atxH2[1])
      out.push('-'.repeat(Math.max(3, atxH2[1].length)))
      i++
      continue
    }
    // setext → ATX
    if (
      i + 1 < lines.length &&
      line.trim() &&
      /^=+\s*$/.test(lines[i + 1])
    ) {
      out.push('# ' + line.trim())
      i += 2
      continue
    }
    if (
      i + 1 < lines.length &&
      line.trim() &&
      /^-+\s*$/.test(lines[i + 1])
    ) {
      out.push('## ' + line.trim())
      i += 2
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n')
}

export const toggleSetextHeadings: Command = (view) =>
  applyToSelectionOrAll(view, toggleSetextHeadingsText, 'input.heading.toggleSetext')

                                                    
export function orderedListToLetteredText(source: string): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  let idx = 0
  return source.replace(/^(\s*)\d+\.\s/gm, (_w, indent: string) => {
    const ch = idx < letters.length ? letters[idx] : letters[letters.length - 1]
    idx++
    return `${indent}${ch}. `
  })
}

export const orderedListToLettered: Command = (view) =>
  applyToSelectionOrAll(view, orderedListToLetteredText, 'input.list.letter')

                                   
export function stripEmojiFromHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (!/^#{1,6}\s/.test(line)) return line
      return line
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu, '')
        .replace(/  +/g, ' ')
        .replace(/^(#{1,6})\s+/, '$1 ')
    })
    .join('\n')
}

export const stripEmojiFromHeadings: Command = (view) =>
  applyToSelectionOrAll(view, stripEmojiFromHeadingsText, 'input.heading.stripEmoji')

                                  
export const surroundWithBrackets =
  (pair: '()' | '[]' | '{}' | '<>'): Command =>
  (view) => {
    const open = pair[0]
    const close = pair[1]
    return dispatchChanges(view, (range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, to: range.from, insert: open + close },
          range: EditorSelection.cursor(range.from + 1),
        }
      }
      const text = view.state.sliceDoc(range.from, range.to)
      return {
        changes: { from: range.from, to: range.to, insert: open + text + close },
        range: EditorSelection.range(range.from, range.to + 2),
      }
    })
  }

                                       
export const insertEmDashHr: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const text = (line.from === head ? '' : '\n') + '———\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.emdashHr',
  })
  return true
}

                                                   
export const insertBacklinksPlaceholder: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text = `${prefix}## Backlinks\n\n<!-- backlinks:auto -->\n\n`
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.backlinks',
  })
  return true
}

                                                                               
export function ensureCreatedUpdatedTimestampsText(source: string, now = new Date()): string {
  const iso = now.toISOString()
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) {
    return `---\ncreated: ${iso}\nupdated: ${iso}\n---\n\n${source}`
  }
  let body = m[1]
  if (/^created:/m.test(body)) {
    // keep
  } else {
    body = `created: ${iso}\n` + body
  }
  if (/^updated:/m.test(body)) {
    body = body.replace(/^updated:.*$/m, `updated: ${iso}`)
  } else {
    body = body + `\nupdated: ${iso}`
  }
  return source.replace(m[0], `---\n${body}\n---`)
}

export const ensureCreatedUpdatedTimestamps: Command = (view) =>
  applyToSelectionOrAll(view, (s) => ensureCreatedUpdatedTimestampsText(s), 'input.fm.timestamps')

                                           
export function changeOrderedStartText(source: string, start: number): string {
  const lines = source.split('\n')
  const out: string[] = []
  let counter: number | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      counter = null
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^(\s*)(\d+)\.\s(.*)$/.exec(line)
    if (m) {
      if (counter === null) counter = start
      out.push(`${m[1]}${counter}. ${m[3]}`)
      counter++
    } else {
      out.push(line)
      if (!line.trim()) counter = null
    }
  }
  return out.join('\n')
}

export const changeOrderedStart =
  (start: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => changeOrderedStartText(s, start), 'input.list.startAt')

                                                  
export const wrapSelectionAsWikilinkSafe: Command = (view) => {
  const range = view.state.selection.main
  if (range.empty) return false
  const text = view.state.sliceDoc(range.from, range.to)
  if (/[\[\]\(\)]/.test(text)) return false
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[[${text}]]` },
    selection: { anchor: range.from, head: range.to + 4 },
    userEvent: 'input.wrap.wikilinkSafe',
  })
  return true
}

                                                 
export function tableToYamlObjectsText(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l))
  if (start < 0) return source
  const end = (() => {
    let i = start
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++
    return i
  })()
  const block = lines.slice(start, end)
  if (block.length < 3) return source
  const split = (l: string) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const headers = split(block[0])
  const rows = block.slice(2).map(split)
  const yaml: string[] = []
  for (const row of rows) {
    yaml.push('-')
    for (let i = 0; i < headers.length; i++) {
      const k = headers[i] || `col${i + 1}`
      const v = row[i] ?? ''
      yaml.push(`  ${k}: ${v}`)
    }
  }
  const replacement = '```yaml\n' + yaml.join('\n') + '\n```'
  return [...lines.slice(0, start), replacement, ...lines.slice(end)].join('\n')
}

export const tableToYamlObjects: Command = (view) =>
  applyToSelectionOrAll(view, tableToYamlObjectsText, 'input.table.toYaml')

                            
export const insertMermaidSequence: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text =
    prefix +
    '```mermaid\nsequenceDiagram\n  participant A\n  participant B\n  A->>B: hello\n  B-->>A: hi\n```\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidSeq',
  })
  return true
}

                                               
export function stripWikilinkAliasesText(source: string): string {
  return source.replace(/\[\[([^\]|]+)\|[^\]]+\]\]/g, '[[$1]]')
}

export const stripWikilinkAliases: Command = (view) =>
  applyToSelectionOrAll(view, stripWikilinkAliasesText, 'input.wikilink.stripAlias')

                             
export function headingsToNestedListText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (!m) return line
      const depth = m[1].length - 1
      return '  '.repeat(depth) + '- ' + m[2]
    })
    .join('\n')
}

export const headingsToNestedList: Command = (view) =>
  applyToSelectionOrAll(view, headingsToNestedListText, 'input.heading.toNestedList')

                                 
export function normalizeMixedIndentText(source: string): string {
  return source
    .split('\n')
    .map((l) => {
      const m = /^([ \t]+)(.*)$/.exec(l)
      if (!m) return l
      const indent = m[1].replace(/\t/g, '  ')
      return indent + m[2]
    })
    .join('\n')
}

export const normalizeMixedIndent: Command = (view) =>
  applyToSelectionOrAll(view, normalizeMixedIndentText, 'input.format.normalizeIndent')

                                     
export const quoteSelectionLines: Command = (view) => {
  const range = view.state.selection.main
  if (range.empty) return false
  const from = view.state.doc.lineAt(range.from).from
  const to = view.state.doc.lineAt(range.to).to
  const text = view.state.sliceDoc(from, to)
  const next = text
    .split('\n')
    .map((l) => (/^>/.test(l) ? l : `> ${l}`))
    .join('\n')
  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from, head: from + next.length },
    userEvent: 'input.quote.selection',
  })
  return true
}

                                        
export function sortTableByColumnDescText(source: string, col: number): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l))
  if (start < 0) return source
  let end = start
  while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) end++
  if (end - start < 4) return source
  const header = lines[start]
  const sep = lines[start + 1]
  const rows = lines.slice(start + 2, end)
  const parse = (l: string) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const sorted = rows.slice().sort((a, b) => {
    const av = parse(a)[col] ?? ''
    const bv = parse(b)[col] ?? ''
    const an = Number(av)
    const bn = Number(bv)
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return bn - an
    return bv.localeCompare(av)
  })
  return [...lines.slice(0, start), header, sep, ...sorted, ...lines.slice(end)].join('\n')
}

export const sortTableByColumnDesc =
  (col: number): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => sortTableByColumnDescText(s, col),
      'input.table.sortDesc',
    )

                                                
export const insertSectionWikilink: Command = (view) => {
  const file = window.prompt('File name (without .md):')?.trim()
  if (!file) return false
  const section = window.prompt('Section heading:')?.trim()
  if (!section) return false
  const text = `[[${file}#${section}]]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.sectionWikilink',
  })
  return true
}

                                           
export function inferFilenameFromH1Text(source: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(source)
  if (!m) return null
  return m[1]
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

                                               
export function inlineCodeToWikilinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/`([^`]+)`/g, (_w, body: string) => `[[${body}]]`)
    })
    .join('\n')
}

export const inlineCodeToWikilink: Command = (view) =>
  applyToSelectionOrAll(view, inlineCodeToWikilinkText, 'input.format.codeToWikilink')

                             
export function splitParagraphsBySentenceCountText(source: string, n: number): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || !line.trim() || /^[-*+>#]|^\d+\.\s|^\|/.test(line.trim())) {
      out.push(line)
      continue
    }
    const sentences = line.split(/(?<=\p{Sentence_Terminal})\s+/u)
    if (sentences.length <= n) {
      out.push(line)
      continue
    }
    for (let i = 0; i < sentences.length; i += n) {
      out.push(sentences.slice(i, i + n).join(' '))
      if (i + n < sentences.length) out.push('')
    }
  }
  return out.join('\n')
}

export const splitParagraphsBySentenceCount =
  (n: number): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => splitParagraphsBySentenceCountText(s, n),
      'input.format.splitBySentence',
    )

                                       
export function reverseListBlockText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let block: string[] = []
  let inFence = false
  const flush = () => {
    if (block.length) {
      out.push(...block.reverse())
      block = []
    }
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^\s*[-*+]\s/.test(line)) {
      block.push(line)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

export const reverseListBlock: Command = (view) =>
  applyToSelectionOrAll(view, reverseListBlockText, 'input.list.reverse')

                                          
export const wrapSpoiler: Command = (view) => {
  const range = view.state.selection.main
  if (range.empty) return false
  const text = view.state.sliceDoc(range.from, range.to)
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `||${text}||` },
    selection: { anchor: range.from, head: range.to + 4 },
    userEvent: 'input.wrap.spoiler',
  })
  return true
}

                                    
export function flipTableHeaderToFirstColText(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l))
  if (start < 0) return source
  let end = start
  while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) end++
  if (end - start < 3) return source
  const parse = (l: string) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const header = parse(lines[start])
  const rows = lines.slice(start + 2, end).map(parse)
  if (rows.length === 0) return source
  const cols = header.length
  const newRows: string[][] = []
  for (let c = 0; c < cols; c++) {
    const row = [header[c]]
    for (const r of rows) row.push(r[c] ?? '')
    newRows.push(row)
  }
  const widest = Math.max(...newRows[0].map((c) => c.length))
  const newHeader = '| ' + newRows[0].map((c) => c.padEnd(widest)).join(' | ') + ' |'
  const newSep = '| ' + newRows[0].map(() => '-'.repeat(Math.max(3, widest))).join(' | ') + ' |'
  const newBody = newRows
    .slice(1)
    .map((r) => '| ' + r.map((c) => c.padEnd(widest)).join(' | ') + ' |')
  return [
    ...lines.slice(0, start),
    newHeader,
    newSep,
    ...newBody,
    ...lines.slice(end),
  ].join('\n')
}

export const flipTableHeaderToFirstCol: Command = (view) =>
  applyToSelectionOrAll(view, flipTableHeaderToFirstColText, 'input.table.flipHeader')

                                
export function boldNumericInHeadingsText(source: string): string {
  return source.replace(/^(#{1,6}\s+)([\d.]+)/gm, (_w, hash: string, num: string) => `${hash}**${num}**`)
}

export const boldNumericInHeadings: Command = (view) =>
  applyToSelectionOrAll(view, boldNumericInHeadingsText, 'input.heading.boldNumeric')

                                    
export const insertEmptyQuoteBlock =
  (rows: number): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const prefix = line.from === head ? '' : '\n'
    const text = prefix + '> \n'.repeat(rows) + '\n'
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.emptyQuote',
    })
    return true
  }

                                                 
export function fillImageAltFromBasenameText(source: string): string {
  return source.replace(/!\[\]\(([^)\s]+)([^)]*)\)/g, (_w, url: string, rest: string) => {
    const base = url.split('/').pop() ?? ''
    const alt = base.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')
    return `![${alt}](${url}${rest})`
  })
}

export const fillImageAltFromBasename: Command = (view) =>
  applyToSelectionOrAll(view, fillImageAltFromBasenameText, 'input.image.altFromBasename')

                                                        
export const insertKbdShortcut =
  (keys: string[]): Command =>
  (view) => {
    if (!keys.length) return false
    const text = keys.map((k) => `<kbd>${k}</kbd>`).join('+')
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.kbdShortcut',
    })
    return true
  }

                                                 
export function boldNumericToSupText(source: string): string {
  return source.replace(/\*\*(\d+)\*\*/g, (_w, n: string) => `<sup>${n}</sup>`)
}

export const boldNumericToSup: Command = (view) =>
  applyToSelectionOrAll(view, boldNumericToSupText, 'input.format.boldNumericToSup')

                                                      
export const insertFrontmatterField =
  (key: string, value: string): Command =>
  (view) => {
    const src = view.state.doc.toString()
    const m = /^---\n([\s\S]*?)\n---/.exec(src)
    if (m) {
      const body = m[1]
      if (new RegExp(`^${key}:`, 'm').test(body)) return false
      const newBody = body + `\n${key}: ${value}`
      view.dispatch({
        changes: { from: 0, to: m[0].length, insert: `---\n${newBody}\n---` },
        userEvent: 'input.fm.insertField',
      })
      return true
    }
    const insert = `---\n${key}: ${value}\n---\n\n`
    view.dispatch({
      changes: { from: 0, to: 0, insert },
      userEvent: 'input.fm.insertField',
    })
    return true
  }

                                   
export const insertMermaidFlowchart: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text =
    prefix +
    '```mermaid\nflowchart LR\n  A[Start] --> B{Decide}\n  B -->|Yes| C[Do thing]\n  B -->|No| D[Skip]\n```\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidFlow',
  })
  return true
}

                               
export const insertMermaidGantt: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const today = new Date().toISOString().slice(0, 10)
  const text =
    prefix +
    '```mermaid\ngantt\n  title Project Plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n  Task A :a1, ' +
    today +
    ', 3d\n  Task B :after a1, 2d\n```\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidGantt',
  })
  return true
}

                                       
export const insertMermaidClass: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text =
    prefix +
    '```mermaid\nclassDiagram\n  class Foo {\n    +id: string\n    +name: string\n    +bar() void\n  }\n  Foo <|-- Baz\n```\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidClass',
  })
  return true
}

                                              
export function renameHierarchicalTagText(
  source: string,
  from: string,
  to: string,
): string {
  const fromClean = from.replace(/^#/, '')
  const toClean = to.replace(/^#/, '')
  if (!fromClean) return source
  const re = new RegExp(`(?<=^|\\s)#${fromClean.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'g')
  return source.replace(re, '#' + toClean)
}

export const renameHierarchicalTag =
  (from: string, to: string): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => renameHierarchicalTagText(s, from, to),
      'input.tag.renameHierarchical',
    )

                             
export function listToTaskListText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
      if (!m) return line
      return `${m[1]}- [ ] ${m[3]}`
    })
    .join('\n')
}

export const listToTaskList: Command = (view) =>
  applyToSelectionOrAll(view, listToTaskListText, 'input.list.toTaskList')

                                                              
export const insertFrontmatterCallout =
  (kind: string): Command =>
  (view) =>
    insertFrontmatterField('callout', kind)(view)

                                      
export function markAllTasksDoneText(source: string): string {
  return source.replace(/(^|\n)(\s*[-*+]\s)\[ \]/g, '$1$2[x]')
}

export const markAllTasksDone: Command = (view) =>
  applyToSelectionOrAll(view, markAllTasksDoneText, 'input.task.allDone')

                             
export function escapeHtmlInCodeBlocksText(source: string): string {
  return source.replace(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g, (_w, lang: string, body: string) => {
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return '```' + lang + '\n' + escaped + '\n```'
  })
}

export const escapeHtmlInCodeBlocks: Command = (view) =>
  applyToSelectionOrAll(view, escapeHtmlInCodeBlocksText, 'input.code.escapeHtml')

                      
export function ensureBlankBeforeHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence && /^#{1,6}\s/.test(line)) {
      if (out.length && out[out.length - 1].trim() !== '') {
        out.push('')
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

export const ensureBlankBeforeHeadings: Command = (view) =>
  applyToSelectionOrAll(view, ensureBlankBeforeHeadingsText, 'input.heading.blankBefore')

                    
export function collapseBlankLinesText(source: string): string {
  return source.replace(/\n{3,}/g, '\n\n')
}

export const collapseBlankLines: Command = (view) =>
  applyToSelectionOrAll(view, collapseBlankLinesText, 'input.format.collapseBlanks')

                                   
export const insertMermaidPie: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text =
    prefix +
    '```mermaid\npie title Distribution\n  "A" : 40\n  "B" : 30\n  "C" : 30\n```\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidPie',
  })
  return true
}

                                                        
export function linkifyIssueRefsText(source: string, baseUrl: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/(?<![&\w])#(\d{1,6})\b/g, (_w, n: string) => `[#${n}](${baseUrl}${n})`)
    })
    .join('\n')
}

export const linkifyIssueRefs =
  (baseUrl: string): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => linkifyIssueRefsText(s, baseUrl),
      'input.links.issueRefs',
    )

                        
export const insertKbdCheatsheet: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text =
    prefix +
    '| Action | Shortcut |\n| --- | --- |\n| Bold | <kbd>Cmd</kbd>+<kbd>B</kbd> |\n| Italic | <kbd>Cmd</kbd>+<kbd>I</kbd> |\n| Save | <kbd>Cmd</kbd>+<kbd>S</kbd> |\n| Command Palette | <kbd>Cmd</kbd>+<kbd>K</kbd> |\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.kbdCheatsheet',
  })
  return true
}

                                
export function boldToItalicText(source: string): string {
  return source.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
}

export const boldToItalic: Command = (view) =>
  applyToSelectionOrAll(view, boldToItalicText, 'input.format.boldToItalic')

                                          
export function italicToBoldText(source: string): string {
  return source.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1**$2**')
}

export const italicToBold: Command = (view) =>
  applyToSelectionOrAll(view, italicToBoldText, 'input.format.italicToBold')

                               
export function sortParagraphsByLengthText(source: string): string {
  const paragraphs = source.split(/\n{2,}/)
  paragraphs.sort((a, b) => a.length - b.length)
  return paragraphs.join('\n\n')
}

export const sortParagraphsByLength: Command = (view) =>
  applyToSelectionOrAll(view, sortParagraphsByLengthText, 'input.format.sortParaLen')

                                   
export function reverseTableRowsText(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l))
  if (start < 0) return source
  let end = start
  while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) end++
  if (end - start < 3) return source
  const header = lines[start]
  const sep = lines[start + 1]
  const rows = lines.slice(start + 2, end).reverse()
  return [...lines.slice(0, start), header, sep, ...rows, ...lines.slice(end)].join('\n')
}

export const reverseTableRows: Command = (view) =>
  applyToSelectionOrAll(view, reverseTableRowsText, 'input.table.reverseRows')

                          
export function tabsToSpacesInCodeText(source: string, width = 2): string {
  return source.replace(/```([a-zA-Z]*)\n([\s\S]*?)\n```/g, (_w, lang: string, body: string) => {
    return '```' + lang + '\n' + body.replace(/\t/g, ' '.repeat(width)) + '\n```'
  })
}

export const tabsToSpacesInCode =
  (width = 2): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => tabsToSpacesInCodeText(s, width),
      'input.code.tabsToSpaces',
    )

                                                        
export const insertCurrentH1Wikilink: Command = (view) => {
  const src = view.state.doc.toString()
  const m = /^#\s+(.+?)\s*$/m.exec(src)
  if (!m) return false
  const text = `[[#${m[1]}]]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.h1Wikilink',
  })
  return true
}

                          
export function removeEmptyHeadingsText(source: string): string {
  return source
    .split('\n')
    .filter((l) => !/^#{1,6}\s*$/.test(l))
    .join('\n')
}

export const removeEmptyHeadings: Command = (view) =>
  applyToSelectionOrAll(view, removeEmptyHeadingsText, 'input.heading.removeEmpty')

                                      
export function imagesToCaptionedBlockText(source: string): string {
  return source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_w, alt: string, url: string) => {
    return `![${alt}](${url})\n<small><em>${alt || 'Image'}</em></small>`
  })
}

export const imagesToCaptionedBlock: Command = (view) =>
  applyToSelectionOrAll(view, imagesToCaptionedBlockText, 'input.image.captionedBlock')

                                      
export const insertDailyNoteRangeTable =
  (days = 7): Command =>
  (view) => {
    const lines: string[] = ['| Date | Link |', '| --- | --- |']
    const today = new Date()
    for (let i = 0; i < days; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const iso = d.toISOString().slice(0, 10)
      lines.push(`| ${iso} | [[${iso}]] |`)
    }
    const text = lines.join('\n') + '\n'
    const head = view.state.selection.main.head
    const prefix = view.state.doc.lineAt(head).from === head ? '' : '\n'
    view.dispatch({
      changes: { from: head, to: head, insert: prefix + text },
      selection: { anchor: head + prefix.length + text.length },
      userEvent: 'input.insert.dailyRange',
    })
    return true
  }

                                                   
export function expandWikilinkToAliasText(source: string): string {
  return source.replace(/\[\[([^\]|\n]+)\]\]/g, (_w, name: string) => `[[${name}|${name}]]`)
}

export const expandWikilinkToAlias: Command = (view) =>
  applyToSelectionOrAll(view, expandWikilinkToAliasText, 'input.wikilink.expandAlias')

                                
export function dedupTaskLinesText(source: string): string {
  const seen = new Set<string>()
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^\s*[-*+]\s\[[ xX/\-?]\]\s/.test(line)) {
      const key = line.trim()
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(line)
  }
  return out.join('\n')
}

export const dedupTaskLines: Command = (view) =>
  applyToSelectionOrAll(view, dedupTaskLinesText, 'input.task.dedup')

                                                   
export const insertHintCallout: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n'
  const text = prefix + '> [!hint]\n> Hint content\n\n'
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.hintCallout',
  })
  return true
}

                                                        
export function mp4LinkToVideoEmbedText(source: string): string {
  return source.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+\.mp4(?:\?[^)\s]*)?)\)/g,
    (_w, _label: string, url: string) =>
      `<video controls src="${url}" style="max-width:100%"></video>`,
  )
}

export const mp4LinkToVideoEmbed: Command = (view) =>
  applyToSelectionOrAll(view, mp4LinkToVideoEmbedText, 'input.media.mp4ToVideo')

                              
export function reindentSpaceWidthText(source: string, from: 2 | 4, to: 2 | 4): string {
  if (from === to) return source
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const m = /^( +)(.*)$/.exec(line)
      if (!m) return line
      const indent = m[1]
      const units = Math.floor(indent.length / from)
      const rest = indent.length - units * from
      return ' '.repeat(units * to + rest) + m[2]
    })
    .join('\n')
}

export const reindentSpaceWidth =
  (from: 2 | 4, to: 2 | 4): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => reindentSpaceWidthText(s, from, to),
      'input.format.reindent',
    )

                                          
export function capitalizeSentencesAsciiText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/(^|[.!?]\s+)([a-z])/g, (_w, pre: string, c: string) => pre + c.toUpperCase())
    })
    .join('\n')
}

export const capitalizeSentencesAscii: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeSentencesAsciiText, 'input.format.capSentencesAscii')

                                           
export function unicodeArrowsText(source: string): string {
  return source
    .replace(/(^|[^-])-->(?!>)/g, '$1→')
    .replace(/(^|[^-])->(?!>)/g, '$1→')
    .replace(/(^|[^<])<-(?!-)/g, '$1←')
    .replace(/(^|[^<])<--(?!-)/g, '$1←')
    .replace(/(^|[^=])=>(?!>)/g, '$1⇒')
    .replace(/(^|[^=])<=(?!=)/g, '$1⇐')
}

export const unicodeArrows: Command = (view) =>
  applyToSelectionOrAll(view, unicodeArrowsText, 'input.format.unicodeArrows')

                                              
export function inlineFootnotesV2Text(source: string): string {
  const lines = source.split('\n')
  const defs: Record<string, string> = {}
  const body: string[] = []
  for (const line of lines) {
    const m = /^\[\^([^\]]+)\]:\s*(.+)$/.exec(line)
    if (m) {
      defs[m[1]] = m[2]
    } else {
      body.push(line)
    }
  }
  let out = body.join('\n')
  for (const [id, text] of Object.entries(defs)) {
    const re = new RegExp(`\\[\\^${id}\\]`, 'g')
    out = out.replace(re, ` (${text})`)
  }
  return out
}

export const inlineFootnotesV2: Command = (view) =>
  applyToSelectionOrAll(view, inlineFootnotesV2Text, 'input.footnote.inlineV2')

                                          
export const hideHeadingAsHtmlComment: Command = (view) => {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text)
  if (!m) return false
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: `<!-- ${m[1]} ${m[2]} -->` },
    userEvent: 'input.heading.hideAsComment',
  })
  return true
}

                                  
export const insertYouTubeEmbed =
  (videoId: string): Command =>
  (view) => {
    const id = videoId.trim().replace(/^.*v=/, '').replace(/[?&].*$/, '')
    if (!id) return false
    const text = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen></iframe>`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.youtubeEmbed',
    })
    return true
  }

                              
export function orderedListToAsciiTreeText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  type Item = { indent: number; text: string; idx: number }
  const buf: Item[] = []
  let inFence = false
  const flushBuf = () => {
    if (!buf.length) return
                                    
    const lastAtLevel = new Map<number, number>()
    for (let i = 0; i < buf.length; i++) {
      const item = buf[i]
      lastAtLevel.set(item.indent, i)
    }
    for (let i = 0; i < buf.length; i++) {
      const item = buf[i]
      const isLast = lastAtLevel.get(item.indent) === i
      const branch = isLast ? '└── ' : '├── '
      out.push(' '.repeat(item.indent * 4) + branch + item.text)
    }
    buf.length = 0
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushBuf()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^(\s*)(\d+)\.\s+(.+)$/.exec(line)
    if (m) {
      const indent = Math.floor(m[1].length / 2)
      buf.push({ indent, text: m[3], idx: parseInt(m[2], 10) })
      continue
    }
    flushBuf()
    out.push(line)
  }
  flushBuf()
  return out.join('\n')
}

export const orderedListToAsciiTree: Command = (view) =>
  applyToSelectionOrAll(view, orderedListToAsciiTreeText, 'input.list.toAsciiTree')

                                             
export function doubleNewlineToBrText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let lastWasBlank = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      lastWasBlank = false
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line === '') {
      if (lastWasBlank) {
                
        out.push('')
      } else {
        out.push('<br>')
        lastWasBlank = true
      }
      continue
    }
    lastWasBlank = false
    out.push(line)
  }
  return out.join('\n')
}

export const doubleNewlineToBr: Command = (view) =>
  applyToSelectionOrAll(view, doubleNewlineToBrText, 'input.format.nlToBr')

                                                                        
export function sortFrontmatterArrayFieldText(source: string, field: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  let body = m[1]
  // inline array
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, 'm')
  body = body.replace(inlineRe, (_w, items: string) => {
    const sorted = items.split(',').map((s) => s.trim()).filter(Boolean).sort()
    return `${field}: [${sorted.join(', ')}]`
  })
  // block list
  const blockRe = new RegExp(`^${field}:\\n((?:\\s+-\\s+.+\\n?)+)`, 'm')
  body = body.replace(blockRe, (_w, items: string) => {
    const list = items.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    list.sort((a, b) => a.replace(/^-\s+/, '').localeCompare(b.replace(/^-\s+/, '')))
    return `${field}:\n${list.map((l) => '  ' + l).join('\n')}\n`
  })
  return source.replace(m[0], `---\n${body}\n---`)
}

export const sortFrontmatterArrayField =
  (field: string): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => sortFrontmatterArrayFieldText(s, field),
      'input.fm.sortArray',
    )

                                                 
export function autoTagByFilenameText(source: string, filename: string): string {
  const m = /^([a-z]+)-/i.exec(filename)
  if (!m) return source
  const tag = m[1]
  const fm = /^---\n([\s\S]*?)\n---/.exec(source)
  if (fm) {
    const body = fm[1]
    if (new RegExp(`\\b${tag}\\b`).test(body)) return source
    const newBody = /^tags:/m.test(body)
      ? body.replace(/^tags:\s*\[(.*)\]/m, (_w, items: string) => {
          const t = items.trim()
          return `tags: [${t ? t + ', ' : ''}${tag}]`
        })
      : body + `\ntags: [${tag}]`
    return source.replace(fm[0], `---\n${newBody}\n---`)
  }
  return `---\ntags: [${tag}]\n---\n\n${source}`
}

                                 
export const insertNumberedChecklist =
  (from: number, to: number): Command =>
  (view) => {
    if (to < from) return false
    const items: string[] = []
    for (let i = from; i <= to; i++) items.push(`- [ ] Task ${i}`)
    const text = items.join('\n') + '\n'
    const head = view.state.selection.main.head
    const prefix = view.state.doc.lineAt(head).from === head ? '' : '\n'
    view.dispatch({
      changes: { from: head, to: head, insert: prefix + text },
      selection: { anchor: head + prefix.length + text.length },
      userEvent: 'input.insert.numberedChecklist',
    })
    return true
  }

                                          
export function unwrapSoftLinesText(source: string): string {
  return smartJoinSoftWrapsText(source)
}

export const unwrapSoftLines: Command = (view) =>
  applyToSelectionOrAll(view, unwrapSoftLinesText, 'input.format.unwrap')

                                          
export function splitTableByRowCountText(source: string, rowsPerSplit: number): string {
  if (rowsPerSplit < 1) return source
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l))
  if (start < 0) return source
  let end = start
  while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) end++
  const header = lines[start]
  const sep = lines[start + 1]
  const rows = lines.slice(start + 2, end)
  if (rows.length <= rowsPerSplit) return source
  const out: string[] = [...lines.slice(0, start)]
  for (let i = 0; i < rows.length; i += rowsPerSplit) {
    out.push(header, sep, ...rows.slice(i, i + rowsPerSplit))
    if (i + rowsPerSplit < rows.length) out.push('')
  }
  out.push(...lines.slice(end))
  return out.join('\n')
}

export const splitTableByRowCount =
  (rowsPerSplit: number): Command =>
  (view) =>
    applyToSelectionOrAll(
      view,
      (s) => splitTableByRowCountText(s, rowsPerSplit),
      'input.table.splitRows',
    )

                                          
export const insertTasksByTagDataview =
  (tag: string): Command =>
  (view) => {
    const t = tag.replace(/^#/, '')
    const text =
      '```dataview\nTASK\nWHERE contains(tags, "' + t + '") AND !completed\n```\n'
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const prefix = line.from === head ? '' : '\n\n'
    view.dispatch({
      changes: { from: head, to: head, insert: prefix + text },
      selection: { anchor: head + prefix.length + text.length },
      userEvent: 'input.insert.tasksDataview',
    })
    return true
  }

                                    
export const insertLastEditedLine: Command = (view) => {
  const iso = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  const text = prefix + `*Last edited: ${iso}*\n`
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.lastEdited',
  })
  return true
}

                                                                         
export function relativeMdLinksToWikilinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const re = /\[([^\]]+)\]\(((?!https?:\/\/)(?!\/\/)[^)\s]+)\.md\)/g
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(re, (_w, label: string, path: string) => `[[${path}|${label}]]`)
  }
  return lines.join('\n')
}

export const relativeMdLinksToWikilink: Command = (view) =>
  applyToSelectionOrAll(view, relativeMdLinksToWikilinkText, 'input.links.relMdToWikilink')

                          
export const insertBibtexEntry =
  (type = 'article'): Command =>
  (view) => {
    const text =
      '```bibtex\n@' +
      type +
      '{key,\n  author = {Author One and Author Two},\n  title = {Title},\n  journal = {Journal Name},\n  year = {2026},\n}\n```\n'
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    const prefix = line.from === head ? '' : '\n\n'
    view.dispatch({
      changes: { from: head, to: head, insert: prefix + text },
      selection: { anchor: head + prefix.length + text.length },
      userEvent: 'input.insert.bibtex',
    })
    return true
  }

                                       
export function sortH2SectionsAlphaText(source: string): string {
  const lines = source.split('\n')
             
  const firstH2 = lines.findIndex((l) => /^##\s/.test(l))
  if (firstH2 < 0) return source
  const before = lines.slice(0, firstH2)
                 
  const sections: { title: string; body: string[] }[] = []
  let cur: { title: string; body: string[] } | null = null
  for (let i = firstH2; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) {
      if (cur) sections.push(cur)
      cur = { title: line, body: [] }
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) sections.push(cur)
  sections.sort((a, b) => a.title.localeCompare(b.title))
  const flat: string[] = []
  for (const s of sections) {
    flat.push(s.title, ...s.body)
  }
  return [...before, ...flat].join('\n')
}

export const sortH2SectionsAlpha: Command = (view) =>
  applyToSelectionOrAll(view, sortH2SectionsAlphaText, 'input.heading.sortH2Alpha')

                               
export function setextToAtxText(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  const fmEnd = fm ? fm[0].length : 0
  const head = source.slice(0, fmEnd)
  const body = source.slice(fmEnd)
  const lines = body.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const next = lines[i + 1] ?? ''
    if (line.trim() && /^=+\s*$/.test(next)) {
      out.push('# ' + line.trim())
      i++
    } else if (line.trim() && /^-+\s*$/.test(next) && !/^[-*+>]/.test(line.trimStart())) {
      out.push('## ' + line.trim())
      i++
    } else {
      out.push(line)
    }
  }
  return head + out.join('\n')
}

export const setextToAtx: Command = (view) =>
  applyToSelectionOrAll(view, setextToAtxText, 'input.heading.setextToAtx')

                                   
export const insertTagCloudSnapshot: Command = (view) => {
  const src = view.state.doc.toString()
  const counts: Map<string, number> = new Map()
  let inFence = false
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const re = /(?:^|\s)#([\p{L}\d/_-]+)/gu
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return false
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const text =
    '## Tag cloud\n' +
    sorted.map(([t, n]) => `- #${t} (${n})`).join('\n') +
    '\n\n'
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  view.dispatch({
    changes: { from: head, to: head, insert: prefix + text },
    selection: { anchor: head + prefix.length + text.length },
    userEvent: 'input.insert.tagCloud',
  })
  return true
}

                                     
export function dedupBulletListText(source: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^\s*[-*+]\s/.test(line)) {
      const key = line.replace(/\s+/g, ' ').trim()
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(line)
  }
  return out.join('\n')
}

export const dedupBulletList: Command = (view) =>
  applyToSelectionOrAll(view, dedupBulletListText, 'input.list.dedup')

                                    
export function renumberOrderedListsFromOneText(source: string): string {
  return changeOrderedStartText(source, 1)
}

export const renumberOrderedListsFromOne: Command = (view) =>
  applyToSelectionOrAll(view, renumberOrderedListsFromOneText, 'input.list.renumberFromOne')

                              
export const insertAuthorDateHeader =
  (author: string): Command =>
  (view) => {
    const date = new Date().toISOString().slice(0, 10)
    const text = `> _Author: ${author} · Date: ${date}_\n\n`
    view.dispatch({
      changes: { from: 0, to: 0, insert: text },
      userEvent: 'input.insert.authorDate',
    })
    return true
  }

                                              
export const togglePrivateComment: Command = (view) => {
  const range = view.state.selection.main
  if (range.empty) return false
  const text = view.state.sliceDoc(range.from, range.to)
  const isCommented = /^%%[\s\S]*%%$/.test(text)
  const next = isCommented
    ? text.slice(2, -2).trim()
    : `%% ${text} %%`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    selection: { anchor: range.from, head: range.from + next.length },
    userEvent: 'input.format.toggleObsComment',
  })
  return true
}

                                    
export function rewrapBlockquotesText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  let inFence = false
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      out.push(lines[i])
      i++
      continue
    }
    if (!inFence && /^>\s?/.test(lines[i])) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, '').trim())
        i++
      }
      const merged = buf.filter(Boolean).join(' ')
      out.push('> ' + merged)
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

export const rewrapBlockquotes: Command = (view) =>
  applyToSelectionOrAll(view, rewrapBlockquotesText, 'input.format.rewrapQuote')

                                         
export function promoteAllHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,5}) (.*)$/.exec(lines[i])
    if (m) lines[i] = m[1] + '# ' + m[2]
  }
  return lines.join('\n')
}

export const promoteAllHeadings: Command = (view) =>
  applyToSelectionOrAll(view, promoteAllHeadingsText, 'input.heading.promoteAll')

                                     
export function demoteAllHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(##+) (.*)$/.exec(lines[i])
    if (m) lines[i] = m[1].slice(1) + ' ' + m[2]
  }
  return lines.join('\n')
}

export const demoteAllHeadings: Command = (view) =>
  applyToSelectionOrAll(view, demoteAllHeadingsText, 'input.heading.demoteAll')

                                       
export const insertIsoWeekHeading: Command = (view) => {
  const now = new Date()
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  const day = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((+target - +yearStart) / 86400000 + 1) / 7)
  const heading = `## ${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const prefix = line.from === head ? '' : '\n\n'
  view.dispatch({
    changes: { from: head, to: head, insert: prefix + heading + '\n\n' },
    selection: { anchor: head + prefix.length + heading.length + 2 },
    userEvent: 'input.insert.isoWeek',
  })
  return true
}

                                     
export function orderedListToChecklistText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)\d+\.\s+(.*)$/.exec(lines[i])
    if (m) lines[i] = `${m[1]}- [ ] ${m[2]}`
  }
  return lines.join('\n')
}

export const orderedListToChecklist: Command = (view) =>
  applyToSelectionOrAll(view, orderedListToChecklistText, 'input.list.orderedToChecklist')

                                      
export function checklistToOrderedText(source: string): string {
  const lines = source.split('\n')
  const counters: Map<string, number> = new Map()
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)-\s+\[[ xX]\]\s+(.*)$/.exec(lines[i])
    if (m) {
      const indent = m[1]
      const next = (counters.get(indent) ?? 0) + 1
      counters.set(indent, next)
      lines[i] = `${indent}${next}. ${m[2]}`
    } else if (!lines[i].trim()) {
      counters.clear()
    }
  }
  return lines.join('\n')
}

export const checklistToOrdered: Command = (view) =>
  applyToSelectionOrAll(view, checklistToOrderedText, 'input.list.checklistToOrdered')

                                      
export const insertWikiRedirect =
  (target: string): Command =>
  (view) => {
    const text = `#REDIRECT [[${target}]]\n\n`
    view.dispatch({
      changes: { from: 0, to: 0, insert: text },
      userEvent: 'input.insert.redirect',
    })
    return true
  }

                                        
export function collapseDuplicateHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let lastHeading = ''
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      out.push(lines[i])
      continue
    }
    if (inFence) {
      out.push(lines[i])
      continue
    }
    if (/^#{1,6}\s/.test(lines[i])) {
      if (lines[i].trim() === lastHeading) continue
      lastHeading = lines[i].trim()
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

export const collapseDuplicateHeadings: Command = (view) =>
  applyToSelectionOrAll(view, collapseDuplicateHeadingsText, 'input.heading.collapseDup')

                                                                     
export function wikilinkToFullMdLinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t: string, a?: string) => {
      const target = t.trim()
      const label = (a ?? t).trim()
      return `[${label}](${target}.md)`
    })
  }
  return lines.join('\n')
}

export const wikilinkToFullMdLink: Command = (view) =>
  applyToSelectionOrAll(view, wikilinkToFullMdLinkText, 'input.links.wikiToFullMd')

                                      
export function padFencedCodeBlocksText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isFence = /^\s*```/.test(line)
    if (isFence) {
      const opening = !inFence
      const prevBlank = out.length === 0 || out[out.length - 1].trim() === ''
      if (opening && !prevBlank) out.push('')
      out.push(line)
      const next = lines[i + 1] ?? ''
      if (!opening && next.trim() !== '' && i + 1 < lines.length) out.push('')
      inFence = !inFence
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

export const padFencedCodeBlocks: Command = (view) =>
  applyToSelectionOrAll(view, padFencedCodeBlocksText, 'format.code.pad')

                                 
export const insertCustomHr =
  (ch: string = '=', width: number = 60): Command =>
  (view) => {
    const safe = (ch || '=').slice(0, 1)
    const text = '\n' + safe.repeat(Math.max(3, width)) + '\n\n'
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.customHr',
    })
    return true
  }

                                  
export const insertImageGalleryGrid =
  (cols: number = 3): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const colCount = Math.max(1, Math.min(6, cols))
    const cells = Array.from({ length: colCount * colCount })
      .map(() => '    <img src="" alt="" />')
      .join('\n')
    const text =
      `\n<div style="display:grid;grid-template-columns:repeat(${colCount},1fr);gap:8px;">\n${cells}\n</div>\n\n`
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.imageGrid',
    })
    return true
  }

                                
export function mergeAdjacentTablesText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const start = i
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++
    const t1End = i
    let j = i
    while (j < lines.length && lines[j].trim() === '') j++
    if (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      const t2Start = j
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++
      const t1ColCount = (lines[start].match(/\|/g) ?? []).length
      const t2ColCount = (lines[t2Start].match(/\|/g) ?? []).length
      if (t1ColCount === t2ColCount) {
        for (let k = start; k < t1End; k++) out.push(lines[k])
        for (let k = t2Start + 2; k < j; k++) out.push(lines[k])
        i = j
        continue
      }
    }
    for (let k = start; k < t1End; k++) out.push(lines[k])
  }
  return out.join('\n')
}

export const mergeAdjacentTables: Command = (view) =>
  applyToSelectionOrAll(view, mergeAdjacentTablesText, 'input.table.merge')

                                                                            
export function sortFmKeysAlphaV2Text(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const block = m[1]
  const entries: { key: string; value: string }[] = []
  let cur: { key: string; value: string } | null = null
  for (const line of block.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (kv) {
      if (cur) entries.push(cur)
      cur = { key: kv[1], value: kv[2] }
    } else if (cur) {
      cur.value += '\n' + line
    }
  }
  if (cur) entries.push(cur)
  entries.sort((a, b) => a.key.localeCompare(b.key))
  const sorted = entries.map((e) => `${e.key}:${e.value}`).join('\n')
  return source.replace(m[0], `---\n${sorted}\n---`)
}

export const sortFmKeysAlphaV2: Command = (view) =>
  applyToSelectionOrAll(view, sortFmKeysAlphaV2Text, 'input.frontmatter.sortKeysV2')

                                           
export const insertPropertiesSummary: Command = (view) => {
  const src = view.state.doc.toString()
  const m = /^---\n([\s\S]*?)\n---/.exec(src)
  const block = m ? m[1] : ''
  const props: string[] = []
  for (const line of block.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) props.push(`- **${kv[1]}**: ${kv[2]}`)
  }
  if (props.length === 0) return false
  const insertAt = m ? m[0].length + 1 : 0
  const text = `## Properties\n\n${props.join('\n')}\n\n`
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: text },
    userEvent: 'input.insert.propsSummary',
  })
  return true
}

                                      
export function blockquoteToCalloutNoteText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  let inFence = false
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      out.push(lines[i])
      i++
      continue
    }
    if (!inFence && /^>\s?/.test(lines[i])) {
      const start = i
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      const firstIsCallout = /^>\s*\[!/i.test(lines[start])
      if (firstIsCallout) {
        for (const l of buf) out.push(l)
      } else {
        out.push('> [!note]')
        for (const l of buf) out.push(l)
      }
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

export const blockquoteToCalloutNote: Command = (view) =>
  applyToSelectionOrAll(view, blockquoteToCalloutNoteText, 'input.quote.toCallout')

                                            
export function priorityMarkersToWarningText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*-)\s+\[!\]\s+(.*)$/, '$1 [ ] ⚠️ $2')
  }
  return lines.join('\n')
}

export const priorityMarkersToWarning: Command = (view) =>
  applyToSelectionOrAll(view, priorityMarkersToWarningText, 'input.tasks.priorityToWarn')

                            
export function stripWikilinksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t: string, a?: string) =>
      (a ?? t).trim(),
    )
  }
  return lines.join('\n')
}

export const stripWikilinks: Command = (view) =>
  applyToSelectionOrAll(view, stripWikilinksText, 'input.links.stripWiki')

                                 
export const insertMermaidMindmap: Command = (view) => {
  const text =
    '\n```mermaid\nmindmap\n  root((Topic))\n    Branch A\n      Leaf 1\n      Leaf 2\n    Branch B\n      Leaf 3\n```\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.mermaidMindmap',
  })
  return true
}

                                                         
export const linkToFootnote: Command = (view) => {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const text = line.text
  const m = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(text)
  if (!m) return false
  const doc = view.state.doc.toString()
  const nums = Array.from(doc.matchAll(/\[\^(\d+)\]:/g)).map((g) => Number(g[1]))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  const replaced = text.replace(m[0], `${m[1]}[^${next}]`)
  const footnote = `\n[^${next}]: ${m[2]}\n`
  view.dispatch({
    changes: [
      { from: line.from, to: line.to, insert: replaced },
      { from: doc.length, to: doc.length, insert: footnote },
    ],
    userEvent: 'input.links.toFootnote',
  })
  return true
}

                                            
export function wrapParagraphsHtmlText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let buf: string[] = []
  const flush = () => {
    if (buf.length === 0) return
    out.push(`<p>${buf.join(' ').trim()}</p>`)
    buf = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      out.push(line)
      continue
    }
    if (/^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\|)/.test(line)) {
      flush()
      out.push(line)
      continue
    }
    buf.push(line.trim())
  }
  flush()
  return out.join('\n')
}

export const wrapParagraphsHtml: Command = (view) =>
  applyToSelectionOrAll(view, wrapParagraphsHtmlText, 'format.paragraph.html')

                                     
export function addHeadingStatusBadgeText(source: string, status: string): string {
  const lines = source.split('\n')
  const tag = `[${status.toUpperCase()}]`
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6}) (.*)$/.exec(lines[i])
    if (m && !m[2].startsWith(tag)) lines[i] = `${m[1]} ${tag} ${m[2]}`
  }
  return lines.join('\n')
}

export const addHeadingStatusBadge =
  (status: string): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => addHeadingStatusBadgeText(s, status), 'input.heading.badge')

                                        
export function formatThousandsSepText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const masked = lines[i].replace(/`[^`]*`/g, (s) => '\x00'.repeat(s.length))
    const placeholders: string[] = []
    let work = masked
    work = work.replace(/\[[^\]]*\]\([^)\s]+\)/g, (s) => {
      placeholders.push(s)
      return `${placeholders.length - 1}`
    })
    work = work.replace(/\b(\d{4,})(?!\d)/g, (n) =>
      Number(n).toLocaleString('en-US'),
    )
    work = work.replace(/(\d+)/g, (_w, idx) => placeholders[Number(idx)])
    lines[i] = work.replace(/\x00/g, (_c, _idx, full) => {
      const orig = lines[i]
      return orig[full.indexOf('\x00')]
    })
    lines[i] = work.replace(/\x00/g, '')
                                        
    const oj = 0
    lines[i] = work || ''
  }
                                           
  return lines.join('\n')
}

export const formatThousandsSep: Command = (view) =>
  applyToSelectionOrAll(view, formatThousandsSepText, 'format.numbers.thousands')

                      
export const insertKatexBlock: Command = (view) => {
  const text = '\n$$\n\\frac{a}{b} = c\n$$\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.katex',
  })
  return true
}

                                                   
export function orderedListToWikilinkListText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)\d+\.\s+(.*)$/.exec(lines[i])
    if (m) lines[i] = `${m[1]}- [[${m[2].trim()}]]`
  }
  return lines.join('\n')
}

export const orderedListToWikilinkList: Command = (view) =>
  applyToSelectionOrAll(view, orderedListToWikilinkListText, 'input.list.toWikiList')

                   
export const insertWeeklyReviewTemplate: Command = (view) => {
  const text =
    '## 📊 Wins\n\n- \n\n## 🚧 Challenges\n\n- \n\n## 🎯 Next Week\n\n- \n\n'
  view.dispatch({
    changes: { from: 0, to: 0, insert: text },
    userEvent: 'input.insert.weekly',
  })
  return true
}

                                         
export function stripEmphasisText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i]
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
  }
  return lines.join('\n')
}

export const stripEmphasis: Command = (view) =>
  applyToSelectionOrAll(view, stripEmphasisText, 'input.format.stripEmphasis')

                                              
export function listToDefinitionListText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const m = /^\s*[-*+]\s+([^:]+):\s+(.*)$/.exec(line)
    if (m) {
      out.push(m[1].trim())
      out.push(`: ${m[2].trim()}`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

export const listToDefinitionList: Command = (view) =>
  applyToSelectionOrAll(view, listToDefinitionListText, 'input.list.toDefList')

                                 
export const wrapSelectionInQuoteCallout: Command = (view) => {
  const range = view.state.selection.main
  if (range.empty) return false
  const text = view.state.sliceDoc(range.from, range.to)
  const quoted = text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  const next = `> [!quote]\n${quoted}`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    selection: { anchor: range.from, head: range.from + next.length },
    userEvent: 'input.insert.quoteCallout',
  })
  return true
}

                             
export const insertRawHtmlSnippet =
  (html: string): Command =>
  (view) => {
    const head = view.state.selection.main.head
    const text = `\n${html}\n`
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.rawHtml',
    })
    return true
  }

                            
export const insertSidebarReference =
  (page: string): Command =>
  (view) => {
    const text = `\n> [!sidebar] ${page}\n> ![[${page}]]\n\n`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.sidebarRef',
    })
    return true
  }

                       
export function appendTagToParagraphsText(source: string, tag: string): string {
  const cleanTag = tag.replace(/^#/, '')
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let buf: string[] = []
  const flush = () => {
    if (buf.length === 0) return
    const lastLine = buf[buf.length - 1]
    if (lastLine.includes(`#${cleanTag}`)) {
      out.push(...buf)
    } else {
      out.push(...buf.slice(0, -1))
      out.push(`${lastLine} #${cleanTag}`)
    }
    buf = []
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line.trim() === '' || /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\|)/.test(line)) {
      flush()
      out.push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  return out.join('\n')
}

export const appendTagToParagraphs =
  (tag: string): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => appendTagToParagraphsText(s, tag), 'input.tag.append')

                             
export const insertDocumentSubtitle =
  (text: string): Command =>
  (view) => {
    const doc = view.state.doc.toString()
    const m = /^(#\s.+)\n/m.exec(doc)
    const at = m ? doc.indexOf(m[0]) + m[0].length : 0
    const insert = `\n*${text}*\n`
    view.dispatch({
      changes: { from: at, to: at, insert },
      userEvent: 'input.insert.subtitle',
    })
    return true
  }

                   
export function boldifyTagsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/(^|[\s,])(#[\p{L}\p{N}_-]+)/gu, (_w, pre: string, tag: string) =>
      tag.startsWith('**') ? `${pre}${tag}` : `${pre}**${tag}**`,
    )
  }
  return lines.join('\n')
}

export const boldifyTags: Command = (view) =>
  applyToSelectionOrAll(view, boldifyTagsText, 'input.tag.bold')

                                                   
export function asciiTasksToUnicodeText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i]
      .replace(/^(\s*)-\s+\[\s\]\s+/, '$1☐ ')
      .replace(/^(\s*)-\s+\[[xX]\]\s+/, '$1☒ ')
  }
  return lines.join('\n')
}

export const asciiTasksToUnicode: Command = (view) =>
  applyToSelectionOrAll(view, asciiTasksToUnicodeText, 'input.tasks.toUnicode')

                                      
export const insertSearchCallout =
  (query: string): Command =>
  (view) => {
    const text = `\n> [!search] ${query}\n>\n> \`${query}\`\n\n`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.searchCallout',
    })
    return true
  }

                                   
export function checkedTaskToEmojiText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*-)\s+\[[xX]\]\s+/, '$1 ✅ ')
  }
  return lines.join('\n')
}

export const checkedTaskToEmoji: Command = (view) =>
  applyToSelectionOrAll(view, checkedTaskToEmojiText, 'input.tasks.toEmoji')

                                   
export const insertTocWithDepth =
  (maxDepth: number = 3): Command =>
  (view) => {
    const src = view.state.doc.toString()
    const lines = src.split('\n')
    const items: string[] = []
    let inFence = false
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = /^(#{1,6}) (.*)$/.exec(line)
      if (!m) continue
      const depth = m[1].length
      if (depth > maxDepth) continue
      const title = m[2].trim()
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
      items.push(`${'  '.repeat(depth - 1)}- [${title}](#${slug})`)
    }
    const text = `## Table of Contents\n\n${items.join('\n')}\n\n`
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: head, to: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: 'input.insert.tocDepth',
    })
    return true
  }

                                                         
export function groupH3UnderH2DetailsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    out.push(lines[i])
    if (/^##\s/.test(lines[i])) {
      i++
      while (i < lines.length && !/^##\s/.test(lines[i])) {
        if (/^###\s/.test(lines[i])) {
          const title = lines[i].replace(/^###\s+/, '')
          out.push(`<details>\n<summary>${title}</summary>\n`)
          i++
          while (i < lines.length && !/^##\s/.test(lines[i]) && !/^###\s/.test(lines[i])) {
            out.push(lines[i])
            i++
          }
          out.push('</details>')
          continue
        }
        out.push(lines[i])
        i++
      }
      continue
    }
    i++
  }
  return out.join('\n')
}

export const groupH3UnderH2Details: Command = (view) =>
  applyToSelectionOrAll(view, groupH3UnderH2DetailsText, 'input.heading.groupH3Details')

                                            
export const insertWikilinkAuditPlaceholder: Command = (view) => {
  const src = view.state.doc.toString()
  const links = new Set<string>()
  let inFence = false
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const m of line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      links.add(m[1].trim())
    }
  }
  const list = Array.from(links).sort()
  const text =
    `\n## Wikilink audit\n\n${list.length ? list.map((l) => `- [[${l}]]`).join('\n') : '_(no wikilinks)_'}\n\n_Manually mark broken targets above._\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.wikiAudit',
  })
  return true
}

                                                          
export const insertTocWithTaskProgress: Command = (view) => {
  const src = view.state.doc.toString()
  const lines = src.split('\n')
  const items: string[] = []
  let cur: { title: string; total: number; done: number } | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^##\s/.test(line)) {
      if (cur) items.push(cur.total === 0 ? `- ${cur.title}` : `- ${cur.title} — ${cur.done}/${cur.total}`)
      cur = { title: line.replace(/^##\s+/, ''), total: 0, done: 0 }
      continue
    }
    if (cur && /^(\s*)-\s+\[[ xX]\]\s/.test(line)) {
      cur.total++
      if (/^(\s*)-\s+\[[xX]\]\s/.test(line)) cur.done++
    }
  }
  if (cur) items.push(cur.total === 0 ? `- ${cur.title}` : `- ${cur.title} — ${cur.done}/${cur.total}`)
  const text = `\n## TOC (progress)\n\n${items.join('\n') || '_(no H2 found)_'}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.tocProgress',
  })
  return true
}

                                                         
export function annotateHeadingsWithProgressText(source: string): string {
  const lines = source.split('\n')
  type HeadIdx = { idx: number; level: number }
  const heads: HeadIdx[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,3})\s/.exec(lines[i])
    if (m) heads.push({ idx: i, level: m[1].length })
  }
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].idx + 1
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length
    let total = 0
    let done = 0
    for (let i = start; i < end; i++) {
      const ln = lines[i]
      if (/^\s*-\s+\[[ xX]\]\s/.test(ln)) {
        total++
        if (/^\s*-\s+\[[xX]\]\s/.test(ln)) done++
      }
    }
    if (total > 0) {
      const title = lines[heads[h].idx]
      if (!/\(\d+\/\d+\)\s*$/.test(title)) lines[heads[h].idx] = `${title} (${done}/${total})`
    }
  }
  return lines.join('\n')
}

export const annotateHeadingsWithProgress: Command = (view) =>
  applyToSelectionOrAll(view, annotateHeadingsWithProgressText, 'input.heading.taskProgress')

                                          
export const insertFrontmatterFromH1: Command = (view) => {
  const src = view.state.doc.toString()
  if (/^---\n/.test(src)) return false
  const m = /^#\s+(.+)$/m.exec(src)
  if (!m) return false
  const title = m[1].trim()
  const now = new Date().toISOString().slice(0, 10)
  const text = `---\ntitle: ${title}\ncreated: ${now}\ntags: []\n---\n\n`
  view.dispatch({
    changes: { from: 0, to: 0, insert: text },
    userEvent: 'input.insert.fmFromH1',
  })
  return true
}

                                                           
export function tagsToWikilinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^#{1,6}\s/.test(lines[i])) continue
    lines[i] = lines[i].replace(
      /(^|[\s,;:.])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu,
      (_w, pre: string, tag: string) => `${pre}[[${tag}]]`,
    )
  }
  return lines.join('\n')
}

export const tagsToWikilink: Command = (view) =>
  applyToSelectionOrAll(view, tagsToWikilinkText, 'input.tag.toWikilink')

                                 
export const insertScrollTopButton: Command = (view) => {
  const text =
    '\n<a href="#" style="position:fixed;right:1em;bottom:1em;padding:0.4em 0.8em;background:#888;color:#fff;border-radius:4px;text-decoration:none;">↑ Top</a>\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.scrollTop',
  })
  return true
}

                                
export const quoteCurrentParagraph: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const head = state.selection.main.head
  const cur = doc.lineAt(head)
  let startLine = cur.number
  while (startLine > 1 && doc.line(startLine - 1).text.trim() !== '') startLine--
  let endLine = cur.number
  while (endLine < doc.lines && doc.line(endLine + 1).text.trim() !== '') endLine++
  const fromPos = doc.line(startLine).from
  const toPos = doc.line(endLine).to
  const text = doc.sliceString(fromPos, toPos)
  if (!text.trim()) return false
  const quoted = text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert: quoted },
    selection: { anchor: fromPos, head: fromPos + quoted.length },
    userEvent: 'input.format.quotePara',
  })
  return true
}

                                          
export const insertLast7DaysChain: Command = (view) => {
  const out: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(`[[${d.toISOString().slice(0, 10)}]]`)
  }
  const text = '\n' + out.join(' › ') + '\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.daysChain',
  })
  return true
}

                                                  
export function asciiSymbolsToUnicodeText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i]
      .replace(/\(c\)/gi, '©')
      .replace(/\(r\)/gi, '®')
      .replace(/\(tm\)/gi, '™')
      .replace(/\.\.\./g, '…')
  }
  return lines.join('\n')
}

export const asciiSymbolsToUnicode: Command = (view) =>
  applyToSelectionOrAll(view, asciiSymbolsToUnicodeText, 'input.format.asciiToUnicode')

                                             
export const copyCurrentSectionAsPlain: Command = (view) => {
  const state = view.state
  const doc = state.doc
  const head = state.selection.main.head
  const cur = doc.lineAt(head)
  let startLine = cur.number
  while (startLine > 1 && !/^##?\s/.test(doc.line(startLine).text)) startLine--
  let endLine = startLine + 1
  while (endLine <= doc.lines && !/^##?\s/.test(doc.line(endLine).text)) endLine++
  if (endLine > doc.lines) endLine = doc.lines
  const text = doc.sliceString(doc.line(startLine).from, doc.line(endLine).from)
  const plain = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t: string, a?: string) => (a ?? t).trim())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(plain).catch(() => {})
  }
  return true
}

                                                         
export function appendTableColumnStatsText(source: string, col: number): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const start = i
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++
    const end = i
    for (let k = start; k < end; k++) out.push(lines[k])
    const dataRows = lines.slice(start + 2, end)
    const values = dataRows.map((r) => {
      const cells = r.split('|').map((c) => c.trim()).slice(1, -1)
      const n = Number(cells[col])
      return Number.isFinite(n) ? n : null
    }).filter((n): n is number => n !== null)
    if (values.length === 0) continue
    const sum = values.reduce((a, b) => a + b, 0)
    const avg = sum / values.length
    const min = Math.min(...values)
    const max = Math.max(...values)
    out.push(`_sum: ${sum} · avg: ${avg.toFixed(2)} · min: ${min} · max: ${max}_`)
  }
  return out.join('\n')
}

export const appendTableColumnStats =
  (col: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => appendTableColumnStatsText(s, col), 'input.table.colStats')

                                
export const pinSectionToTop: Command = (view) => {
  const doc = view.state.doc.toString()
  const lines = doc.split('\n')
  const head = view.state.selection.main.head
  const curLine = view.state.doc.lineAt(head).number - 1
  let start = curLine
  while (start > 0 && !/^##\s/.test(lines[start])) start--
  if (start === 0 && !/^##\s/.test(lines[0])) return false
  let end = start + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end++
  const section = lines.slice(start, end)
  let firstH2 = 0
  while (firstH2 < lines.length && !/^##\s/.test(lines[firstH2])) firstH2++
  if (firstH2 === start) return false
  const rest = [...lines.slice(0, firstH2), ...section, ...lines.slice(firstH2, start), ...lines.slice(end)]
  const next = rest.join('\n')
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: next },
    userEvent: 'input.section.pin',
  })
  return true
}

                                               
export function listToOutlinerText(source: string): string {
  const lines = source.split('\n')
  const counters: number[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(lines[i])
    if (m) {
      const indent = Math.floor(m[1].length / 2)
      while (counters.length > indent + 1) counters.pop()
      while (counters.length < indent + 1) counters.push(0)
      counters[indent] = (counters[indent] ?? 0) + 1
      const label = counters.slice(0, indent + 1).join('.')
      lines[i] = `${m[1]}${label}. ${m[2]}`
    } else if (lines[i].trim() === '') {
      counters.length = 0
    }
  }
  return lines.join('\n')
}

export const listToOutliner: Command = (view) =>
  applyToSelectionOrAll(view, listToOutlinerText, 'input.list.outliner')

                               
export const insertOgMetadataBlock: Command = (view) => {
  const text =
    '\n<!--\nog:title:\nog:description:\nog:image:\nog:url:\n-->\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.ogMeta',
  })
  return true
}

                                        
export function urlsToWikilinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/(^|[\s])(https?:\/\/[^\s)\]]+)/g, (_w, pre: string, url: string) =>
      `${pre}[[${url}]]`,
    )
  }
  return lines.join('\n')
}

export const urlsToWikilink: Command = (view) =>
  applyToSelectionOrAll(view, urlsToWikilinkText, 'input.links.urlsToWiki')

                                           
export const insertCurrentMonthCalendar: Command = (view) => {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const first = new Date(year, month, 1)
  const startWeekday = first.getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const rows: string[][] = []
  let row: string[] = Array(startWeekday).fill('')
  for (let d = 1; d <= daysInMonth; d++) {
    row.push(String(d))
    if (row.length === 7) {
      rows.push(row)
      row = []
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push('')
    rows.push(row)
  }
  const header = '| Sun | Mon | Tue | Wed | Thu | Fri | Sat |'
  const sep = '| --- | --- | --- | --- | --- | --- | --- |'
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  const text = `\n## ${year}-${String(month + 1).padStart(2, '0')}\n\n${header}\n${sep}\n${body}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.monthCal',
  })
  return true
}

                           
export function sentencesPerLineText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (line.trim() === '' || /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|\|.*\|)/.test(line)) {
      out.push(line)
      continue
    }
    const split = line.split(/(?<=\p{Sentence_Terminal})\s+/u)
    out.push(...split)
  }
  return out.join('\n')
}

export const sentencesPerLine: Command = (view) =>
  applyToSelectionOrAll(view, sentencesPerLineText, 'format.sentences.perLine')

                           
export function stripHtmlTagsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/<[^>]+>/g, '')
  }
  return lines.join('\n')
}

export const stripHtmlTags: Command = (view) =>
  applyToSelectionOrAll(view, stripHtmlTagsText, 'format.html.strip')

                             
export const insertHorizontalScrollContainer: Command = (view) => {
  const text =
    '\n<div style="overflow-x:auto;white-space:nowrap;border:1px solid #ddd;padding:8px;border-radius:6px;">\n  <span>note 1</span> | <span>note 2</span> | <span>note 3</span>\n</div>\n\n'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.hScroll',
  })
  return true
}

                                                        
export const insertExcelFormulaPlaceholder: Command = (view) => {
  const text = '`=SUM(1,2,3)`'
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.excelFormula',
  })
  return true
}

                                                         
export const archiveSectionToYear: Command = (view) => {
  const source = view.state.doc.toString()
  const sec = findCurrentSection(view.state)
  if (!sec) return false
  const doc = view.state.doc
  const headingLine = doc.line(sec.headingLineNo)
  const endLine =
    sec.endLineNo === -1 ? doc.line(doc.lines) : doc.line(sec.endLineNo)
  const fromOffset = headingLine.from
  const toOffset =
    sec.endLineNo === -1
      ? endLine.to
      : doc.line(sec.endLineNo).from
  const year = new Date().getFullYear()
  const archiveHeading = `## ${year} Archive`
  const sectionText = source.slice(fromOffset, toOffset)
  const withoutSection = source.slice(0, fromOffset) + source.slice(toOffset)
  const archIdx = withoutSection.indexOf(`\n${archiveHeading}`)
  let next: string
  if (archIdx === -1) {
    next =
      withoutSection.replace(/\n*$/, '') +
      `\n\n${archiveHeading}\n\n${sectionText.trim()}\n`
  } else {
    next =
      withoutSection.slice(0, archIdx + archiveHeading.length + 1) +
      '\n' +
      sectionText.trim() +
      '\n' +
      withoutSection.slice(archIdx + archiveHeading.length + 1)
  }
  view.dispatch({
    changes: { from: 0, to: source.length, insert: next },
    userEvent: 'input.section.archiveYear',
  })
  return true
}

const EMOJI_SHORTCODE_MAP: Record<string, string> = {
  smile: '😄',
  laughing: '😆',
  blush: '😊',
  heart: '❤️',
  thumbsup: '👍',
  thumbsdown: '👎',
  fire: '🔥',
  rocket: '🚀',
  tada: '🎉',
  warning: '⚠️',
  check: '✅',
  x: '❌',
  star: '⭐',
  eyes: '👀',
  bug: '🐛',
  bulb: '💡',
  book: '📖',
  pencil: '✏️',
  computer: '💻',
  clock: '⏰',
}

                                                     
export function emojiShortcodesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const parts = lines[i].split(/(`[^`]*`)/g)
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].startsWith('`')) continue
      parts[p] = parts[p].replace(/:([a-z_]+):/g, (m, n: string) => EMOJI_SHORTCODE_MAP[n] ?? m)
    }
    lines[i] = parts.join('')
  }
  return lines.join('\n')
}

export const emojiShortcodes: Command = (view) =>
  applyToSelectionOrAll(view, emojiShortcodesText, 'format.emoji.shortcodes')

                             
export function unifyBulletDashText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*)[*+]\s+/, '$1- ')
  }
  return lines.join('\n')
}

export const unifyBulletDash: Command = (view) =>
  applyToSelectionOrAll(view, unifyBulletDashText, 'format.list.bulletDash')

                               
export function tableColToWikilinkText(source: string, col: number): string {
  const lines = source.split('\n')
  let inTable = false
  let rowIdx = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      if (!inTable) {
        inTable = true
        rowIdx = 0
      }
      if (rowIdx >= 2 && !/^\s*\|\s*[-:]+/.test(lines[i])) {
        const parts = lines[i].split('|')
        const idx = col + 1
        if (idx < parts.length - 1) {
          const cell = parts[idx].trim()
          if (cell && !/^\[\[.*\]\]$/.test(cell)) {
            parts[idx] = ` [[${cell}]] `
            lines[i] = parts.join('|')
          }
        }
      }
      rowIdx++
    } else {
      inTable = false
      rowIdx = 0
    }
  }
  return lines.join('\n')
}

export const tableColToWikilink =
  (col: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => tableColToWikilinkText(s, col), 'input.table.colWikilink')

                     
export const insertTilTemplate: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n# TIL ${today}\n\n## What I learned\n\n- \n\n## Why it matters\n\n- \n\n## References\n\n- \n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.til',
  })
  return true
}

                               
export function dedupAdjacentParagraphsV2Text(source: string): string {
  const paras = source.split(/\n\n+/)
  const out: string[] = []
  let prev = ''
  for (const p of paras) {
    if (p.trim() === prev.trim() && p.trim() !== '') continue
    out.push(p)
    prev = p
  }
  return out.join('\n\n')
}

export const dedupAdjacentParagraphsV2: Command = (view) =>
  applyToSelectionOrAll(view, dedupAdjacentParagraphsV2Text, 'format.paragraph.dedupAdjacentV2')

                           
export const insertPomodoroTracker: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n## Pomodoro ${today}\n\n| # | Start | End | Task | Done |\n| --- | --- | --- | --- | --- |\n| 1 | 09:00 | 09:25 |   | ⬜ |\n| 2 | 09:30 | 09:55 |   | ⬜ |\n| 3 | 10:00 | 10:25 |   | ⬜ |\n| 4 | 10:30 | 10:55 |   | ⬜ |\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.pomodoro',
  })
  return true
}

                                           
export function footnotesToInlineText(source: string): string {
  const defs = new Map<string, string>()
  const lines = source.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const m = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line)
    if (m) {
      defs.set(m[1], m[2])
    } else {
      kept.push(line)
    }
  }
  let body = kept.join('\n')
  body = body.replace(/\[\^([^\]]+)\]/g, (m, id: string) => {
    const def = defs.get(id)
    return def ? ` (${def})` : m
  })
  return body
}

export const footnotesToInline: Command = (view) =>
  applyToSelectionOrAll(view, footnotesToInlineText, 'format.footnotes.inline')

                                           
export const insertQuoteOfTheDay: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n> [!quote] Quote of the day · ${today}\n> > In your deepest nature, all you want is to be happy.\n> — Naval Ravikant\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.quoteDay',
  })
  return true
}

                                                  
export function computeReadingProfileText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  let words = 0
  let chars = 0
  let sentences = 0
  let paragraphs = 0
  let inParagraph = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line.trim() === '') {
      if (inParagraph) {
        paragraphs++
        inParagraph = false
      }
      continue
    }
    inParagraph = true
    chars += line.length
    words += (line.match(/[\p{L}\p{N}]+/gu) ?? []).length
    sentences += (line.match(/\p{Sentence_Terminal}/gu) ?? []).length
  }
  if (inParagraph) paragraphs++
  return [
    '| Metric | Value |',
    '| --- | --- |',
    `| Words | ${words} |`,
    `| Characters | ${chars} |`,
    `| Sentences | ${sentences} |`,
    `| Paragraphs | ${paragraphs} |`,
  ].join('\n')
}

export const insertReadingProfile: Command = (view) => {
  const source = view.state.doc.toString()
  const table = computeReadingProfileText(source)
  const text = `\n## Reading profile\n\n${table}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.readingProfile',
  })
  return true
}

                                       
export function reverseOutlineText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      const indent = '  '.repeat(m[1].length - 1)
      out.push(`${indent}- ${m[2]}`)
    }
  }
  return out.join('\n')
}

export const insertReverseOutline: Command = (view) => {
  const source = view.state.doc.toString()
  const outline = reverseOutlineText(source)
  const text = `\n## Reverse outline\n\n${outline}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.reverseOutline',
  })
  return true
}

                  
export const insertMoodLogTable: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n## Mood log ${today}\n\n| Time | Mood | Energy | Notes |\n| --- | --- | --- | --- |\n| Morning | 😊 |   |   |\n| Noon |   |   |   |\n| Evening |   |   |   |\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.moodLog',
  })
  return true
}

                                                                  
export function checklistToDefinitionListText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(\s*)- \[[ xX]\]\s+(.+?)\s*::\s*(.*)$/.exec(lines[i])
    if (m) {
      lines[i] = `${m[1]}${m[2]}\n${m[1]}: ${m[3]}`
    }
  }
  return lines.join('\n')
}

export const checklistToDefinitionList: Command = (view) =>
  applyToSelectionOrAll(view, checklistToDefinitionListText, 'format.checklist.toDefList')

                                        
export function markLongParagraphsText(source: string, maxChars = 400): string {
  const paras = source.split(/\n\n+/)
  return paras
    .map((p) => {
      const stripped = p.replace(/\n/g, ' ').trim()
      if (
        stripped.length > maxChars &&
        !/^[#>|\-*+\d]/.test(p.trimStart()) &&
        !/^```/.test(p)
      ) {
        return `> [!warning] Long paragraph (${stripped.length} chars)\n\n${p}`
      }
      return p
    })
    .join('\n\n')
}

export const markLongParagraphs =
  (max?: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => markLongParagraphsText(s, max), 'format.paragraph.markLong')

                                                 
const RFC_KEYWORDS = [
  'MUST NOT',
  'MUST',
  'SHALL NOT',
  'SHALL',
  'SHOULD NOT',
  'SHOULD',
  'MAY',
  'REQUIRED',
  'RECOMMENDED',
  'OPTIONAL',
]

export function boldifyRfcKeywordsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const kw of RFC_KEYWORDS) {
      const re = new RegExp(`(^|\\s)${kw}(\\s|$|[.,;:])`, 'g')
      lines[i] = lines[i].replace(re, (_m, pre: string, post: string) => `${pre}**${kw}**${post}`)
    }
  }
  return lines.join('\n')
}

export const boldifyRfcKeywords: Command = (view) =>
  applyToSelectionOrAll(view, boldifyRfcKeywordsText, 'format.rfc.keywords')

                                                  
export function frontmatterDatesToIsoText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const fm = m[1]
  const next = fm.replace(/^([a-zA-Z_][\w-]*)\s*:\s*([0-9/\-]+)/gm, (line, key: string, val: string) => {
    const slash = val.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
    if (slash) {
      return `${key}: ${slash[1]}-${String(slash[2]).padStart(2, '0')}-${String(slash[3]).padStart(2, '0')}`
    }
    const dash = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (dash) {
      return `${key}: ${dash[1]}-${String(dash[2]).padStart(2, '0')}-${String(dash[3]).padStart(2, '0')}`
    }
    return line
  })
  return source.slice(0, m.index) + '---\n' + next + '\n---' + source.slice(m.index + m[0].length)
}

export const frontmatterDatesToIso: Command = (view) =>
  applyToSelectionOrAll(view, frontmatterDatesToIsoText, 'format.frontmatter.datesIso')

                           
export function renameTableColumnText(source: string, col: number, newName: string): string {
  const lines = source.split('\n')
  let inTable = false
  let rowIdx = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      if (!inTable) {
        inTable = true
        rowIdx = 0
      }
      if (rowIdx === 0) {
        const parts = lines[i].split('|')
        const idx = col + 1
        if (idx < parts.length - 1) {
          parts[idx] = ` ${newName} `
          lines[i] = parts.join('|')
        }
      }
      rowIdx++
    } else {
      inTable = false
      rowIdx = 0
    }
  }
  return lines.join('\n')
}

export const renameTableColumn =
  (col: number, name: string): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => renameTableColumnText(s, col, name), 'input.table.renameCol')

                                            
export function sortTasksByPriorityEmojiText(source: string): string {
  const PRIORITY: Record<string, number> = { '🔴': 0, '🟠': 1, '🟡': 2, '🟢': 3 }
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*- \[[ xX]\]/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const block: string[] = []
    while (i < lines.length && /^\s*- \[[ xX]\]/.test(lines[i])) {
      block.push(lines[i])
      i++
    }
    block.sort((a, b) => {
      const pa = PRIORITY[a.match(/[🔴🟠🟡🟢]/u)?.[0] ?? ''] ?? 99
      const pb = PRIORITY[b.match(/[🔴🟠🟡🟢]/u)?.[0] ?? ''] ?? 99
      return pa - pb
    })
    out.push(...block)
  }
  return out.join('\n')
}

export const sortTasksByPriorityEmoji: Command = (view) =>
  applyToSelectionOrAll(view, sortTasksByPriorityEmojiText, 'format.tasks.sortPriority')

                            
export const insertPrivacyNotice: Command = (view) => {
  const text = `\n> [!warning] Privacy notice\n> This document contains sensitive information. Do not share externally; destroy copies when done.\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.privacy',
  })
  return true
}

                                     
export function appendTableTotalsRowText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const start = i
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++
    const end = i
    for (let k = start; k < end; k++) out.push(lines[k])
    if (end - start < 3) continue
    const dataRows = lines.slice(start + 2, end)
    const headerCells = lines[start].split('|').slice(1, -1)
    const colCount = headerCells.length
    const sums: (number | null)[] = new Array(colCount).fill(null)
    const counts: number[] = new Array(colCount).fill(0)
    for (const r of dataRows) {
      const cells = r.split('|').slice(1, -1)
      for (let c = 0; c < colCount; c++) {
        const n = Number((cells[c] ?? '').trim())
        if (Number.isFinite(n) && cells[c]?.trim() !== '') {
          sums[c] = (sums[c] ?? 0) + n
          counts[c]++
        }
      }
    }
    const totalCells = sums.map((s, c) => {
      if (s === null) return ' '
      const avg = (s / counts[c]).toFixed(2)
      return ` Σ${s} (avg ${avg}) `
    })
    out.push(`|${totalCells.join('|')}|`)
  }
  return out.join('\n')
}

export const appendTableTotalsRow: Command = (view) =>
  applyToSelectionOrAll(view, appendTableTotalsRowText, 'input.table.totalsRow')

                                       
export function bubbleUncheckedTasksTopText(source: string): string {
  const lines = source.split('\n')
  const unchecked: string[] = []
  const checked: string[] = []
  const others: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      others.push(line)
      continue
    }
    if (inFence) {
      others.push(line)
      continue
    }
    if (/^\s*- \[ \]/.test(line)) unchecked.push(line)
    else if (/^\s*- \[[xX]\]/.test(line)) checked.push(line)
    else others.push(line)
  }
  return [...unchecked, ...checked, ...others].join('\n')
}

export const bubbleUncheckedTasksTop: Command = (view) =>
  applyToSelectionOrAll(view, bubbleUncheckedTasksTopText, 'format.tasks.bubbleUnchecked')

                              
export const insertRecurringTasksTemplate: Command = (view) => {
  const text = `\n## Recurring tasks\n\n### Daily\n\n- [ ] Morning reading 10 min\n- [ ] Write in journal\n- [ ] Exercise\n\n### Weekly\n\n- [ ] Weekly review\n- [ ] Clear inbox\n\n### Monthly\n\n- [ ] Financial summary\n- [ ] Goal retrospective\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.recurring',
  })
  return true
}

                                                       
export function stripAllMarkdownText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    let s = line
    s = s.replace(/^#{1,6}\s+/, '')
    s = s.replace(/^\s*[-*+]\s+/, '')
    s = s.replace(/^\s*\d+\.\s+/, '')
    s = s.replace(/^>\s?/, '')
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    s = s.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
    s = s.replace(/\*([^*]+)\*/g, '$1')
    s = s.replace(/_([^_]+)_/g, '$1')
    s = s.replace(/~~([^~]+)~~/g, '$1')
    s = s.replace(/`([^`]+)`/g, '$1')
    s = s.replace(/^=+$/, '')
    s = s.replace(/^-+$/, '')
    out.push(s)
  }
  return out.join('\n')
}

export const stripAllMarkdown: Command = (view) =>
  applyToSelectionOrAll(view, stripAllMarkdownText, 'format.markdown.stripAll')

                                              
export function listToMermaidPieText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*- /.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const items: { label: string; value: number }[] = []
    while (i < lines.length && /^\s*- /.test(lines[i])) {
      const m = /^\s*- (.+?)(?:\s*:\s*(\d+(?:\.\d+)?))?\s*$/.exec(lines[i])
      if (m) {
        items.push({ label: m[1], value: Number(m[2] ?? 1) })
      }
      i++
    }
    out.push('```mermaid')
    out.push('pie title Distribution')
    for (const it of items) {
      out.push(`  "${it.label}" : ${it.value}`)
    }
    out.push('```')
  }
  return out.join('\n')
}

export const listToMermaidPie: Command = (view) =>
  applyToSelectionOrAll(view, listToMermaidPieText, 'input.list.toMermaidPie')

                            
export function normalizeTableWhitespaceText(source: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue
    const parts = lines[i].split('|')
    for (let j = 1; j < parts.length - 1; j++) {
      parts[j] = ` ${parts[j].trim()} `
    }
    lines[i] = parts.join('|')
  }
  return lines.join('\n')
}

export const normalizeTableWhitespace: Command = (view) =>
  applyToSelectionOrAll(view, normalizeTableWhitespaceText, 'format.table.ws')

                        
export const insertFaqQaBlock: Command = (view) => {
  const text = `\n## FAQ\n\n### Q: \n\nA: \n\n### Q: \n\nA: \n\n### Q: \n\nA: \n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.faq',
  })
  return true
}

                                
export function swapParagraphsText(source: string, a: number, b: number): string {
  const paras = source.split(/\n\n+/)
  if (a < 1 || b < 1 || a > paras.length || b > paras.length || a === b) return source
  const tmp = paras[a - 1]
  paras[a - 1] = paras[b - 1]
  paras[b - 1] = tmp
  return paras.join('\n\n')
}

export const swapParagraphs =
  (a: number, b: number): Command =>
  (view) =>
    applyToSelectionOrAll(view, (s) => swapParagraphsText(s, a, b), 'format.paragraph.swap')

                                
export const insertTilRecentIndex: Command = (view) => {
  const now = new Date()
  const items: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const date = d.toISOString().slice(0, 10)
    items.push(`- [[TIL ${date}]]`)
  }
  const text = `\n## TIL recent\n\n${items.join('\n')}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.tilRecent',
  })
  return true
}

                        
export const insertReadingLogTable: Command = (view) => {
  const text = `\n## Reading log\n\n| Book | Author | Started | Progress | Notes |\n| --- | --- | --- | --- | --- |\n|   |   |   | 0% |   |\n|   |   |   | 0% |   |\n|   |   |   | 0% |   |\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.readingLog',
  })
  return true
}

                                                         
export function cycleCheckboxTriStateText(source: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^(\s*)- \[ \]\s+/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*)- \[ \]\s+/, '$1- [/] ')
    } else if (/^(\s*)- \[\/\]\s+/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*)- \[\/\]\s+/, '$1- [x] ')
    } else if (/^(\s*)- \[[xX]\]\s+/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*)- \[[xX]\]\s+/, '$1- [ ] ')
    }
  }
  return lines.join('\n')
}

export const cycleCheckboxTriState: Command = (view) =>
  applyToSelectionOrAll(view, cycleCheckboxTriStateText, 'format.checkbox.cycle3')

                  
export function trimTrailingWhitespaceText(source: string): string {
  return source
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
}

export const trimTrailingWhitespaceV2: Command = (view) =>
  applyToSelectionOrAll(view, trimTrailingWhitespaceText, 'format.ws.trimTrailingV2')

                                                                     
export function sortFrontmatterBySpecOrderText(source: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(source)
  if (!m) return source
  const fm = m[1]
  const lines = fm.split('\n')
  const order = ['title', 'date', 'tags', 'aliases', 'description', 'author']
  type Entry = { key: string; body: string[] }
  const entries: Entry[] = []
  let cur: Entry | null = null
  for (const line of lines) {
    const km = /^([a-zA-Z_][\w-]*)\s*:/.exec(line)
    if (km) {
      if (cur) entries.push(cur)
      cur = { key: km[1], body: [line] }
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) entries.push(cur)
  entries.sort((a, b) => {
    const ai = order.indexOf(a.key)
    const bi = order.indexOf(b.key)
    if (ai === -1 && bi === -1) return a.key.localeCompare(b.key)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
  const sorted = entries.flatMap((e) => e.body).join('\n')
  return source.slice(0, m.index) + '---\n' + sorted + '\n---' + source.slice(m.index + m[0].length)
}

export const sortFrontmatterBySpecOrder: Command = (view) =>
  applyToSelectionOrAll(view, sortFrontmatterBySpecOrderText, 'format.frontmatter.specOrder')

                     
export const insertWeeklyMeetingNotes: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n## Weekly meeting · ${today}\n\n### Attendees\n\n- \n\n### Agenda\n\n- \n\n### Decisions\n\n- \n\n### Action items\n\n- [ ] @owner — task by date\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.weeklyMeeting',
  })
  return true
}

                                              
export function firstTableRowToListText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const start = i
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) i++
    const end = i
    if (end - start < 3) {
      for (let k = start; k < end; k++) out.push(lines[k])
      continue
    }
    const header = lines[start].split('|').slice(1, -1).map((c) => c.trim())
    const first = lines[start + 2].split('|').slice(1, -1).map((c) => c.trim())
    for (let c = 0; c < header.length; c++) {
      out.push(`- **${header[c]}**: ${first[c] ?? ''}`)
    }
    for (let k = start + 3; k < end; k++) out.push(lines[k])
  }
  return out.join('\n')
}

export const firstTableRowToList: Command = (view) =>
  applyToSelectionOrAll(view, firstTableRowToListText, 'format.table.rowToList')

                               
export const insertTldrCallout: Command = (view) => {
  const text = `\n> [!summary] TL;DR\n> - \n> - \n> - \n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.tldr',
  })
  return true
}

                            
export const insertWeeklyHabitTracker: Command = (view) => {
  const now = new Date()
  const monday = new Date(now)
  const day = monday.getDay()
  const diff = day === 0 ? -6 : 1 - day
  monday.setDate(monday.getDate() + diff)
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    days.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`)
  }
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const header = `| Habit | ${dayNames.map((n, i) => `${n} ${days[i]}`).join(' | ')} |`
  const sep = `| --- | ${dayNames.map(() => '---').join(' | ')} |`
  const rows = ['Read', 'Exercise', 'Meditate', 'Journal']
    .map((h) => `| ${h} | ${dayNames.map(() => '⬜').join(' | ')} |`)
    .join('\n')
  const text = `\n## Habits week of ${monday.toISOString().slice(0, 10)}\n\n${header}\n${sep}\n${rows}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.habitWeek',
  })
  return true
}

                                             
export function sortDateSectionsDescText(source: string): string {
  const lines = source.split('\n')
  type Sec = { heading: string; body: string[]; date: string | null }
  const sections: Sec[] = []
  const pre: string[] = []
  let cur: Sec | null = null
  for (const line of lines) {
    const m = /^## (.*)$/.exec(line)
    if (m) {
      if (cur) sections.push(cur)
      else if (pre.length) {
        // pre stays separate
      }
      const dateMatch = m[1].match(/(\d{4}-\d{2}-\d{2})/)
      cur = { heading: line, body: [], date: dateMatch?.[1] ?? null }
    } else if (cur) {
      cur.body.push(line)
    } else {
      pre.push(line)
    }
  }
  if (cur) sections.push(cur)
  const dated = sections.filter((s) => s.date !== null)
  const undated = sections.filter((s) => s.date === null)
  dated.sort((a, b) => (b.date! > a.date! ? 1 : b.date! < a.date! ? -1 : 0))
  const sorted = [...dated, ...undated]
  const out: string[] = [...pre]
  for (const s of sorted) {
    out.push(s.heading)
    out.push(...s.body)
  }
  return out.join('\n')
}

export const sortDateSectionsDesc: Command = (view) =>
  applyToSelectionOrAll(view, sortDateSectionsDescText, 'format.section.sortDateDesc')

                       
export const insertPageBreak: Command = (view) => {
  const text = `\n\n<div style="page-break-after: always;"></div>\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.pageBreak',
  })
  return true
}

                                                       
export function imagesToFigureText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
      const captionLine = alt ? `\n  <figcaption>${alt}</figcaption>` : ''
      return `<figure>\n  <img src="${url}" alt="${alt}" />${captionLine}\n</figure>`
    })
  }
  return lines.join('\n')
}

export const imagesToFigure: Command = (view) =>
  applyToSelectionOrAll(view, imagesToFigureText, 'format.images.figure')

                                  
export function dedupFootnoteDefinitionsText(source: string): string {
  const lines = source.split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const m = /^\[\^([^\]]+)\]:\s/.exec(line)
    if (m) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
    }
    out.push(line)
  }
  return out.join('\n')
}

export const dedupFootnoteDefinitions: Command = (view) =>
  applyToSelectionOrAll(view, dedupFootnoteDefinitionsText, 'format.footnotes.dedup')

                               
export function demoteH3ToH4Text(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^### \S/.test(lines[i])) {
      lines[i] = '#' + lines[i]
    }
  }
  return lines.join('\n')
}

export const demoteH3ToH4: Command = (view) =>
  applyToSelectionOrAll(view, demoteH3ToH4Text, 'format.heading.demoteH3')

                                       
export function sortCalloutsByTypeText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^>\s*\[!/.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const blocks: { type: string; body: string[] }[] = []
    while (i < lines.length && /^>\s*\[!/.test(lines[i])) {
      const m = /^>\s*\[!([a-zA-Z]+)\]/.exec(lines[i])
      const type = m?.[1] ?? ''
      const body: string[] = [lines[i]]
      i++
      while (i < lines.length && /^>/.test(lines[i]) && !/^>\s*\[!/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      blocks.push({ type, body })
    }
    blocks.sort((a, b) => a.type.localeCompare(b.type))
    for (const b of blocks) {
      out.push(...b.body)
    }
  }
  return out.join('\n')
}

export const sortCalloutsByType: Command = (view) =>
  applyToSelectionOrAll(view, sortCalloutsByTypeText, 'format.callout.sortByType')

                             
export const insertAttributedQuote: Command = (view) => {
  const text = `\n> Quote text here.\n> — Author · Source\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.attributedQuote',
  })
  return true
}

                               
export const insertMermaidGanttV2: Command = (view) => {
  const text = `\n\`\`\`mermaid\ngantt\n    title Project Milestones\n    dateFormat YYYY-MM-DD\n    section Development\n    Design :a1, 2026-06-01, 7d\n    Implementation :a2, after a1, 14d\n    Testing :a3, after a2, 7d\n    section Launch\n    Deployment :a4, after a3, 2d\n\`\`\`\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.ganttV2',
  })
  return true
}

                                     
export const appendSourceToCurrentParagraph: Command = (view) => {
  const url = window.prompt('Source URL?')
  if (!url) return false
  const state = view.state
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  let endLineNo = line.number
  for (let n = line.number; n <= state.doc.lines; n++) {
    const t = state.doc.line(n).text
    if (t.trim() === '') break
    endLineNo = n
  }
  const endLine = state.doc.line(endLineNo)
  view.dispatch({
    changes: { from: endLine.to, to: endLine.to, insert: ` (source: ${url})` },
    userEvent: 'input.paragraph.appendSource',
  })
  return true
}

                            
export function collapseExtraBlankLinesText(source: string): string {
  return source.replace(/\n{3,}/g, '\n\n')
}

export const collapseExtraBlankLines: Command = (view) =>
  applyToSelectionOrAll(view, collapseExtraBlankLinesText, 'format.lines.collapseBlank')

                           
export const insertNumberedFootnote: Command = (view) => {
  const source = view.state.doc.toString()
  const nums = Array.from(source.matchAll(/\[\^(\d+)\]/g)).map((m) => Number(m[1]))
  const next = nums.length === 0 ? 1 : Math.max(...nums) + 1
  const head = view.state.selection.main.head
  const ref = `[^${next}]`
  const def = `\n\n[^${next}]: TODO\n`
  view.dispatch({
    changes: [
      { from: head, to: head, insert: ref },
      { from: source.length, to: source.length, insert: def },
    ],
    selection: { anchor: head + ref.length },
    userEvent: 'input.insert.numberedFootnote',
  })
  return true
}

                                                    
export const insertCurrentSectionAnchorLink: Command = (view) => {
  const sec = findCurrentSection(view.state)
  if (!sec) return false
  const headingText = view.state.doc.line(sec.headingLineNo).text.replace(/^#+\s+/, '').trim()
  const text = `[[#${headingText}]]`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.sectionAnchor',
  })
  return true
}

                                                                                 
export function refLinksToInlineText(source: string): string {
  const refs = new Map<string, string>()
  const lines = source.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const m = /^\[([^\]]+)\]:\s+(\S+)/.exec(line)
    if (m) {
      refs.set(m[1].toLowerCase(), m[2])
    } else {
      kept.push(line)
    }
  }
  let body = kept.join('\n')
  body = body.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m, text: string, id: string) => {
    const key = (id || text).toLowerCase()
    const url = refs.get(key)
    return url ? `[${text}](${url})` : m
  })
  return body
}

export const refLinksToInline: Command = (view) =>
  applyToSelectionOrAll(view, refLinksToInlineText, 'format.links.refToInline')

                      
export const insertGlossaryTemplate: Command = (view) => {
  const text = `\n## Glossary\n\nTerm 1\n: Definition text. May contain [[related wikilink]].\n\nTerm 2\n: Definition text.\n\nTerm 3\n: Definition text.\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.glossary',
  })
  return true
}

                                              
export function listToMermaidGraphLrText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*- /.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const items: string[] = []
    while (i < lines.length && /^\s*- /.test(lines[i])) {
      const m = /^\s*- (.+)$/.exec(lines[i])
      if (m) items.push(m[1].trim())
      i++
    }
    out.push('```mermaid')
    out.push('graph LR')
    for (let k = 0; k < items.length; k++) {
      const id = `n${k + 1}`
      out.push(`  ${id}["${items[k]}"]`)
      if (k > 0) out.push(`  n${k} --> ${id}`)
    }
    out.push('```')
  }
  return out.join('\n')
}

export const listToMermaidGraphLr: Command = (view) =>
  applyToSelectionOrAll(view, listToMermaidGraphLrText, 'input.list.toGraphLr')

                              
export const insertReviewSchedule: Command = (view) => {
  const now = new Date()
  const days = [1, 3, 7, 14, 30, 90]
  const items = days.map((d) => {
    const t = new Date(now)
    t.setDate(t.getDate() + d)
    return `- [ ] +${d}d: ${t.toISOString().slice(0, 10)}`
  })
  const text = `\n## Review schedule\n\n${items.join('\n')}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.reviewSchedule',
  })
  return true
}

                                                       
export const insertTemplaterVars: Command = (view) => {
  const text = `\n<!-- Templater vars -->\n- date: {{date:YYYY-MM-DD}}\n- title: {{title}}\n- weekday: {{date:dddd}}\n- timestamp: {{date:HH:mm}}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.templaterVars',
  })
  return true
}

                                      
export function normalizeOrderedListStartAtOneText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  let counter = 0
  let prevIndent = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      counter = 0
      prevIndent = -1
      continue
    }
    if (inFence) continue
    const m = /^(\s*)(\d+)\.\s+/.exec(lines[i])
    if (m) {
      const indent = m[1].length
      if (indent !== prevIndent) counter = 0
      counter++
      prevIndent = indent
      lines[i] = lines[i].replace(/^(\s*)\d+\.\s+/, `$1${counter}. `)
    } else if (lines[i].trim() === '') {
      counter = 0
      prevIndent = -1
    } else {
      // non-list non-empty: reset counter
      counter = 0
      prevIndent = -1
    }
  }
  return lines.join('\n')
}

export const normalizeOrderedListStartAtOne: Command = (view) =>
  applyToSelectionOrAll(view, normalizeOrderedListStartAtOneText, 'format.list.olStart1')

                                                    
export const insertAdrTemplate: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n# ADR-XXXX: Decision Title\n\n- Status: Proposed\n- Date: ${today}\n- Deciders: \n\n## Context\n\nDescribe the background and driving factors behind the decision.\n\n## Decision\n\nDescribe the chosen approach.\n\n## Consequences\n\nDescribe the impact of the decision (positive, negative, risks).\n\n## Alternatives considered\n\n- Option A — rationale\n- Option B — rationale\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.adr',
  })
  return true
}

                                                           
export const wrapSelectionAsKbd: Command = (view) => {
  const { from, to } = view.state.selection.main
  if (from === to) {
    const text = '<kbd>Cmd+K</kbd>'
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.wrap.kbd',
    })
    return true
  }
  const sel = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `<kbd>${sel}</kbd>` },
    selection: { anchor: from + 5 + sel.length + 6 },
    userEvent: 'input.wrap.kbd',
  })
  return true
}

                                                          
export function headingMapText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      out.push(`- H${m[1].length} ${m[2]} → [[#${m[2]}]]`)
    }
  }
  return out.join('\n')
}

export const insertHeadingMap: Command = (view) => {
  const source = view.state.doc.toString()
  const map = headingMapText(source)
  const text = `\n## Heading map\n\n${map}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.headingMap',
  })
  return true
}

                              
export function tocWithAnchorsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      const level = m[1].length
      const text = m[2].trim()
      const anchor = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
      out.push(`${'  '.repeat(level - 1)}- [${text}](#${anchor})`)
    }
  }
  return out.join('\n')
}

export const insertTocWithAnchors: Command = (view) => {
  const source = view.state.doc.toString()
  const toc = tocWithAnchorsText(source)
  const text = `\n## Table of contents\n\n${toc}\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.tocAnchors',
  })
  return true
}

                           
export function sortH2SectionsByWordCountDescText(source: string): string {
  const lines = source.split('\n')
  type Sec = { heading: string; body: string[]; words: number }
  const sections: Sec[] = []
  const pre: string[] = []
  let cur: Sec | null = null
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (cur) sections.push(cur)
      cur = { heading: line, body: [], words: 0 }
    } else if (cur) {
      cur.body.push(line)
      cur.words += (line.match(/\S+/g) ?? []).length
    } else {
      pre.push(line)
    }
  }
  if (cur) sections.push(cur)
  sections.sort((a, b) => b.words - a.words)
  const out: string[] = [...pre]
  for (const s of sections) {
    out.push(s.heading)
    out.push(...s.body)
  }
  return out.join('\n')
}

export const sortH2SectionsByWordCountDesc: Command = (view) =>
  applyToSelectionOrAll(view, sortH2SectionsByWordCountDescText, 'format.section.sortWords')

                                        
export function foldH2AsDetailsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inSec = false
  for (const line of lines) {
    const m = /^## (.*)$/.exec(line)
    if (m) {
      if (inSec) {
        out.push('</details>')
      }
      out.push('<details>')
      out.push(`<summary>${m[1]}</summary>`)
      out.push('')
      inSec = true
    } else {
      out.push(line)
    }
  }
  if (inSec) out.push('</details>')
  return out.join('\n')
}

export const foldH2AsDetails: Command = (view) =>
  applyToSelectionOrAll(view, foldH2AsDetailsText, 'format.section.foldDetails')

                         
export function paragraphsToOrderedListText(source: string): string {
  const paras = source.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  return paras.map((p, i) => `${i + 1}. ${p.replace(/\n/g, ' ')}`).join('\n')
}

export const paragraphsToOrderedList: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToOrderedListText, 'format.paragraph.toOl')

                                                  
export const insertLiteratureNoteTemplate: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n---\ntype: literature\nsource: \nauthor: \ndate-read: ${today}\ntags: [literature]\n---\n\n## Quote\n\n> Original excerpt\n\n## Context\n\nBackground.\n\n## My take\n\nMy thoughts.\n\n## Connections\n\n- [[related note]]\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.literatureNote',
  })
  return true
}

                                     
export const insertDailyQuoteReflection: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n## ${today} · Quote & Reflection\n\n### Quote\n\n> \n\n— Author\n\n### Reflection\n\nWhat does this mean to me?\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.quoteReflection',
  })
  return true
}

                                  
export function escapeTableCellPipesText(source: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue
    if (/^\s*\|\s*[-:]+/.test(lines[i])) continue
    const parts = lines[i].split('|')
    for (let j = 1; j < parts.length - 1; j++) {
      // already escaped pipes inside text — leave alone
    }
    // we already split by | so any internal pipe is a separator — nothing to escape at this stage.
    // For practical use, allow user to mark internal pipe before this step.
    // Just normalize known patterns: ` | ` not preceded by `\` should be the separator.
  }
  return lines.join('\n')
}

export const escapeTableCellPipes: Command = (view) =>
  applyToSelectionOrAll(view, escapeTableCellPipesText, 'format.table.escapePipes')

                                            
export function ddmmyyyyToIsoText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_m, d: string, mo: string, y: string) =>
      `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`,
    )
  }
  return lines.join('\n')
}

export const ddmmyyyyToIso: Command = (view) =>
  applyToSelectionOrAll(view, ddmmyyyyToIsoText, 'format.dates.ddmmyyyy')

                            
export function capitalizeHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6}\s+)([a-z])(.*)$/.exec(lines[i])
    if (m) {
      lines[i] = m[1] + m[2].toUpperCase() + m[3]
    }
  }
  return lines.join('\n')
}

export const capitalizeHeadings: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeHeadingsText, 'format.heading.capitalize')

                                     
export const insertReadingProgressBar: Command = (view) => {
  const pctRaw = window.prompt('Reading progress (0-100)?', '50')
  const pct = Math.max(0, Math.min(100, Number(pctRaw ?? '0')))
  if (!Number.isFinite(pct)) return false
  const text = `\n<div style="background:#eee;border-radius:4px;overflow:hidden;height:12px;">\n  <div style="width:${pct}%;background:#5a8;height:100%;"></div>\n</div>\n<small>Progress: ${pct}%</small>\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.progressBar',
  })
  return true
}

                                 
export function smartQuotesToStraightText(source: string): string {
  return source
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

export const smartQuotesToStraight: Command = (view) =>
  applyToSelectionOrAll(view, smartQuotesToStraightText, 'format.quotes.toStraight')

                                         
export const insertCodeSnippetTemplate: Command = (view) => {
  const lang = window.prompt('Language?', 'ts') ?? 'ts'
  const text = `\n### Snippet: Description\n\nPurpose.\n\n\`\`\`${lang}\n// example\n\`\`\`\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.codeSnippet',
  })
  return true
}

                                                
export const tagsToWikilinkInCurrentSection: Command = (view) => {
  const sec = findCurrentSection(view.state)
  if (!sec) return false
  const doc = view.state.doc
  const fromOffset = doc.line(sec.headingLineNo).from
  const toOffset =
    sec.endLineNo === -1 ? doc.line(doc.lines).to : doc.line(sec.endLineNo).from
  const source = doc.sliceString(fromOffset, toOffset)
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (_m, pre: string, tag: string) =>
      `${pre}[[${tag}]]`,
    )
  }
  view.dispatch({
    changes: { from: fromOffset, to: toOffset, insert: lines.join('\n') },
    userEvent: 'input.tags.wikilinkSection',
  })
  return true
}

                                 
export const insertLessonsLearnedTemplate: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n## Lessons learned · ${today}\n\n### What went well\n\n- \n\n### What didn't\n\n- \n\n### What to change next time\n\n- [ ] \n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.lessons',
  })
  return true
}

                           
export function sortListByLengthDescText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*- /.test(lines[i])) {
      out.push(lines[i])
      i++
      continue
    }
    const block: string[] = []
    while (i < lines.length && /^\s*- /.test(lines[i])) {
      block.push(lines[i])
      i++
    }
    block.sort((a, b) => b.length - a.length)
    out.push(...block)
  }
  return out.join('\n')
}

export const sortListByLengthDesc: Command = (view) =>
  applyToSelectionOrAll(view, sortListByLengthDescText, 'format.list.sortLengthDesc')

                            
export const insertSwotAnalysis: Command = (view) => {
  const text = `\n## SWOT analysis\n\n| Strengths | Weaknesses |\n| --- | --- |\n| - <br>- <br>- | - <br>- <br>- |\n\n| Opportunities | Threats |\n| --- | --- |\n| - <br>- <br>- | - <br>- <br>- |\n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.swot',
  })
  return true
}

                                                               
export function asterisksToUnderscoresText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i]
      .replace(/\*\*([^*\n]+)\*\*/g, '__$1__')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1_$2_')
  }
  return lines.join('\n')
}

export const asterisksToUnderscores: Command = (view) =>
  applyToSelectionOrAll(view, asterisksToUnderscoresText, 'format.emphasis.starToUnder')

                                                               
export function underscoresToAsterisksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i]
      .replace(/__([^_\n]+)__/g, '**$1**')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1*$2*')
  }
  return lines.join('\n')
}

export const underscoresToAsterisks: Command = (view) =>
  applyToSelectionOrAll(view, underscoresToAsterisksText, 'format.emphasis.underToStar')

                               
export const insertReleaseNotesTemplate: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = `\n# Release notes · vX.Y.Z · ${today}\n\n## Added\n\n- \n\n## Changed\n\n- \n\n## Fixed\n\n- \n\n## Deprecated\n\n- \n\n## Removed\n\n- \n\n## Security\n\n- \n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.releaseNotes',
  })
  return true
}

                                    
export const insertMocSkeleton: Command = (view) => {
  const text = `\n# MOC — Topic\n\n## Overview\n\nThis MOC collects all notes related to "Topic".\n\n## Core Notes\n\n- [[Core 1]]\n- [[Core 2]]\n- [[Core 3]]\n\n## Subtopics\n\n### Subtopic A\n\n- [[Related Note A1]]\n- [[Related Note A2]]\n\n### Subtopic B\n\n- [[Related Note B1]]\n\n## To Integrate\n\n- [ ] \n\n`
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.insert.moc',
  })
  return true
}

                                                       
export function wikilinkImagesToMdText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(
      /!\[\[([^|\]]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:\|([^\]]+))?\]\]/gi,
      (_m, path: string, alt?: string) => `![${alt ?? ''}](${path})`,
    )
  }
  return lines.join('\n')
}

export const wikilinkImagesToMd: Command = (view) =>
  applyToSelectionOrAll(view, wikilinkImagesToMdText, 'format.images.wikiToMd')

                                                                       
export function mdImagesToWikilinkText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = lines[i].replace(
      /!\[([^\]]*)\]\(([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp))\)/gi,
      (_m, alt: string, path: string) => (alt ? `![[${path}|${alt}]]` : `![[${path}]]`),
    )
  }
  return lines.join('\n')
}

export const mdImagesToWikilink: Command = (view) =>
  applyToSelectionOrAll(view, mdImagesToWikilinkText, 'format.images.mdToWiki')









































export const insertStickyNoteCallout: Command = (view) => {
  const pos = view.state.selection.main.from
  const text = '> [!note] 📌 Sticky note\n> '
  view.dispatch({
    changes: { from: pos, insert: text + '\n' },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sticky-note',
  })
  return true
}

export function sectionLineCountReportText(source: string): string {
  const lines = source.split('\n')
  const sections: { title: string; level: number; count: number }[] = []
  let cur: { title: string; level: number; count: number } | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      if (cur) cur.count++
      continue
    }
    if (inFence) {
      if (cur) cur.count++
      continue
    }
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      cur = { title: m[2].trim(), level: m[1].length, count: 0 }
      sections.push(cur)
      continue
    }
    if (cur) cur.count++
  }
  if (sections.length === 0) return '> [!info] Section line count\n> The document has no headings.\n'
  const lines2: string[] = ['> [!info] section line counts']
  for (const s of sections) {
    const indent = '  '.repeat(s.level - 1)
    lines2.push(`> - ${indent}${s.title}: ${s.count}`)
  }
  return lines2.join('\n') + '\n'
}
export const insertSectionLineCountReport: Command = (view) => {
  const pos = view.state.selection.main.from
  const report = sectionLineCountReportText(view.state.doc.toString())
  view.dispatch({
    changes: { from: pos, insert: '\n' + report + '\n' },
    selection: { anchor: pos + report.length + 2 },
    userEvent: 'insert.section-line-counts',
  })
  return true
}

export const insertSectionTocWikilinks: Command = (view) => {
  const pos = view.state.selection.main.from
  const source = view.state.doc.toString()
  const lines = source.split('\n')
  const items: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (!m) continue
    const indent = '  '.repeat(m[1].length - 1)
    items.push(`${indent}- [[#${m[2].trim()}]]`)
  }
  const block = items.length ? items.join('\n') + '\n' : '- (no headings)\n'
  view.dispatch({
    changes: { from: pos, insert: '\n' + block + '\n' },
    selection: { anchor: pos + block.length + 2 },
    userEvent: 'insert.section-toc-wikilinks',
  })
  return true
}

export function bulletListToBlockquoteText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(line); continue }
    const m = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (m) {
      out.push(`${m[1]}> ${m[2]}`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}
export const bulletListToBlockquote: Command = (view) =>
  applyToSelectionOrAll(view, bulletListToBlockquoteText, 'format.bullet-to-blockquote')

export const insertAnniversaryTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🎉 Anniversary Review',
    '',
    '- Milestone event: ',
    '- Data/milestones: ',
    '- Lessons learned: ',
    '- People to thank: ',
    '- Next year goals: ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.anniversary',
  })
  return true
}

export function normalizeCalloutTypeCaseText(source: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/^(>\s*)\[!([A-Za-z-]+)(.*)\]/, (_m, p, t, rest) => `${p}[!${t.toLowerCase()}${rest}]`)
  }
  return lines.join('\n')
}
export const normalizeCalloutTypeCase: Command = (view) =>
  applyToSelectionOrAll(view, normalizeCalloutTypeCaseText, 'format.callout.normalize-case')

export const insertTodayIPlanTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Today I plan to',
    '',
    '- [ ] ',
    '- [ ] ',
    '- [ ] ',
    '',
    '### Stretch goals',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.today-plan',
  })
  return true
}

export function countFootnotesText(source: string): { defs: number; refs: number } {
  const lines = source.split('\n')
  let defs = 0
  let refs = 0
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^\[\^[^\]]+\]:/.test(line)) {
      defs += 1
      continue
    }
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const matches = masked.match(/\[\^[^\]]+\]/g)
    if (matches) refs += matches.length
  }
  return { defs, refs }
}
export const insertFootnoteCount: Command = (view) => {
  const pos = view.state.selection.main.from
  const { defs, refs } = countFootnotesText(view.state.doc.toString())
  const block = `> [!info] Footnotes: ${refs} references / ${defs} definitions\n`
  view.dispatch({
    changes: { from: pos, insert: '\n' + block + '\n' },
    selection: { anchor: pos + block.length + 2 },
    userEvent: 'insert.footnote-count',
  })
  return true
}

export const insertLicenseFooter: Command = (view) => {
  const text = view.state.doc.toString()
  const end = text.length
  const today = new Date().toISOString().slice(0, 10)
  const block = `\n\n---\n\n*© ${new Date().getFullYear()} Content licensed under CC BY-SA 4.0. Last updated ${today}.*\n`
  view.dispatch({
    changes: { from: end, insert: block },
    selection: { anchor: end + block.length },
    userEvent: 'insert.license-footer',
  })
  return true
}

export function splitLongParagraphAtSentencesText(source: string, maxLen = 200): string {
  const paragraphs = source.split(/\n\n+/)
  const out: string[] = []
  for (const p of paragraphs) {
    if (p.length <= maxLen || /^\s*```/.test(p) || /^[#>\-*+|]/.test(p.trim())) {
      out.push(p)
      continue
    }
    const sentences = p.split(/(?<=\p{Sentence_Terminal})\s+/u)
    if (sentences.length <= 1) {
      out.push(p)
      continue
    }
    out.push(sentences.join('\n'))
  }
  return out.join('\n\n')
}
export const splitLongParagraphAtSentences: Command = (view) =>
  applyToSelectionOrAll(view, (s) => splitLongParagraphAtSentencesText(s), 'format.split-paragraph')

export const insertProsConsTable: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '| Pros | Cons |',
    '| --- | --- |',
    '|  |  |',
    '|  |  |',
    '|  |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.pros-cons',
  })
  return true
}

export const insertHabitChainChecklist: Command = (view) => {
  const pos = view.state.selection.main.from
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const lines = ['## Habit chain — 21 day challenge', '']
  for (let week = 1; week <= 3; week++) {
    lines.push(`### Week ${week}`)
    for (const d of days) lines.push(`- [ ] ${d} `)
    lines.push('')
  }
  const block = lines.join('\n')
  view.dispatch({
    changes: { from: pos, insert: block },
    selection: { anchor: pos + block.length },
    userEvent: 'insert.habit-chain',
  })
  return true
}

export function blockquoteToParagraphText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(line); continue }
    if (/^>\s*\[!/.test(line)) {
      out.push(line)
      continue
    }
    const m = line.match(/^(\s*)>\s?(.*)$/)
    if (m) {
      out.push(`${m[1]}${m[2]}`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}
export const blockquoteToParagraph: Command = (view) =>
  applyToSelectionOrAll(view, blockquoteToParagraphText, 'format.quote-to-paragraph')

export const insertRiskRegister: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🚨 Risk register',
    '',
    '| ID | Risk description | Probability (L/M/H) | Impact (L/M/H) | Mitigation | Owner |',
    '| --- | --- | --- | --- | --- | --- |',
    '| R1 |  |  |  |  |  |',
    '| R2 |  |  |  |  |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.risk-register',
  })
  return true
}

export function sortTableByColumnAscText(source: string, col: number): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|/.test(lines[i])) continue
    // gather contiguous table
    let j = i
    while (j < lines.length && /^\|/.test(lines[j])) j++
    if (j - i < 4) { i = j; continue }
    const header = lines[i]
    const sep = lines[i + 1]
    const body = lines.slice(i + 2, j)
    body.sort((a, b) => {
      const ca = (a.split('|')[col + 1] ?? '').trim()
      const cb = (b.split('|')[col + 1] ?? '').trim()
      return ca.localeCompare(cb, 'en', { numeric: true })
    })
    const newTable = [header, sep, ...body]
    lines.splice(i, j - i, ...newTable)
    i = i + newTable.length
  }
  return lines.join('\n')
}
export const sortTableByColumnAsc = (col: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => sortTableByColumnAscText(s, col), 'format.table.sort-asc')

export const insertDecisionLogRow: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const row = `| ${today} |  |  |  |  |\n`
  view.dispatch({
    changes: { from: pos, insert: row },
    selection: { anchor: pos + row.length },
    userEvent: 'insert.decision-row',
  })
  return true
}

export function snakeCaseHeadingsToTitleCaseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(#{1,6})\s+(.*)$/, (_m, hashes, rest) => {
      const titled = String(rest)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
      return `${hashes} ${titled}`
    })
  }
  return lines.join('\n')
}
export const snakeCaseHeadingsToTitleCase: Command = (view) =>
  applyToSelectionOrAll(view, snakeCaseHeadingsToTitleCaseText, 'format.headings.snake-to-title')

export function paragraphsToOrderedListReversedText(source: string): string {
  const paragraphs = source.split(/\n\n+/).filter((p) => p.trim().length)
  const out: string[] = []
  const total = paragraphs.length
  paragraphs.forEach((p, i) => {
    out.push(`${total - i}. ${p.replace(/\n/g, ' ')}`)
  })
  return out.join('\n')
}
export const paragraphsToOrderedListReversed: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToOrderedListReversedText, 'format.paragraphs-to-ol-reversed')

export const insertOkrTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🎯 OKR',
    '',
    '### Objective',
    '- ',
    '',
    '### Key results',
    '- [ ] KR1: (quantify)',
    '- [ ] KR2: (quantify)',
    '- [ ] KR3: (quantify)',
    '',
    '### Initiatives',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.okr',
  })
  return true
}

export function unifyDashesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^(\s*)[-*+]\s/.test(lines[i])) continue
    if (/^---\s*$/.test(lines[i])) continue
    // collapse double hyphens to em-dash, leave single hyphen alone
    lines[i] = lines[i].replace(/--/g, '—')
  }
  return lines.join('\n')
}
export const unifyDashes: Command = (view) =>
  applyToSelectionOrAll(view, unifyDashesText, 'format.unify-dashes')

export const insertRaciMatrix: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## RACI matrix',
    '',
    '| Task / Role | PM | Eng | Design | QA |',
    '| --- | --- | --- | --- | --- |',
    '| Requirements | R | C | C | I |',
    '| Interface design | C | R | I | I |',
    '| Implementation | A | R | I | C |',
    '| Testing | C | C | I | R |',
    '',
    '> R=Responsible, A=Accountable, C=Consulted, I=Informed',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.raci',
  })
  return true
}

export function normalizeTaskListIndentText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = lines[i].match(/^(\s*)([-*+])\s+\[([ xX/-])\]\s+(.*)$/)
    if (m) {
      const tabs = m[1].replace(/\t/g, '  ').replace(/ {2} +/g, '  ')
      // round indent to nearest 2 spaces
      const depth = Math.round(tabs.length / 2)
      const norm = '  '.repeat(depth)
      lines[i] = `${norm}- [${m[3]}] ${m[4]}`
    }
  }
  return lines.join('\n')
}
export const normalizeTaskListIndent: Command = (view) =>
  applyToSelectionOrAll(view, normalizeTaskListIndentText, 'format.tasks.normalize-indent')

export const insertOneOnOneTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 1:1 — ${today}`,
    '',
    '### Wins',
    '- ',
    '',
    '### Blockers',
    '- ',
    '',
    '### Feedback (two-way)',
    '- ',
    '',
    '### Career / growth',
    '- ',
    '',
    '### Action items',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.one-on-one',
  })
  return true
}

export function nbspInDatesText(source: string): string {
  // Replace space inside common date phrases: "March 5, 2026" → "March 5, 2026"
  return source.replace(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s+(\d{4})\b/g,
    '$1 $2, $3',
  )
}
export const nbspInDates: Command = (view) =>
  applyToSelectionOrAll(view, nbspInDatesText, 'format.nbsp-in-dates')

export function dedupConsecutiveBulletsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let prevBullet: string | null = null
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      prevBullet = null
      continue
    }
    if (inFence) { out.push(line); continue }
    const m = line.match(/^\s*[-*+]\s+(.*)$/)
    if (m) {
      const text = m[1].trim()
      if (prevBullet === text) continue
      prevBullet = text
    } else {
      prevBullet = null
    }
    out.push(line)
  }
  return out.join('\n')
}
export const dedupConsecutiveBullets: Command = (view) =>
  applyToSelectionOrAll(view, dedupConsecutiveBulletsText, 'format.dedup-bullets')

export const insertEisenhowerMatrix: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Eisenhower matrix',
    '',
    '### Urgent + Important (Do)',
    '- [ ] ',
    '',
    '### Important + Not urgent (Schedule)',
    '- [ ] ',
    '',
    '### Urgent + Not important (Delegate)',
    '- [ ] ',
    '',
    '### Not urgent + Not important (Drop)',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.eisenhower',
  })
  return true
}

export function renumberOrderedListFromText(source: string, startAt: number): string {
  const lines = source.split('\n')
  let counter = startAt
  let inFence = false
  let prevWasItem = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; prevWasItem = false; continue }
    if (inFence) { prevWasItem = false; continue }
    const m = lines[i].match(/^(\s*)\d+\.\s+(.*)$/)
    if (m) {
      lines[i] = `${m[1]}${counter}. ${m[2]}`
      counter += 1
      prevWasItem = true
    } else {
      if (prevWasItem) counter = startAt
      prevWasItem = false
    }
  }
  return lines.join('\n')
}
export const renumberOrderedListFrom = (startAt: number): Command => (view) =>
  applyToSelectionOrAll(view, (s) => renumberOrderedListFromText(s, startAt), 'format.renumber-ol')

export function swapInlineLinkTextAndUrlText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => `[${url}](${text})`)
  }
  return lines.join('\n')
}
export const swapInlineLinkTextAndUrl: Command = (view) =>
  applyToSelectionOrAll(view, swapInlineLinkTextAndUrlText, 'format.swap-link')

export const insertDailyGratitudeTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🙏 Gratitude — ${today}`,
    '',
    '1. I am grateful for…',
    '2. I am grateful for…',
    '3. I am grateful for…',
    '',
    '### Best part of today',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.gratitude',
  })
  return true
}

export const insertRecurringExpenseTable: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🔁 Recurring expenses',
    '',
    '| Item | Amount | Frequency | Next charge | Cancel? |',
    '| --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |',
    '|  |  |  |  |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.recurring-expense',
  })
  return true
}

export function headingsToSentenceCaseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(#{1,6})\s+(.+)$/, (_m, h, rest) => {
      const txt = String(rest).toLowerCase()
      const cap = txt.charAt(0).toUpperCase() + txt.slice(1)
      return `${h} ${cap}`
    })
  }
  return lines.join('\n')
}
export const headingsToSentenceCase: Command = (view) =>
  applyToSelectionOrAll(view, headingsToSentenceCaseText, 'format.headings.sentence-case')

export function normalizeWikilinkLowercaseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g, (_m, target, anchor, alias) => {
      const t = String(target).toLowerCase()
      return `[[${t}${anchor ?? ''}${alias ?? ''}]]`
    })
  }
  return lines.join('\n')
}
export const normalizeWikilinkLowercase: Command = (view) =>
  applyToSelectionOrAll(view, normalizeWikilinkLowercaseText, 'format.wikilink.lowercase')

export const insertPomodoroSessionLog: Command = (view) => {
  const pos = view.state.selection.main.from
  const now = new Date()
  const hh = now.getHours().toString().padStart(2, '0')
  const mm = now.getMinutes().toString().padStart(2, '0')
  const line = `- ${hh}:${mm} 🍅 25min: \n`
  view.dispatch({
    changes: { from: pos, insert: line },
    selection: { anchor: pos + line.length - 1 },
    userEvent: 'insert.pomodoro-log',
  })
  return true
}

export const insertWeeklyReviewTemplateV2: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 📅 Weekly review — ${today}`,
    '',
    '### Highlights',
    '- ',
    '',
    '### Wins',
    '- ',
    '',
    '### Misses',
    '- ',
    '',
    '### Lessons',
    '- ',
    '',
    '### Next week priorities',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.weekly-review',
  })
  return true
}

export function orderedListToChecklistTextV2(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*)\d+\.\s+(.*)$/, '$1- [ ] $2')
  }
  return lines.join('\n')
}
export const orderedListToChecklistV2: Command = (view) =>
  applyToSelectionOrAll(view, orderedListToChecklistTextV2, 'format.ol-to-checklist-v2')

export function indentTaskSubtreeText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^(\s*)[-*+]\s+\[/.test(lines[i])) {
      lines[i] = '  ' + lines[i]
    }
  }
  return lines.join('\n')
}
export const indentTaskSubtree: Command = (view) =>
  applyToSelectionOrAll(view, indentTaskSubtreeText, 'format.indent-task-subtree')

export const insertReadingQueueTable: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 📚 Reading queue',
    '',
    '| Title | Author | Source | Priority | Status |',
    '| --- | --- | --- | --- | --- |',
    '|  |  |  | High | 🔵 To read |',
    '|  |  |  | Med | 🟡 In progress |',
    '|  |  |  | Low | ✅ Done |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.reading-queue',
  })
  return true
}

export const insertBugReportTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🐛 Bug report',
    '',
    '### Steps to reproduce',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### Expected behaviour',
    '- ',
    '',
    '### Actual behaviour',
    '- ',
    '',
    '### Environment',
    '- OS: ',
    '- Version: ',
    '',
    '### Logs / screenshots',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.bug-report',
  })
  return true
}

export function capitalizeFirstWordPerSentenceText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^\s*[-*+#>|]/.test(lines[i])) continue
    lines[i] = lines[i].replace(/(^|\p{Sentence_Terminal}\s+)([a-z])/gu, (_m, sep, ch) => sep + (ch as string).toUpperCase())
  }
  return lines.join('\n')
}
export const capitalizeFirstWordPerSentence: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeFirstWordPerSentenceText, 'format.capitalize-sentences')

const STOPWORDS_TITLE = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'as', 'is'])
export function sentenceToTitleCaseText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(#{1,6})\s+(.+)$/, (_m, h, rest) => {
      const words = String(rest).split(/\s+/)
      const titled = words.map((w, idx) => {
        if (idx > 0 && STOPWORDS_TITLE.has(w.toLowerCase())) return w.toLowerCase()
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      }).join(' ')
      return `${h} ${titled}`
    })
  }
  return lines.join('\n')
}
export const sentenceToTitleCase: Command = (view) =>
  applyToSelectionOrAll(view, sentenceToTitleCaseText, 'format.headings.title-case-en')

export const insertTldrAtTop: Command = (view) => {
  const text = view.state.doc.toString()
  // skip over frontmatter
  let insertAt = 0
  const fm = text.match(/^---\n[\s\S]*?\n---\n/)
  if (fm) insertAt = fm[0].length
  const block = '\n## TL;DR\n\n- \n\n'
  view.dispatch({
    changes: { from: insertAt, insert: block },
    selection: { anchor: insertAt + block.length - 3 },
    userEvent: 'insert.tldr-top',
  })
  return true
}

export function sortFrontmatterAliasesTextV2(source: string): string {
  return source.replace(/^---\n([\s\S]*?)\n---/, (_m, body) => {
    const lines = String(body).split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^aliases\s*:/.test(line)) {
        // gather list items
        const start = i
        const items: string[] = []
        i++
        while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
          items.push(lines[i])
          i++
        }
        items.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
        out.push(lines[start], ...items)
      } else {
        out.push(line)
        i++
      }
    }
    return `---\n${out.join('\n')}\n---`
  })
}
export const sortFrontmatterAliasesV2: Command = (view) =>
  applyToSelectionOrAll(view, sortFrontmatterAliasesTextV2, 'format.frontmatter.sort-aliases-v2')

const JOURNAL_PROMPTS = [
  'What am I most grateful for today?',
  'What did I learn today?',
  'If I could redo today, what would I change?',
  'What is my emotional state right now?',
  'What one thing do I most want to move forward tomorrow?',
]
export const insertJournalingPrompts: Command = (view) => {
  const pos = view.state.selection.main.from
  const lines = ['## 📓 Journaling prompts', '']
  for (const p of JOURNAL_PROMPTS) {
    lines.push(`### ${p}`, '- ', '')
  }
  const block = lines.join('\n')
  view.dispatch({
    changes: { from: pos, insert: block },
    selection: { anchor: pos + block.length },
    userEvent: 'insert.journal-prompts',
  })
  return true
}

export function normalizeCalloutIndentText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^((?:>\s*)+)(.*)$/, (_m, prefix, rest) => {
      const depth = (String(prefix).match(/>/g) ?? []).length
      return '>'.repeat(depth) + ' ' + String(rest)
    })
  }
  return lines.join('\n')
}
export const normalizeCalloutIndent: Command = (view) =>
  applyToSelectionOrAll(view, normalizeCalloutIndentText, 'format.callout.normalize-indent')

export const insertDesignDocTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Design document',
    '',
    '### Background',
    '- ',
    '',
    '### Goals / Non-goals',
    '- Goal: ',
    '- Non-goal: ',
    '',
    '### Approach',
    '- ',
    '',
    '### Trade-offs',
    '- ',
    '',
    '### Risks',
    '- ',
    '',
    '### Milestones',
    '- [ ] ',
    '',
    '### Open questions',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.design-doc',
  })
  return true
}

export function paragraphToNumberedFootnoteText(source: string): string {
  // Convert each paragraph to format: `text [^N]` and append `[^N]: ` footnote defs
  const paragraphs = source.split(/\n\n+/)
  const out: string[] = []
  const defs: string[] = []
  let n = 1
  for (const p of paragraphs) {
    const trimmed = p.trim()
    if (!trimmed || /^[#>\-*+|`]/.test(trimmed)) {
      out.push(p)
      continue
    }
    out.push(`${p} [^${n}]`)
    defs.push(`[^${n}]: `)
    n += 1
  }
  if (defs.length === 0) return source
  return out.join('\n\n') + '\n\n' + defs.join('\n')
}
export const paragraphToNumberedFootnote: Command = (view) =>
  applyToSelectionOrAll(view, paragraphToNumberedFootnoteText, 'format.paragraph-to-footnote')

export const insertInvestingJournalEntry: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 💰 Investing entry — ${today}`,
    '',
    '- Ticker: ',
    '- Direction: Buy / Sell / Hold',
    '- Position change: ',
    '- Thesis: ',
    '- Risk / stop-loss: ',
    '- Retrospective: ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.investing-entry',
  })
  return true
}

export const insertCornellNotesLayout: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 📝 Cornell notes',
    '',
    '| Cues | Notes |',
    '| --- | --- |',
    '|  |  |',
    '|  |  |',
    '|  |  |',
    '',
    '### Summary',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.cornell',
  })
  return true
}

export function massRenameWikilinkTargetText(source: string, from: string, to: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g, (m, target, anchor, alias) => {
      if (String(target).trim() !== from) return m
      return `[[${to}${anchor ?? ''}${alias ?? ''}]]`
    })
  }
  return lines.join('\n')
}
export const massRenameWikilinkTarget = (from: string, to: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => massRenameWikilinkTargetText(s, from, to), 'format.wikilink.rename-target')

export const insertApiEndpointTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## API endpoint',
    '',
    '### Request',
    '',
    '```http',
    'POST /api/v1/resource',
    'Content-Type: application/json',
    '',
    '{ }',
    '```',
    '',
    '### Response',
    '',
    '```json',
    '{',
    '  "ok": true',
    '}',
    '```',
    '',
    '### Errors',
    '',
    '| Status | Reason |',
    '| --- | --- |',
    '| 400 |  |',
    '| 401 |  |',
    '| 500 |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.api-endpoint',
  })
  return true
}

export function foldBulletSubitemsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; out.push(lines[i]); continue }
    if (inFence) { out.push(lines[i]); continue }
    const m = lines[i].match(/^([-*+])\s+(.*)$/)
    if (m) {
      out.push(lines[i])
      // collect indented sub-items and skip them
      let j = i + 1
      while (j < lines.length && /^\s+[-*+]\s/.test(lines[j])) j++
      i = j - 1
    } else {
      out.push(lines[i])
    }
  }
  return out.join('\n')
}
export const foldBulletSubitems: Command = (view) =>
  applyToSelectionOrAll(view, foldBulletSubitemsText, 'format.fold-bullet-subitems')

export const insertHabitTrackerMonthGrid: Command = (view) => {
  const pos = view.state.selection.main.from
  const lines = ['## Habit tracker — monthly grid', '']
  const headerCells = ['Habit']
  for (let d = 1; d <= 31; d++) headerCells.push(String(d))
  lines.push('| ' + headerCells.join(' | ') + ' |')
  lines.push('| ' + headerCells.map(() => '---').join(' | ') + ' |')
  const habits = ['Exercise', 'Reading', 'Meditation', 'Writing']
  for (const h of habits) {
    const cells = [h, ...Array.from({ length: 31 }, () => ' ')]
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  lines.push('')
  const block = lines.join('\n')
  view.dispatch({
    changes: { from: pos, insert: block },
    selection: { anchor: pos + block.length },
    userEvent: 'insert.habit-month-grid',
  })
  return true
}

export function extractInlineUrlsText(source: string): string {
  const urls = new Set<string>()
  const lines = source.split('\n')
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    const matches = masked.match(/https?:\/\/[^\s)\]]+/g)
    if (matches) for (const u of matches) urls.add(u)
  }
  if (urls.size === 0) return source
  return source + '\n\n## URLs\n' + Array.from(urls).map((u) => `- ${u}`).join('\n') + '\n'
}
export const extractInlineUrls: Command = (view) =>
  applyToSelectionOrAll(view, extractInlineUrlsText, 'format.extract-urls')

export const insertMeetingAgendaTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 📋 Meeting agenda — ${today}`,
    '',
    '- Facilitator: ',
    '- Duration: ',
    '- Attendees: ',
    '',
    '### Agenda',
    '1. (5min) ',
    '2. (10min) ',
    '3. (10min) ',
    '',
    '### Decisions',
    '- ',
    '',
    '### Action items',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.meeting-agenda',
  })
  return true
}

export function sortListByFirstEmojiText(source: string): string {
  const emojiRe = /^\s*[-*+]\s+(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*[-*+]\s+/.test(lines[i])) { out.push(lines[i]); i++; continue }
    let j = i
    while (j < lines.length && /^\s*[-*+]\s+/.test(lines[j])) j++
    const group = lines.slice(i, j)
    group.sort((a, b) => {
      const ea = emojiRe.exec(a)?.[1] ?? '￿'
      const eb = emojiRe.exec(b)?.[1] ?? '￿'
      return ea.localeCompare(eb)
    })
    out.push(...group)
    i = j
  }
  return out.join('\n')
}
export const sortListByFirstEmoji: Command = (view) =>
  applyToSelectionOrAll(view, sortListByFirstEmojiText, 'format.sort-list-by-emoji')

export const insertPostmortemTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 💥 Postmortem — ${today}`,
    '',
    '### Summary',
    '- Impact scope: ',
    '- Duration: ',
    '- Severity: ',
    '',
    '### Timeline',
    '- HH:MM — ',
    '- HH:MM — ',
    '',
    '### Root cause',
    '- ',
    '',
    '### Mitigation / Fix',
    '- ',
    '',
    '### Prevention',
    '- [ ] ',
    '',
    '### Lessons learned (blameless)',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.postmortem',
  })
  return true
}

export function tableToCsvWithHeaderText(source: string): string {
  const lines = source.split('\n')
  const csvBlocks: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\|/.test(lines[i])) { i++; continue }
    let j = i
    while (j < lines.length && /^\|/.test(lines[j])) j++
    if (j - i < 3) { i = j; continue }
    const rows = lines.slice(i, j).filter((_l, idx) => idx !== 1)
    const csvRows = rows.map((row) => {
      const cells = row.split('|').slice(1, -1).map((c) => c.trim())
      return cells.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')
    })
    csvBlocks.push('```csv\n' + csvRows.join('\n') + '\n```')
    lines.splice(i, j - i, ...csvBlocks[csvBlocks.length - 1].split('\n'))
    i += csvBlocks[csvBlocks.length - 1].split('\n').length
  }
  return lines.join('\n')
}
export const tableToCsvWithHeader: Command = (view) =>
  applyToSelectionOrAll(view, tableToCsvWithHeaderText, 'format.table-to-csv')

function getIsoWeekNumber(d: Date): number {
  const target = new Date(d.valueOf())
  const dayNr = (d.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = target.valueOf()
  target.setUTCMonth(0, 1)
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7)
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000)
}
export const insertWeeklyHabitTableByISOWeek: Command = (view) => {
  const pos = view.state.selection.main.from
  const now = new Date()
  const wk = getIsoWeekNumber(now)
  const lines = [
    `## Habits — W${wk}`,
    '',
    '| Habit | Mon | Tue | Wed | Thu | Fri | Sat | Sun |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Exercise |  |  |  |  |  |  |  |',
    '| Reading |  |  |  |  |  |  |  |',
    '| Meditation |  |  |  |  |  |  |  |',
    '',
  ]
  const block = lines.join('\n')
  view.dispatch({
    changes: { from: pos, insert: block },
    selection: { anchor: pos + block.length },
    userEvent: 'insert.weekly-habit-iso',
  })
  return true
}

export const selectionToSnakeCase: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const snake = text
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s\-]+/g, '_')
    .toLowerCase()
  view.dispatch({
    changes: { from, to, insert: snake },
    selection: { anchor: from, head: from + snake.length },
    userEvent: 'format.snake-case',
  })
  return true
}

export const insertArchitectureSketchPlaceholder: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '```mermaid',
    'graph TD',
    '  Client -->|HTTP| API',
    '  API --> Cache',
    '  API --> DB[(Postgres)]',
    '  API --> Queue[[RabbitMQ]]',
    '  Queue --> Worker',
    '```',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.arch-sketch',
  })
  return true
}

export function removeBrokenInlineLinksText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    // [text](   ) or [text]() → leave just the text
    lines[i] = lines[i].replace(/\[([^\]]+)\]\(\s*\)/g, '$1')
  }
  return lines.join('\n')
}
export const removeBrokenInlineLinks: Command = (view) =>
  applyToSelectionOrAll(view, removeBrokenInlineLinksText, 'format.remove-broken-links')

export const insertExperimentLogEntry: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🧪 Experiment — ${today}`,
    '',
    '- Hypothesis: ',
    '- Design: A vs B',
    '- Metric: ',
    '- Duration: ',
    '- Result: ',
    '- Conclusion: Significant / Not significant / Pending',
    '- Follow-up: ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.experiment',
  })
  return true
}

export function wrapBulletsInQuotesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*[-*+]\s+)(.*)$/, (_m, prefix, rest) => {
      const r = String(rest)
      if (r.startsWith('"') && r.endsWith('"')) return `${prefix}${r}`
      return `${prefix}"${r}"`
    })
  }
  return lines.join('\n')
}
export const wrapBulletsInQuotes: Command = (view) =>
  applyToSelectionOrAll(view, wrapBulletsInQuotesText, 'format.wrap-bullets-in-quotes')

export const insertReleaseChecklist: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🚢 Release checklist',
    '',
    '### Pre-release',
    '- [ ] CHANGELOG updated',
    '- [ ] Version bumped',
    '- [ ] All PRs merged',
    '- [ ] Tests passing (unit / integration / e2e)',
    '',
    '### Release',
    '- [ ] Tag created',
    '- [ ] Artifacts built successfully',
    '- [ ] Published to store / registry',
    '',
    '### Post-release',
    '- [ ] Release notes posted to channel',
    '- [ ] Monitor dashboard for 24h',
    '- [ ] Feedback channel open',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.release-checklist',
  })
  return true
}

export function prefixAllBulletsText(source: string, prefix: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*)([-*+])\s+(.*)$/, (_m, indent, bullet, rest) => `${indent}${bullet} ${prefix}${rest}`)
  }
  return lines.join('\n')
}
export const prefixAllBullets = (prefix: string): Command => (view) =>
  applyToSelectionOrAll(view, (s) => prefixAllBulletsText(s, prefix), 'format.prefix-bullets')

export function lineNumbersAsCommentsText(source: string): string {
  const lines = source.split('\n')
  const width = String(lines.length).length
  return lines.map((l, i) => `<!--L${String(i + 1).padStart(width, '0')}--> ${l}`).join('\n')
}
export const lineNumbersAsComments: Command = (view) =>
  applyToSelectionOrAll(view, lineNumbersAsCommentsText, 'format.line-numbers-comments')

export const insertHabitsYesterdayTodayDiff: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date()
  const yesterday = new Date(today.valueOf() - 86400000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const tpl = [
    '## 📈 Yesterday → Today',
    '',
    `### ${fmt(yesterday)}`,
    '- ',
    '',
    `### ${fmt(today)}`,
    '- ',
    '',
    '### Δ Diff',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.habits-y-t-diff',
  })
  return true
}

export const insertRfcTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `# RFC: <title> (${today})`,
    '',
    '> Status: draft | review | accepted | rejected',
    '',
    '## Background',
    '- ',
    '',
    '## Motivation',
    '- ',
    '',
    '## Proposal',
    '- ',
    '',
    '## Alternatives considered',
    '- ',
    '',
    '## Drawbacks',
    '- ',
    '',
    '## Open questions',
    '- ',
    '',
    '## Adoption / migration',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.rfc',
  })
  return true
}

export function expandTabIndentToSpacesText(source: string, spacesPerTab = 2): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^\t+/, (t) => ' '.repeat(t.length * spacesPerTab))
  }
  return lines.join('\n')
}
export const expandTabIndentToSpaces = (n = 2): Command => (view) =>
  applyToSelectionOrAll(view, (s) => expandTabIndentToSpacesText(s, n), 'format.expand-tabs')

export function replaceFirstHeadingWithFrontmatterTitleText(source: string): string {
  const fm = source.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return source
  const titleMatch = fm[1].match(/(?:^|\n)title\s*:\s*(.+)/)
  if (!titleMatch) return source
  const title = titleMatch[1].trim().replace(/^["']|["']$/g, '')
  return source.replace(/^(---\n[\s\S]*?\n---\n)([\s\S]*?)(^#\s+[^\n]+)/m, (_m, fmBlock, gap, _h1) => `${fmBlock}${gap}# ${title}`)
}
export const replaceFirstHeadingWithFrontmatterTitle: Command = (view) =>
  applyToSelectionOrAll(view, replaceFirstHeadingWithFrontmatterTitleText, 'format.heading-from-frontmatter-title')

export const insertDecisionTreeMermaid: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '```mermaid',
    'graph TD',
    '  Q{Decision?}',
    '  Q -->|Yes| A1[Action A]',
    '  Q -->|No| Q2{Condition?}',
    '  Q2 -->|true| A2[Action B]',
    '  Q2 -->|false| A3[Action C]',
    '```',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.decision-tree',
  })
  return true
}

export const insertMoodScalePicker: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Mood',
    '',
    '- [ ] 1 😞 Very bad',
    '- [ ] 2 😕 Bad',
    '- [ ] 3 😐 Okay',
    '- [ ] 4 🙂 Good',
    '- [ ] 5 😄 Great',
    '',
    'Cause / trigger:',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.mood-scale',
  })
  return true
}

export function isoDatesToDottedText(source: string): string {
  return source.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$1.$2.$3')
}
export const isoDatesToDotted: Command = (view) =>
  applyToSelectionOrAll(view, isoDatesToDottedText, 'format.iso-to-dotted')

export const insertPremortemTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🔮 Pre-mortem',
    '',
    '> Imagine the project fails completely in N months. Working backward from failure, what can we do now?',
    '',
    '### 1. Failure scenarios (worst 3)',
    '- ',
    '- ',
    '- ',
    '',
    '### 2. Root causes (one per assumption)',
    '- ',
    '',
    '### 3. Preventive measures',
    '- [ ] ',
    '',
    '### 4. Early warning signals (metrics to monitor)',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.premortem',
  })
  return true
}

export const selectionSnakeToCamelCase: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const camel = text.replace(/_(\w)/g, (_m, c) => (c as string).toUpperCase())
  view.dispatch({
    changes: { from, to, insert: camel },
    selection: { anchor: from, head: from + camel.length },
    userEvent: 'format.snake-to-camel',
  })
  return true
}

export const insertSupportEscalationMatrix: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Support escalation matrix',
    '',
    '| Level | Trigger | Response time | Owner | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| L1 | Degraded user experience | < 4h | OnCall | Business hours only |',
    '| L2 | Partial feature unavailability | < 1h | Team lead | 24/7 |',
    '| L3 | Full site down / data at risk | Immediate | All hands | Bridge + escalate |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.support-escalation',
  })
  return true
}

export function reverseAdjacentBulletsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s*[-*+]\s+/.test(lines[i])) { out.push(lines[i]); i++; continue }
    let j = i
    while (j < lines.length && /^\s*[-*+]\s+/.test(lines[j])) j++
    out.push(...lines.slice(i, j).reverse())
    i = j
  }
  return out.join('\n')
}
export const reverseAdjacentBullets: Command = (view) =>
  applyToSelectionOrAll(view, reverseAdjacentBulletsText, 'format.reverse-bullets')

export const insertTeamStandupTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🧍 Standup — ${today}`,
    '',
    '### Yesterday',
    '- ',
    '',
    '### Today',
    '- ',
    '',
    '### Blockers',
    '- ',
    '',
    '### Shoutouts',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.standup',
  })
  return true
}

export const escapeMarkdownInSelection: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const escaped = text.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, (c) => `\\${c}`)
  view.dispatch({
    changes: { from, to, insert: escaped },
    selection: { anchor: from, head: from + escaped.length },
    userEvent: 'format.escape-markdown',
  })
  return true
}

export const insertBurndownPlaceholder: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '```mermaid',
    'xychart-beta',
    '  title "Sprint burndown"',
    '  x-axis [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10]',
    '  y-axis "Remaining points" 0 --> 40',
    '  line [40, 36, 32, 28, 25, 21, 17, 12, 7, 0]',
    '  line [40, 36, 32, 28, 24, 20, 16, 12, 8, 4]',
    '```',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.burndown',
  })
  return true
}

export const insertLinkedOutlineForSelection: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const titles = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (titles.length === 0) return false
  const block = titles.map((t) => `- [[${t}]]`).join('\n') + '\n'
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length },
    userEvent: 'format.linked-outline',
  })
  return true
}

export function dedupAdjacentIdenticalLinesText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let prev: string | null = null
  for (const line of lines) {
    if (line === prev) continue
    out.push(line)
    prev = line
  }
  return out.join('\n')
}
export const dedupAdjacentIdenticalLines: Command = (view) =>
  applyToSelectionOrAll(view, dedupAdjacentIdenticalLinesText, 'format.dedup-identical-lines')

export const insertOkrWeeklyCheckin: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## OKR weekly check-in',
    '',
    '| Key result | Last week | This week | Δ | Confidence (0-1) | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |  |',
    '|  |  |  |  |  |  |',
    '',
    '### Top risks',
    '- ',
    '',
    '### Asks',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.okr-weekly',
  })
  return true
}

export function paragraphsToDashListText(source: string): string {
  const parts = source.split(/\n\n+/)
  const out: string[] = []
  for (const p of parts) {
    const trimmed = p.trim()
    if (!trimmed || /^[#>\-*+|`]/.test(trimmed)) {
      out.push(p)
      continue
    }
    out.push(trimmed.split('\n').map((l) => `- ${l}`).join('\n'))
  }
  return out.join('\n\n')
}
export const paragraphsToDashList: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToDashListText, 'format.paragraphs-to-dash-list')

export const insertCostBenefitTable: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Cost-benefit analysis',
    '',
    '| Option | Cost ($/h) | Benefit | ROI | Score (1-5) | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    '| A |  |  |  |  |  |',
    '| B |  |  |  |  |  |',
    '| C |  |  |  |  |  |',
    '',
    '### Recommendation',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.cost-benefit',
  })
  return true
}

export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}
export const slugifySelection: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const slug = slugifyText(text)
  view.dispatch({
    changes: { from, to, insert: slug },
    selection: { anchor: from, head: from + slug.length },
    userEvent: 'format.slugify',
  })
  return true
}

export const insertJournalWeeklySummary: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 📔 Weekly summary',
    '',
    '### Highlights',
    '- ',
    '',
    '### Insights',
    '- ',
    '',
    '### Books / articles',
    '- [[]]',
    '',
    '### People',
    '- [[]]',
    '',
    '### Mood (avg /5)',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.journal-weekly',
  })
  return true
}

export function setextToAtxHeadingsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; out.push(lines[i]); continue }
    if (inFence) { out.push(lines[i]); continue }
    if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1]) && lines[i].trim()) {
      out.push(`# ${lines[i].trim()}`)
      i++
      continue
    }
    if (i + 1 < lines.length && /^-+\s*$/.test(lines[i + 1]) && lines[i].trim() && !/^\s*[-*+]\s/.test(lines[i])) {
      out.push(`## ${lines[i].trim()}`)
      i++
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}
export const setextToAtxHeadings: Command = (view) =>
  applyToSelectionOrAll(view, setextToAtxHeadingsText, 'format.setext-to-atx')

export const insertSprintRetroTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🪞 Sprint retro',
    '',
    '### 🎉 What went well',
    '- ',
    '',
    '### 🌧️ What didn\'t',
    '- ',
    '',
    '### 💡 Ideas to try',
    '- ',
    '',
    '### 🎬 Action items',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.retro',
  })
  return true
}

export function paragraphsToMermaidMindmapText(source: string): string {
  const paragraphs = source.split(/\n\n+/).filter((p) => p.trim())
  if (paragraphs.length === 0) return source
  const lines = ['```mermaid', 'mindmap', '  root((mind))']
  for (const p of paragraphs) {
    const first = p.split('\n')[0].trim().slice(0, 60)
    lines.push(`    ${first}`)
  }
  lines.push('```', '')
  return lines.join('\n')
}
export const paragraphsToMermaidMindmap: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToMermaidMindmapText, 'format.paragraphs-to-mindmap')

export const insertLinkedinPostOutline: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## LinkedIn post outline',
    '',
    '### 1. Hook (first 2 lines, no fluff)',
    '> ',
    '',
    '### 2. Context',
    '- ',
    '',
    '### 3. Story / data',
    '- ',
    '',
    '### 4. Takeaway',
    '- ',
    '',
    '### 5. CTA',
    '- ',
    '',
    '### Tags',
    '#productivity #engineering ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.linkedin-outline',
  })
  return true
}

export const commentOutSelection: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const wrapped = `<!-- ${text} -->`
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: { anchor: from + wrapped.length },
    userEvent: 'format.comment-out',
  })
  return true
}

export const insertReleaseArtifactChecklist: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Release artifacts',
    '',
    '- [ ] macOS dmg (arm64)',
    '- [ ] macOS dmg (x64)',
    '- [ ] Windows exe (x64)',
    '- [ ] Windows zip (x64)',
    '- [ ] Linux deb (amd64)',
    '- [ ] Linux AppImage (amd64)',
    '- [ ] Source tarball',
    '- [ ] Checksums (SHA256)',
    '- [ ] Signed (GPG / EV cert)',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.release-artifacts',
  })
  return true
}

export function tasksToWikilinkInTasksSectionText(source: string): string {
                                                                                                   
  const lines = source.split('\n')
  let inFence = false
  let inTasksSection = false
  let sectionLevel = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const h = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      const level = h[1].length
      const title = h[2].toLowerCase()
      if (inTasksSection && level <= sectionLevel) inTasksSection = false
      if (/task|todo/i.test(title)) {
        inTasksSection = true
        sectionLevel = level
      }
      continue
    }
    if (!inTasksSection) continue
    lines[i] = lines[i].replace(/^(\s*[-*+]\s+\[\s*\]\s+)(\S[^[]*)$/, (_m, prefix, text) => `${prefix}[[${String(text).trim()}]]`)
  }
  return lines.join('\n')
}
export const tasksToWikilinkInTasksSection: Command = (view) =>
  applyToSelectionOrAll(view, tasksToWikilinkInTasksSectionText, 'format.tasks-to-wikilink')

export const insertWeeklyMetricReview: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 📊 Weekly metrics',
    '',
    '| Metric | Goal | Last week | This week | Δ |',
    '| --- | --- | --- | --- | --- |',
    '| MAU |  |  |  |  |',
    '| Revenue |  |  |  |  |',
    '| Churn |  |  |  |  |',
    '| NPS |  |  |  |  |',
    '',
    '### Why',
    '- ',
    '',
    '### Actions',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.weekly-metrics',
  })
  return true
}

export function sortSectionsByHeadingTitleText(source: string): string {
  const lines = source.split('\n')
  const fmMatch = source.match(/^---\n[\s\S]*?\n---\n/)
  const startLine = fmMatch ? fmMatch[0].split('\n').length - 1 : 0
  // Capture top-level h2 sections only (## )
  const sections: { title: string; from: number; to: number }[] = []
  let curStart = -1
  let curTitle = ''
  let inFence = false
  for (let i = startLine; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##\s+/.test(lines[i])) {
      if (curStart !== -1) sections.push({ title: curTitle, from: curStart, to: i })
      curStart = i
      curTitle = lines[i].replace(/^##\s+/, '').trim()
    }
  }
  if (curStart !== -1) sections.push({ title: curTitle, from: curStart, to: lines.length })
  if (sections.length < 2) return source
  const head = lines.slice(0, sections[0].from)
  sections.sort((a, b) => a.title.localeCompare(b.title))
  const out = [...head]
  for (const sec of sections) out.push(...lines.slice(sec.from, sec.to))
  return out.join('\n')
}
export const sortSectionsByHeadingTitle: Command = (view) =>
  applyToSelectionOrAll(view, sortSectionsByHeadingTitleText, 'format.sort-sections-by-title')

export const insertDecisionMatrix: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Decision matrix',
    '',
    '| Option | Criterion 1 (x2) | Criterion 2 (x3) | Criterion 3 (x1) | Total |',
    '| --- | --- | --- | --- | --- |',
    '| A |  |  |  |  |',
    '| B |  |  |  |  |',
    '| C |  |  |  |  |',
    '',
    '> Total = Σ(score × weight)',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.decision-matrix',
  })
  return true
}

export const splitSelectionToBulletsBySentences: Command = (view) => {
  const { state } = view
  const { from, to } = state.selection.main
  if (from === to) return false
  const text = state.sliceDoc(from, to)
  const parts = text.split(/(?<=\p{Sentence_Terminal})\s+/u).filter(Boolean)
  if (parts.length < 2) return false
  const block = parts.map((s) => `- ${s.trim()}`).join('\n')
  view.dispatch({
    changes: { from, to, insert: block },
    selection: { anchor: from + block.length },
    userEvent: 'format.split-selection-to-bullets',
  })
  return true
}

export const insertListenedToTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🎧 Listened to — ${today}`,
    '',
    '| Type | Name | Author / Speaker | Duration | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| podcast |  |  |  |  |',
    '| audiobook |  |  |  |  |',
    '| talk |  |  |  |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.listened-to',
  })
  return true
}

export const insertCustomerInterviewTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🗣️ Customer interview — ${today}`,
    '',
    '- Interviewee: ',
    '- Role / Company: ',
    '- Channel: ',
    '',
    '### Goals / jobs-to-be-done',
    '- ',
    '',
    '### Current workflow',
    '- ',
    '',
    '### Pain points',
    '- ',
    '',
    '### Existing alternatives',
    '- ',
    '',
    '### Quotes',
    '> ',
    '',
    '### Follow-ups',
    '- [ ] ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.customer-interview',
  })
  return true
}

export const insertFiveWhysTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## 🤔 5 Whys',
    '',
    '**Problem:** ',
    '',
    '1. Why? — ',
    '2. Why? — ',
    '3. Why? — ',
    '4. Why? — ',
    '5. Why? — ',
    '',
    '**Root cause:** ',
    '',
    '**Countermeasure:** ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.5-whys',
  })
  return true
}

export function paragraphsToFishboneMermaidText(source: string): string {
  const paragraphs = source.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const lines = ['```mermaid', 'graph LR', '  Problem((Problem))']
  let n = 0
  for (const p of paragraphs.slice(0, 6)) {
    const head = p.split('\n')[0].slice(0, 40).replace(/"/g, "'")
    const id = `C${n++}`
    lines.push(`  ${id}["${head}"] --> Problem`)
    // Treat following lines as sub-branches
    const rest = p.split('\n').slice(1)
    let s = 0
    for (const sub of rest) {
      const subText = sub.replace(/^[\s\-*+]+/, '').slice(0, 40).replace(/"/g, "'")
      if (!subText) continue
      lines.push(`  ${id}${s}["${subText}"] --> ${id}`)
      s++
    }
  }
  lines.push('```', '')
  return lines.join('\n')
}
export const paragraphsToFishboneMermaid: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFishboneMermaidText, 'format.fishbone')

export function normalizeBulletTrailingPunctuationText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*[-*+]\s+.+?)[.;,]+\s*$/, '$1')
  }
  return lines.join('\n')
}
export const normalizeBulletTrailingPunctuation: Command = (view) =>
  applyToSelectionOrAll(view, normalizeBulletTrailingPunctuationText, 'format.bullets.strip-trailing-punct')

export const insertInfoboxTable: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '> [!info]+ Infobox',
    '>',
    '> | Field | Value |',
    '> | --- | --- |',
    '> | Name |  |',
    '> | Type |  |',
    '> | Date |  |',
    '> | Location |  |',
    '> | Source |  |',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.infobox',
  })
  return true
}

export function foldCalloutsToSummaryText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  let inFence = false
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; out.push(lines[i]); i++; continue }
    if (inFence) { out.push(lines[i]); i++; continue }
    const m = lines[i].match(/^>\s*\[!([A-Za-z-]+)\]([+-]?)\s*(.*)$/)
    if (m) {
      const title = m[3] || m[1]
      out.push(`> [!${m[1]}]- ${title}`)
      // skip rest of callout body
      let j = i + 1
      while (j < lines.length && /^>/.test(lines[j])) j++
      i = j
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}
export const foldCalloutsToSummary: Command = (view) =>
  applyToSelectionOrAll(view, foldCalloutsToSummaryText, 'format.callout.fold-summary')

export const insertKanban4Cols: Command = (view) => {
  const pos = view.state.selection.main.from
  const tpl = [
    '## Kanban',
    '',
    '### 📋 Backlog',
    '- ',
    '',
    '### 🛠️ In progress',
    '- ',
    '',
    '### 🔎 Review',
    '- ',
    '',
    '### ✅ Done',
    '- ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.kanban-4',
  })
  return true
}

export function atxHeadingsToBoldParagraphText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^#{1,6}\s+(.+)$/, '**$1**')
  }
  return lines.join('\n')
}
export const atxHeadingsToBoldParagraph: Command = (view) =>
  applyToSelectionOrAll(view, atxHeadingsToBoldParagraphText, 'format.headings-to-bold')

export const insertAsyncStandupTemplate: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 🤖 Async standup — ${today}`,
    '',
    '- 🎯 Focus today: ',
    '- 🚧 Blocker: ',
    '- 🤝 Need help with: ',
    '- 📝 Notes (optional): ',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.async-standup',
  })
  return true
}

export const insertReadingSessionLog: Command = (view) => {
  const pos = view.state.selection.main.from
  const today = new Date().toISOString().slice(0, 10)
  const tpl = [
    `## 📖 Reading session — ${today}`,
    '',
    '- 📕 Book: ',
    '- 🕐 Time: 25min',
    '- 📍 Page range: – ',
    '- ⭐ Rating: /5',
    '- 💡 Key insight: ',
    '- 🔗 Linked: [[]]',
    '',
  ].join('\n')
  view.dispatch({
    changes: { from: pos, insert: tpl },
    selection: { anchor: pos + tpl.length },
    userEvent: 'insert.reading-session',
  })
  return true
}

export function duplicateParagraphsReportText(source: string): string {
  const paragraphs = source.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  const counts = new Map<string, number>()
  for (const p of paragraphs) {
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const dups: string[] = []
  for (const [p, n] of counts.entries()) {
    if (n > 1) dups.push(`- (${n}x) ${p.slice(0, 80).replace(/\n/g, ' ⏎ ')}`)
  }
  if (dups.length === 0) return source
  return source + '\n\n## ⚠️ Duplicated paragraphs\n' + dups.join('\n') + '\n'
}
export const insertDuplicateParagraphsReport: Command = (view) =>
  applyToSelectionOrAll(view, duplicateParagraphsReportText, 'format.dup-paragraph-report')

export const insertSbarTemplate: Command = (view) => {
  const text = [
    '## SBAR Handoff',
    '- **Situation**: ',
    '- **Background**: ',
    '- **Assessment**: ',
    '- **Recommendation**: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sbar',
  })
  return true
}

export const insertWeeklyExperimentReview: Command = (view) => {
  const today = new Date()
  const iso = today.toISOString().slice(0, 10)
  const text = [
    `## Weekly experiment review — ${iso}`,
    '',
    '| Experiment | Hypothesis | Result | Decision |',
    '|---|---|---|---|',
    '|  |  |  |  |',
    '',
    '### Learnings',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.exp-review',
  })
  return true
}

export function paragraphsToNumberedQaText(source: string): string {
  const blocks = source.split(/\n{2,}/)
  const out: string[] = []
  let n = 1
  for (const blk of blocks) {
    const trimmed = blk.trim()
    if (!trimmed) continue
    out.push(`**Q${n}**: ${trimmed}`)
    out.push(`**A${n}**: `)
    n += 1
  }
  return out.join('\n\n')
}

export const paragraphsToNumberedQa: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToNumberedQaText, 'format.paragraphs-to-qa')

export function capitalizeWikilinkTargetsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (_m, target, anchor, alias) => {
      const cap = String(target).replace(/(^|\s|\/)([a-z])/g, (_m2, sep, ch) => sep + String(ch).toUpperCase())
      return `[[${cap}${anchor ?? ''}${alias ?? ''}]]`
    })
  }
  return lines.join('\n')
}

export const capitalizeWikilinkTargets: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeWikilinkTargetsText, 'format.wikilink.capitalize')

export const insertSipocTable: Command = (view) => {
  const text = [
    '## SIPOC',
    '',
    '| Suppliers | Inputs | Process | Outputs | Customers |',
    '|---|---|---|---|---|',
    '|  |  |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sipoc',
  })
  return true
}

export const insertLeanCoffeeAgenda: Command = (view) => {
  const text = [
    '## Lean Coffee',
    '',
    '### Topics (vote with 👍)',
    '- ',
    '',
    '### To Discuss',
    '- ',
    '',
    '### Discussing',
    '- ',
    '',
    '### Discussed',
    '- ',
    '',
    '### Action items',
    '- [ ] ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.lean-coffee',
  })
  return true
}

export function calloutTypeToAdmonitionKindText(source: string): string {
  const map: Record<string, string> = {
    note: 'note',
    info: 'info',
    tip: 'tip',
    success: 'success',
    question: 'question',
    warning: 'warning',
    failure: 'failure',
    danger: 'danger',
    bug: 'bug',
    example: 'example',
    quote: 'quote',
    abstract: 'abstract',
    summary: 'abstract',
    important: 'warning',
    hint: 'tip',
  }
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(>\s*)\[!([a-zA-Z]+)([+-]?)\]/, (_m, prefix, type, sign) => {
      const key = String(type).toLowerCase()
      const replaced = map[key] ?? key
      return `${prefix}[!${replaced}${sign}]`
    })
  }
  return lines.join('\n')
}

export const calloutTypeToAdmonitionKind: Command = (view) =>
  applyToSelectionOrAll(view, calloutTypeToAdmonitionKindText, 'format.callout-to-admonition')

export const foldAllH2Sections: Command = (view) => {
  const src = view.state.doc.toString()
  const lines = src.split('\n')
  let inFence = false
  const changes: { from: number; to: number; insert: string }[] = []
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) { inFence = !inFence; off += line.length + 1; continue }
    if (!inFence) {
      const m = /^## (.+)$/.exec(line)
      if (m) {
        const newLine = `> [!summary]- ${m[1]}`
        changes.push({ from: off, to: off + line.length, insert: newLine })
      }
    }
    off += line.length + 1
  }
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'format.fold-h2' })
  return true
}

export const insertPrReviewChecklist: Command = (view) => {
  const text = [
    '## PR Review checklist',
    '- [ ] Tests added / updated',
    '- [ ] Type checks pass',
    '- [ ] Lint clean',
    '- [ ] Backward compatible (or migration noted)',
    '- [ ] Docs / README updated',
    '- [ ] No secrets / hard-coded paths',
    '- [ ] PR description explains the why',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.pr-review',
  })
  return true
}

export const insertVocabFlashcardTable: Command = (view) => {
  const text = [
    '## Vocabulary',
    '',
    '| Term | Definition | Example | Tag |',
    '|---|---|---|---|',
    '|  |  |  | #vocab |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.vocab',
  })
  return true
}

export function headingsToBookmarkReportText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const items: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const text = m[2]
    const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
    items.push(`- [${text}](#${slug})`)
  }
  if (!items.length) return source
  const report = ['', '## 🔖 Bookmarks', ...items, ''].join('\n')
  return source + report
}

export const insertHeadingsBookmarkReport: Command = (view) =>
  applyToSelectionOrAll(view, headingsToBookmarkReportText, 'format.bookmark-report')

export const insertNpsSurveyLog: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## NPS — ${today}`,
    '',
    '| Score | Segment | Verbatim | Follow-up |',
    '|---|---|---|---|',
    '|  |  |  | [ ] |',
    '',
    '### Summary',
    '- Promoters: ',
    '- Passives: ',
    '- Detractors: ',
    '- NPS: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.nps',
  })
  return true
}

export const insertRiceTable: Command = (view) => {
  const text = [
    '## RICE prioritization',
    '',
    '| Initiative | Reach | Impact | Confidence | Effort | RICE |',
    '|---|---:|---:|---:|---:|---:|',
    '|  |  |  |  |  |  |',
    '',
    '> RICE = (Reach × Impact × Confidence) / Effort',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.rice',
  })
  return true
}

export const insertValueStreamMermaid: Command = (view) => {
  const text = [
    '```mermaid',
    'flowchart LR',
    '  subgraph "Process"',
    '    A[Idea] --> B[Design]',
    '    B --> C[Build]',
    '    C --> D[Test]',
    '    D --> E[Release]',
    '    E --> F[Operate]',
    '  end',
    '  classDef wait fill:#fde,stroke:#a33',
    '  classDef work fill:#dfe,stroke:#363',
    '  class A,C,E work',
    '  class B,D,F wait',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.value-stream',
  })
  return true
}

export function normalizeImageAltToFilenameText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      if (String(alt).trim()) return _m
      const slash = String(url).lastIndexOf('/')
      const base = slash >= 0 ? String(url).slice(slash + 1) : String(url)
      const dot = base.lastIndexOf('.')
      const name = dot >= 0 ? base.slice(0, dot) : base
      const clean = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      return `![${clean}](${url})`
    })
  }
  return lines.join('\n')
}

export const normalizeImageAltToFilename: Command = (view) =>
  applyToSelectionOrAll(view, normalizeImageAltToFilenameText, 'format.image-alt-from-filename')

export const insertDailyMoodSleep: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## ${today} — daily check-in`,
    '- mood: /10',
    '- energy: /10',
    '- sleep_hours: ',
    '- workout: ',
    '- meals: ',
    '- notes: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.daily-checkin',
  })
  return true
}

export function paragraphsToDropdownSummaryText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (!blocks.length) return source
  return blocks
    .map((b) => {
      const lines = b.split('\n')
      const title = lines[0].replace(/^#+\s*/, '').replace(/[*_`]+/g, '').slice(0, 80)
      const body = lines.slice(1).join('\n') || lines[0]
      return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`
    })
    .join('\n\n')
}

export const paragraphsToDropdownSummary: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToDropdownSummaryText, 'format.paragraphs-to-details')

export const insertCompetitorAnalysisMatrix: Command = (view) => {
  const text = [
    '## Competitor Analysis',
    '',
    '| Competitor | Pricing | Strengths | Weaknesses | Differentiation |',
    '|---|---|---|---|---|',
    '|  |  |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.competitor',
  })
  return true
}

export function bulletsToGanttTimelineText(source: string): string {
  const lines = source.split('\n')
  const tasks: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^\s*[-*+]\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\s*,\s*(\d+d)\))?\s*$/.exec(line)
    if (!m) continue
    const title = m[1].trim()
    const start = m[2] ?? '2026-01-01'
    const dur = m[3] ?? '1d'
    const id = `t${tasks.length + 1}`
    tasks.push(`    ${title} :${id}, ${start}, ${dur}`)
  }
  if (!tasks.length) return source
  return ['```mermaid', 'gantt', '    dateFormat YYYY-MM-DD', '    title Timeline', ...tasks, '```'].join('\n')
}

export const bulletsToGanttTimeline: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToGanttTimelineText, 'format.bullets-to-gantt')

export function capitalizeTaskDescriptionsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(\s*[-*+]\s+\[[ xX/\-]\]\s+)([a-z])/, (_m, prefix, ch) => prefix + String(ch).toUpperCase())
  }
  return lines.join('\n')
}

export const capitalizeTaskDescriptions: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeTaskDescriptionsText, 'format.tasks-capitalize')

export const insertTechDebtRegistry: Command = (view) => {
  const text = [
    '## Tech Debt Registry',
    '',
    '| Item | Owner | Severity | Cost | Plan |',
    '|---|---|---|---|---|',
    '|  |  |  |  |  |',
    '',
    '> Severity: low / medium / high / critical',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.techdebt',
  })
  return true
}

export const insertReadingRoadmap: Command = (view) => {
  const text = [
    '## Reading Roadmap',
    '',
    '### This week',
    '- [ ] ',
    '',
    '### This month',
    '- [ ] ',
    '',
    '### This quarter',
    '- [ ] ',
    '',
    '### Wishlist',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.reading-roadmap',
  })
  return true
}

export const insertEventTimelineLog: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Event timeline — ${today}`,
    '',
    '| Time | Actor | Event | Outcome |',
    '|---|---|---|---|',
    '| 00:00 |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.event-timeline',
  })
  return true
}

export const insertGtdWeeklyReview: Command = (view) => {
  const text = [
    '## GTD Weekly Review',
    '',
    '### Get clear',
    '- [ ] Collect loose papers / inbox / notes',
    '- [ ] Process inbox to zero',
    '- [ ] Empty head — capture open loops',
    '',
    '### Get current',
    '- [ ] Review next actions',
    '- [ ] Review calendar last week / next two weeks',
    '- [ ] Review waiting-for list',
    '- [ ] Review project list',
    '- [ ] Review someday/maybe list',
    '',
    '### Get creative',
    '- [ ] Brainstorm new ideas',
    '- [ ] Capture inspirations',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.gtd-review',
  })
  return true
}

export const insertSpacedRepetitionSchedule: Command = (view) => {
  const today = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const offsets = [1, 3, 7, 14, 30, 60, 120]
  const rows = offsets
    .map((days) => {
      const d = new Date(today.getTime() + days * 86400000)
      return `| +${days}d | ${fmt(d)} | [ ] |`
    })
    .join('\n')
  const text = [
    `## Spaced repetition — ${fmt(today)}`,
    '',
    '| Interval | Due | Done |',
    '|---|---|---|',
    rows,
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.srs',
  })
  return true
}

export function atxToSetextTopTwoLevelsText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(line); continue }
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line)
    if (!m) { out.push(line); continue }
    const text = m[2]
    const ch = m[1].length === 1 ? '=' : '-'
    out.push(text)
    out.push(ch.repeat(Math.max(3, text.length)))
  }
  return out.join('\n')
}

export const atxToSetextTopTwoLevels: Command = (view) =>
  applyToSelectionOrAll(view, atxToSetextTopTwoLevelsText, 'format.atx-to-setext')

export const insertCheckpointMarker: Command = (view) => {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const text = `\n\n> [!checkpoint] ${ts}\n> \n\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length - 2 },
    userEvent: 'insert.checkpoint',
  })
  return true
}

export function demoteFirstHeadingByOneText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,5})\s+(.+)$/.exec(lines[i])
    if (m) {
      lines[i] = `${m[1]}#`.padEnd(m[1].length + 1, '#') + ' ' + m[2]
      return lines.join('\n')
    }
  }
  return source
}

export const demoteFirstHeadingByOne: Command = (view) =>
  applyToSelectionOrAll(view, demoteFirstHeadingByOneText, 'format.demote-first-heading')

export function sortTableRowsByFirstColDescText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (/^\s*\|.*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|/.test(lines[i + 1])) {
      const header = lines[i]
      const sep = lines[i + 1]
      const body: string[] = []
      let j = i + 2
      while (j < lines.length && /^\s*\|.*\|/.test(lines[j])) {
        body.push(lines[j])
        j += 1
      }
      const firstCol = (row: string) => row.split('|').slice(1, 2)[0]?.trim() ?? ''
      body.sort((a, b) => firstCol(b).localeCompare(firstCol(a)))
      out.push(header, sep, ...body)
      i = j
    } else {
      out.push(lines[i])
      i += 1
    }
  }
  return out.join('\n')
}

export const sortTableRowsByFirstColDesc: Command = (view) =>
  applyToSelectionOrAll(view, sortTableRowsByFirstColDescText, 'format.table-sort-desc')

export const insertHypothesisTree: Command = (view) => {
  const text = [
    '## Hypothesis tree',
    '- **Main hypothesis**:',
    '  - Sub-hypothesis A',
    '    - Evidence: ',
    '    - Test: ',
    '  - Sub-hypothesis B',
    '    - Evidence: ',
    '    - Test: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.hypothesis-tree',
  })
  return true
}

export function paragraphWordCountBadgeText(source: string): string {
  const blocks = source.split(/\n{2,}/)
  return blocks
    .map((b) => {
      const trimmed = b.trim()
      if (!trimmed) return b
      if (/^#{1,6}\s/.test(trimmed)) return b
      if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) return b
      if (/^>/.test(trimmed)) return b
      if (/^```/.test(trimmed)) return b
      const words = trimmed.split(/\s+/).filter(Boolean).length
      return `${b}\n<sub>(${words} words)</sub>`
    })
    .join('\n\n')
}

export const paragraphWordCountBadge: Command = (view) =>
  applyToSelectionOrAll(view, paragraphWordCountBadgeText, 'format.paragraph-word-count')

export const insertBacklogGroomingNotes: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Backlog grooming — ${today}`,
    '',
    '### Triaged',
    '- ',
    '',
    '### Deprioritized',
    '- ',
    '',
    '### Promoted to sprint',
    '- ',
    '',
    '### Needs more info',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.grooming',
  })
  return true
}

export function paragraphsToTwoColCalloutText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length < 2) return source
  const out: string[] = []
  for (let i = 0; i < blocks.length; i += 2) {
    const a = blocks[i]
    const b = blocks[i + 1] ?? ''
    out.push('> [!info] Compare')
    out.push('> | A | B |')
    out.push('> |---|---|')
    out.push(`> | ${a.replace(/\n/g, ' ')} | ${b.replace(/\n/g, ' ')} |`)
    out.push('')
  }
  return out.join('\n').trim()
}

export const paragraphsToTwoColCallout: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTwoColCalloutText, 'format.paragraphs-to-twocol')

export function normalizeEmphasisInBulletsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(\s*[-*+]\s+)(.*)$/.exec(lines[i])
    if (!m) continue
    let rest = m[2]
    rest = rest.replace(/__([^_]+)__/g, '**$1**')
    rest = rest.replace(/(?<![*_])_(?!_)([^_\n]+?)_(?![*_])/g, '*$1*')
    lines[i] = m[1] + rest
  }
  return lines.join('\n')
}

export const normalizeEmphasisInBullets: Command = (view) =>
  applyToSelectionOrAll(view, normalizeEmphasisInBulletsText, 'format.bullet-emphasis')

export const insertKpiDashboardTable: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## KPI dashboard — ${today}`,
    '',
    '| KPI | Target | Actual | Δ | Owner | Trend |',
    '|---|---:|---:|---:|---|---|',
    '|  |  |  |  |  | ↗ |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.kpi-dashboard',
  })
  return true
}

export const insertLabNotebookEntry: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Lab notebook — ${today}`,
    '',
    '**Goal**: ',
    '',
    '**Setup**:',
    '- ',
    '',
    '**Procedure**:',
    '1. ',
    '',
    '**Observation**:',
    '- ',
    '',
    '**Result**:',
    '- ',
    '',
    '**Next steps**:',
    '- [ ] ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.lab-notebook',
  })
  return true
}

export const insertObjectivesSolutionTree: Command = (view) => {
  const text = [
    '## Opportunity Solution Tree',
    '- **Outcome**: ',
    '  - Opportunity A',
    '    - Solution: ',
    '    - Solution: ',
    '  - Opportunity B',
    '    - Solution: ',
    '    - Experiment: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.ost',
  })
  return true
}

export function paragraphsToNumberedHeadingsText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (!blocks.length) return source
  const out: string[] = []
  let n = 1
  for (const blk of blocks) {
    const firstLine = blk.split('\n')[0]
    const rest = blk.split('\n').slice(1).join('\n')
    const title = firstLine.replace(/^#+\s*/, '').replace(/[*_`]+/g, '').slice(0, 80)
    out.push(`## ${n}. ${title}`)
    if (rest) out.push(rest)
    out.push('')
    n += 1
  }
  return out.join('\n').trim() + '\n'
}

export const paragraphsToNumberedHeadings: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToNumberedHeadingsText, 'format.paragraphs-to-numbered-headings')

export const insertWireframeAsciiPlaceholder: Command = (view) => {
  const text = [
    '```text',
    '┌──────────────────────────────────────┐',
    '│  Header                              │',
    '├───────────┬──────────────────────────┤',
    '│           │                          │',
    '│  Sidebar  │      Main content        │',
    '│           │                          │',
    '├───────────┴──────────────────────────┤',
    '│  Footer                              │',
    '└──────────────────────────────────────┘',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.wireframe-ascii',
  })
  return true
}

const SC_STOPWORDS = new Set([
  'a','an','the','and','or','but','of','in','on','at','to','for','with','by','as','is','was','be','it','its','that','this',
])

export function sentenceCaseBulletsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(\s*[-*+]\s+(?:\[[ xX/\-]\]\s+)?)(.*)$/.exec(lines[i])
    if (!m) continue
    const body = m[2]
    if (!body) continue
    const sentenced = body
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/(\.|!|\?)\s+([a-z])/g, (_x, p, c) => p + ' ' + String(c).toUpperCase())
    lines[i] = m[1] + sentenced
  }
  return lines.join('\n')
}

export const sentenceCaseBullets: Command = (view) =>
  applyToSelectionOrAll(view, sentenceCaseBulletsText, 'format.sentence-case-bullets')

export const insertRiskBurndownTable: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Risk burndown — ${today}`,
    '',
    '| Week | Open | Mitigated | Accepted | Burned |',
    '|---|---:|---:|---:|---:|',
    '| W1 |  |  |  |  |',
    '| W2 |  |  |  |  |',
    '| W3 |  |  |  |  |',
    '| W4 |  |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.risk-burndown',
  })
  return true
}

export function tableRowsToWikilinksText(colIndex: number) {
  return (source: string): string => {
    const lines = source.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      if (/^\s*\|.*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|/.test(lines[i + 1])) {
        out.push(lines[i])
        out.push(lines[i + 1])
        let j = i + 2
        while (j < lines.length && /^\s*\|.*\|/.test(lines[j])) {
          const cells = lines[j].split('|')
          if (cells.length > colIndex + 1) {
            const v = String(cells[colIndex + 1]).trim()
            if (v && !v.startsWith('[[') && !v.includes('|---')) {
              cells[colIndex + 1] = ` [[${v}]] `
            }
          }
          out.push(cells.join('|'))
          j += 1
        }
        i = j
      } else {
        out.push(lines[i])
        i += 1
      }
    }
    return out.join('\n')
  }
}

export const tableRowsToWikilinks = (colIndex: number): Command => (view) =>
  applyToSelectionOrAll(view, tableRowsToWikilinksText(colIndex), 'format.table-col-to-wikilink')

export const insertDependencyGraphMermaid: Command = (view) => {
  const text = [
    '```mermaid',
    'graph TD',
    '  A[Module A] --> B[Module B]',
    '  A --> C[Module C]',
    '  B --> D[Module D]',
    '  C --> D',
    '  D --> E[Module E]',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.dep-graph',
  })
  return true
}

export const insertWeeklyBookLog: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Books this week — ${today}`,
    '',
    '| Title | Author | Status | Pages | Rating |',
    '|---|---|---|---:|---:|',
    '|  |  | reading |  |  |',
    '',
    '### Top quote',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.book-log',
  })
  return true
}

export function prependBlockIdToLinesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const line = lines[i]
    if (!line.trim()) continue
    if (/\s\^[A-Za-z0-9-]+$/.test(line)) continue
    if (/^#{1,6}\s/.test(line)) continue
    const id = `b${(i + 1).toString().padStart(4, '0')}`
    lines[i] = `${line} ^${id}`
  }
  return lines.join('\n')
}

export const prependBlockIdToLines: Command = (view) =>
  applyToSelectionOrAll(view, prependBlockIdToLinesText, 'format.prepend-block-id')

export const insertInventoryTable: Command = (view) => {
  const text = [
    '## Inventory',
    '',
    '| Item | SKU | Qty | Location | Notes |',
    '|---|---|---:|---|---|',
    '|  |  |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.inventory',
  })
  return true
}

export const insertWorkflowSwimlaneMermaid: Command = (view) => {
  const text = [
    '```mermaid',
    'flowchart LR',
    '  subgraph User',
    '    U1[Request]',
    '    U2[Approve]',
    '  end',
    '  subgraph System',
    '    S1[Validate]',
    '    S2[Process]',
    '  end',
    '  subgraph Admin',
    '    A1[Notify]',
    '  end',
    '  U1 --> S1 --> S2 --> A1 --> U2',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.swimlane',
  })
  return true
}

export const insertAnkiFlashcardBlock: Command = (view) => {
  const text = [
    '## Flashcard',
    '',
    'Q: ',
    '?',
    'A: ',
    '',
    '---',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.anki-card',
  })
  return true
}

export function paragraphsToDefinitionListText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (!blocks.length) return source
  const out: string[] = []
  for (const blk of blocks) {
    const lines = blk.split('\n')
    const term = lines[0]
    const defs = lines.slice(1)
    out.push(term)
    if (defs.length) {
      for (const d of defs) out.push(`: ${d}`)
    } else {
      out.push(': ')
    }
    out.push('')
  }
  return out.join('\n').trim() + '\n'
}

export const paragraphsToDefinitionList: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToDefinitionListText, 'format.paragraphs-to-dl')

export const insertOkrCheckIn: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## OKR check-in — ${today}`,
    '',
    '### Objective',
    '- ',
    '',
    '### Key results',
    '- [ ] KR1: 0/100',
    '- [ ] KR2: 0/100',
    '- [ ] KR3: 0/100',
    '',
    '### Confidence',
    '- 🟢 / 🟡 / 🔴 :',
    '',
    '### Blockers',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.okr-checkin',
  })
  return true
}

export const insertSupportRunbook: Command = (view) => {
  const text = [
    '## Support runbook',
    '',
    '### Symptom',
    '- ',
    '',
    '### Quick diagnostics',
    '1. ',
    '',
    '### Remediation steps',
    '1. ',
    '',
    '### Escalation path',
    '- L1 → L2 → L3',
    '',
    '### Communication template',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.runbook',
  })
  return true
}

export const wrapSelectionInKeyboardTag: Command = (view) => {
  const sel = view.state.selection.main
  if (sel.empty) {
    const text = '<kbd></kbd>'
    view.dispatch({
      changes: { from: sel.from, insert: text },
      selection: { anchor: sel.from + 5 },
      userEvent: 'format.kbd',
    })
    return true
  }
  const content = view.state.sliceDoc(sel.from, sel.to)
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `<kbd>${content}</kbd>` },
    selection: { anchor: sel.from + content.length + 11 },
    userEvent: 'format.kbd',
  })
  return true
}

export const insertChangeManagementForm: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Change request — ${today}`,
    '',
    '- **Change ID**: CR-',
    '- **Requester**: ',
    '- **Type**: standard / normal / emergency',
    '- **Impact**: low / medium / high',
    '- **Risk**: low / medium / high',
    '- **Window**: ',
    '- **Rollback plan**: ',
    '- **Verification**: ',
    '',
    '### Approval',
    '- [ ] Tech lead',
    '- [ ] CAB',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.change-mgmt',
  })
  return true
}

export function paragraphsToOrderedListWithSubitemsText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (!blocks.length) return source
  const out: string[] = []
  let n = 1
  for (const blk of blocks) {
    const lines = blk.split('\n')
    out.push(`${n}. ${lines[0]}`)
    for (const sub of lines.slice(1)) {
      out.push(`   - ${sub}`)
    }
    n += 1
  }
  return out.join('\n')
}

export const paragraphsToOrderedListWithSubitems: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToOrderedListWithSubitemsText, 'format.paragraphs-to-olist-sub')

export function capitalizeSectionTitlesText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(#{1,6}\s+)(.*)$/, (_m, prefix, rest) => {
      return prefix + String(rest).split(/\s+/).map((w) => {
        if (!w) return w
        return w[0].toUpperCase() + w.slice(1)
      }).join(' ')
    })
  }
  return lines.join('\n')
}

export const capitalizeSectionTitles: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeSectionTitlesText, 'format.cap-section-titles')

export const insertReleaseTimeline: Command = (view) => {
  const today = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const day = (n: number) => fmt(new Date(today.getTime() + n * 86400000))
  const text = [
    '## Release timeline',
    '',
    '```mermaid',
    'gantt',
    '    dateFormat YYYY-MM-DD',
    '    title Release plan',
    '    section Engineering',
    `    Code freeze :a1, ${day(0)}, 3d`,
    `    QA :a2, after a1, 5d`,
    '    section Release',
    `    Stage :b1, after a2, 1d`,
    `    Prod :b2, after b1, 1d`,
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.release-timeline',
  })
  return true
}

export const insertPomodoroDayLog: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Pomodoro — ${today}`,
    '',
    '| # | Task | Start | End | Interruptions |',
    '|---:|---|---|---|---:|',
    '| 1 |  |  |  |  |',
    '| 2 |  |  |  |  |',
    '| 3 |  |  |  |  |',
    '| 4 |  |  |  |  |',
    '',
    '### Reflection',
    '- Focus completed: ',
    '- Main interruption: ',
    '- Tomorrow: ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.pomodoro-day',
  })
  return true
}

export const insertResearchFindingsTemplate: Command = (view) => {
  const text = [
    '## Research findings',
    '',
    '**Research question**: ',
    '',
    '**Method**: interview / survey / observation / desk research',
    '',
    '**Participants**: ',
    '',
    '### Key findings',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### Quotes',
    '> ',
    '',
    '### Implications',
    '- ',
    '',
    '### Next research',
    '- [ ] ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.research-findings',
  })
  return true
}

export function paragraphsToSummaryBlockText(source: string): string {
  const blocks = source.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (!blocks.length) return source
  const out: string[] = ['> [!summary] Summary']
  for (const blk of blocks) {
    const first = blk.split('\n')[0]
    const oneLine = first.replace(/[*_`#]+/g, '').slice(0, 120)
    out.push(`> - ${oneLine}`)
  }
  out.push('')
  return out.join('\n')
}

export const paragraphsToSummaryBlock: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToSummaryBlockText, 'format.paragraphs-to-summary')

export function normalizeListSpacingText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let inFence = false
  let prevList = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      prevList = false
      continue
    }
    if (inFence) { out.push(line); continue }
    const isList = /^\s*([-*+]|\d+\.)\s/.test(line)
    const blank = !line.trim()
    if (blank && prevList) {
                            
      prevList = false
      continue
    }
    out.push(line)
    prevList = isList
  }
  return out.join('\n')
}

export const normalizeListSpacing: Command = (view) =>
  applyToSelectionOrAll(view, normalizeListSpacingText, 'format.list-spacing')

export const insertMocIndex: Command = (view) => {
  const text = [
    '# MOC — ',
    '',
    '> Map of content. Collects entry-point notes related to this topic.',
    '',
    '## Entries',
    '- [[ ]]',
    '- [[ ]]',
    '',
    '## Subtopics',
    '- ',
    '',
    '## References',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.moc-index',
  })
  return true
}

export function capitalizeAfterColonInHeadingsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    lines[i] = lines[i].replace(/^(#{1,6}\s+.*?:\s+)([a-z])/, (_m, prefix, ch) =>
      prefix + String(ch).toUpperCase(),
    )
  }
  return lines.join('\n')
}

export const capitalizeAfterColonInHeadings: Command = (view) =>
  applyToSelectionOrAll(view, capitalizeAfterColonInHeadingsText, 'format.colon-cap-headings')

export const insertWeeklyStatusReport: Command = (view) => {
  const today = new Date()
  const week = Math.ceil(((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)
  const text = [
    `## Weekly status — Week ${week}`,
    '',
    '### TL;DR',
    '> ',
    '',
    '### Wins',
    '- 🟢 ',
    '',
    '### Risks',
    '- 🟡 ',
    '',
    '### Blockers',
    '- 🔴 ',
    '',
    '### Next week',
    '- [ ] ',
    '',
    '### Metrics',
    '| Metric | Last | This | Δ |',
    '|---|---:|---:|---:|',
    '|  |  |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.status-report',
  })
  return true
}

export function replaceTabsInTablesWithPipesText(source: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('\t') && !lines[i].includes('|')) {
      const cells = lines[i].split('\t').map((c) => c.trim())
      lines[i] = `| ${cells.join(' | ')} |`
    }
  }
  return lines.join('\n')
}

export const replaceTabsInTablesWithPipes: Command = (view) =>
  applyToSelectionOrAll(view, replaceTabsInTablesWithPipesText, 'format.tabs-to-table')

export const insertDecisionJournalEntry: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Decision — ${today}`,
    '',
    '**Decision**: ',
    '',
    '**Context**: ',
    '',
    '**Options considered**:',
    '1. ',
    '2. ',
    '3. ',
    '',
    '**Reasoning**: ',
    '',
    '**Expected outcome**: ',
    '',
    '**Review date**: ',
    '',
    '**Tags**: #decision',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.decision-journal',
  })
  return true
}

export function sortSectionsByDatePrefixText(source: string): string {
  const lines = source.split('\n')
            
  type Section = { headerIdx: number; endIdx: number; date: string }
  const sections: Section[] = []
  let inFence = false
  let cur: Section | null = null
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(lines[i])
    if (m) {
      if (cur) { cur.endIdx = i; sections.push(cur) }
      cur = { headerIdx: i, endIdx: lines.length, date: m[1] }
    }
  }
  if (cur) sections.push(cur)
  if (sections.length < 2) return source

          
  const blocks = sections.map((s) => ({
    date: s.date,
    text: lines.slice(s.headerIdx, s.endIdx).join('\n'),
  }))
  blocks.sort((a, b) => a.date.localeCompare(b.date))
  const before = lines.slice(0, sections[0].headerIdx).join('\n')
  const after = lines.slice(sections[sections.length - 1].endIdx).join('\n')
  const sorted = blocks.map((b) => b.text).join('\n')
  const parts: string[] = []
  if (before) parts.push(before)
  parts.push(sorted)
  if (after) parts.push(after)
  return parts.join('\n')
}

export const sortSectionsByDatePrefix: Command = (view) =>
  applyToSelectionOrAll(view, sortSectionsByDatePrefixText, 'format.sort-sections-by-date')

export const insertSprintPlanningTemplate: Command = (view) => {
  const text = [
    '## Sprint planning',
    '',
    '**Sprint**: ',
    '**Goal**: ',
    '**Capacity**: ',
    '',
    '### Committed',
    '- [ ] ',
    '',
    '### Stretch',
    '- [ ] ',
    '',
    '### Won\'t do',
    '- ',
    '',
    '### Dependencies',
    '- ',
    '',
    '### Risks',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sprint-planning',
  })
  return true
}

// ============================================================================
// Batch #208 — glossary / ascii / handoff / metrics / complaint / release
// ============================================================================

export const insertGlossaryEntry: Command = (view) => {
  const text = `### TermName\n*Pronunciation*: /tɜːrm/\n*Category*: noun\n\nDefinition: A brief definition of the term.\n\n**Etymology**: Origin and history of the word.\n\n**Example**: "The term was used in the sentence."\n\n**See also**: [[RelatedTerm]]\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.glossary-entry',
  })
  return true
}

export function paragraphsToAsciiBoxText(source: string): string {
  const blocks = source.split(/\n{2,}/)
  const out: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const width = Math.max(...lines.map((l) => l.length), 4)
    const top = '+' + '-'.repeat(width + 2) + '+'
    const body = lines.map((l) => '| ' + l.padEnd(width, ' ') + ' |')
    out.push([top, ...body, top].join('\n'))
  }
  return out.join('\n\n')
}

export const paragraphsToAsciiBox: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToAsciiBoxText, 'transform.ascii-box')

export const insertCodeStatsTable: Command = (view) => {
  const text = `| Metric | Value | Notes |\n| --- | --- | --- |\n| Files | 0 | total .ts/.tsx |\n| Lines | 0 | LoC including blanks |\n| Functions | 0 | exported only |\n| Tests | 0 | passing |\n| Coverage | 0% | statements |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.code-stats',
  })
  return true
}

export function paragraphsToLetterPrefixedListText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim().length > 0)
  return blocks
    .map((b, i) => {
      const letter = String.fromCharCode(97 + (i % 26))
      return `${letter}) ${b.replace(/\n+/g, ' ')}`
    })
    .join('\n')
}

export const paragraphsToLetterPrefixedList: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToLetterPrefixedListText, 'transform.letter-list')

export const insertProductHandoffTemplate: Command = (view) => {
  const text = `# Product → Engineering Handoff\n\n## Overview\n*(One sentence describing what is being delivered)*\n\n## User story\n- As ___, I want ___, so that ___\n\n## Acceptance criteria\n- [ ] Criterion 1\n- [ ] Criterion 2\n- [ ] Criterion 3\n\n## Design\n- Figma: \n- Spec: \n\n## API contract\n\`\`\`http\nGET /api/...\n\`\`\`\n\n## Risks & assumptions\n- Risk:\n- Assumption:\n\n## Metrics\n- North star metric:\n- Monitoring alert:\n\n## Timeline\n| Phase | Date | Owner |\n| --- | --- | --- |\n| Kickoff | | |\n| Code complete | | |\n| Ship | | |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.product-handoff',
  })
  return true
}

export function convertHeadingNumberingToRomanText(source: string): string {
  const roman = (n: number): string => {
    const arr: [number, string][] = [
      [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
      [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
      [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
    ]
    let r = ''
    let v = n
    for (const [k, s] of arr) {
      while (v >= k) {
        r += s
        v -= k
      }
    }
    return r
  }
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence
    if (inFence) continue
    const m = lines[i].match(/^(#{1,6}\s+)(\d+)(\.\s+)(.*)$/)
    if (m) {
      lines[i] = `${m[1]}${roman(parseInt(m[2], 10))}${m[3]}${m[4]}`
    }
  }
  return lines.join('\n')
}

export const convertHeadingNumberingToRoman: Command = (view) =>
  applyToSelectionOrAll(view, convertHeadingNumberingToRomanText, 'transform.heading-roman')

export const insertWeeklyMetricsReport: Command = (view) => {
  const text = `# Weekly Metrics - YYYY-MM-DD\n\n## Key metrics\n| Metric | This week | Last week | Change | Notes |\n| --- | --- | --- | --- | --- |\n| MAU | | | | |\n| Retention D7 | | | | |\n| GMV | | | | |\n| NPS | | | | |\n\n## Key events\n- Shipped ___\n- Experiment ___ ended, result ___\n\n## Risk signals\n- [ ] Risk 1\n- [ ] Risk 2\n\n## Next week\n- Priority 1\n- Priority 2\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.weekly-metrics',
  })
  return true
}

export function smartIndentBulletByLevelText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) {
      out.push(line)
      continue
    }
    const m = line.match(/^(\s*)([-*+]\s|\d+\.\s)(.*)$/)
    if (m) {
      const spaces = m[1].length
      const level = Math.round(spaces / 2)
      out.push('  '.repeat(level) + m[2] + m[3])
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

export const smartIndentBulletByLevel: Command = (view) =>
  applyToSelectionOrAll(view, smartIndentBulletByLevelText, 'transform.bullet-indent')

export const insertCustomerComplaintForm: Command = (view) => {
  const text = `# Customer Complaint Log\n\n**Date**: YYYY-MM-DD\n**Channel**: (Email / Phone / Support / Social)\n**Severity**: P0 / P1 / P2 / P3\n\n## Customer info\n- Name:\n- Contact:\n- Contract / Order #:\n\n## Complaint\n> (verbatim excerpt)\n\n## Reproduction steps\n1. \n2. \n3. \n\n## Initial diagnosis\n- Scope:\n- Suspected module:\n- Confirmed / TBD:\n\n## Handling log\n| Time | Owner | Action |\n| --- | --- | --- |\n| | | Ticket created |\n| | | Customer updated |\n| | | Closed |\n\n## Root cause & follow-up\n- Root cause:\n- Improvement:\n- RCA needed: Yes / No\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.complaint-form',
  })
  return true
}

export function paragraphsToTaskAssignedTableText(source: string): string {
  const lines = source.split('\n').filter((l) => l.trim().length > 0)
  const rows: string[] = ['| Task | Owner | Due Date |', '| --- | --- | --- |']
  for (const line of lines) {
    rows.push(`| ${line.trim()} | TBD | TBD |`)
  }
  return rows.join('\n')
}

export const paragraphsToTaskAssignedTable: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTaskAssignedTableText, 'transform.task-table')

export const insertReleaseAnnouncementTemplate: Command = (view) => {
  const text = `# 🚀 vX.Y.Z Release Announcement\n\n## TL;DR\n*(One-sentence highlight)*\n\n## ✨ New features\n- **Feature A**: description\n- **Feature B**: description\n\n## 🐛 Bug fixes\n- Fixed ___\n- Fixed ___\n\n## ⚠️ Breaking changes\n- (none / describe)\n\n## 📊 Performance\n- Startup time: -15%\n- Memory usage: -8%\n\n## Upgrade\n\`\`\`bash\nnpm install pkg@X.Y.Z\n\`\`\`\n\n## Thanks\nThanks to @alice @bob for contributing.\n\n*Full changelog → [CHANGELOG.md](./CHANGELOG.md)*\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.release-announcement',
  })
  return true
}

export function bracketAroundNumbersInBulletsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (inFence) return line
      const m = line.match(/^(\s*[-*+]\s)(.*)$/)
      if (!m) return line
      const body = m[2].replace(/(?<![\[\d])(\d+(?:\.\d+)?)(?![\d\]])/g, '[$1]')
      return m[1] + body
    })
    .join('\n')
}

export const bracketAroundNumbersInBullets: Command = (view) =>
  applyToSelectionOrAll(view, bracketAroundNumbersInBulletsText, 'transform.bracket-numbers')

// ============================================================================
// Batch #209 — backlinks summary / heatmap / footer / interview kit
// ============================================================================

export const insertBacklinksSummaryStub: Command = (view) => {
  const text = `## Backlinks\n\n*This block is auto-maintained by the vault full-text index — do not edit manually.*\n\n<!-- backlinks-summary:auto-start -->\n_No backlinks yet_\n<!-- backlinks-summary:auto-end -->\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.backlinks-summary',
  })
  return true
}

export function paragraphsToHeatmapTableText(source: string, weeks = 4): string {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const header = '| Week | ' + days.join(' | ') + ' |'
  const sep = '| --- | ' + days.map(() => '---').join(' | ') + ' |'
  const lines = source.split(/\n/).filter((l) => l.trim().length > 0)
  const out: string[] = [header, sep]
  for (let w = 1; w <= weeks; w++) {
    const row: string[] = [`Week ${w}`]
    for (let d = 0; d < 7; d++) {
      const idx = (w - 1) * 7 + d
      row.push(lines[idx] ? lines[idx].trim().slice(0, 12) : '·')
    }
    out.push('| ' + row.join(' | ') + ' |')
  }
  return out.join('\n')
}

export const paragraphsToHeatmapTable: Command = (view) =>
  applyToSelectionOrAll(view, (s) => paragraphsToHeatmapTableText(s), 'transform.heatmap')

export const insertDocumentFooter: Command = (view) => {
  const text = `\n\n---\n\n*Last updated: YYYY-MM-DD*\n*Author: @author*\n*License: CC BY-SA 4.0*\n`
  const doc = view.state.doc
  const pos = doc.length
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.footer',
  })
  return true
}

export const insertUserInterviewKit: Command = (view) => {
  const text = `# User Interview Kit\n\n## Participant info\n- Name:\n- Role:\n- Company / context:\n- Recruitment channel:\n\n## Interview goal\n*(One sentence summarizing what to validate)*\n\n## Opening (5 min)\n1. Introduce yourself + consent to record\n2. "This interview is ~45 min. Our goal is ___. There are no right or wrong answers."\n\n## Exploration (25 min)\n- When was the last time you experienced ___?\n- How did you handle it at the time?\n- What would you ideally want instead?\n\n## Task (10 min)\n*(Have them demonstrate a real scenario live)*\n\n## Wrap-up (5 min)\n- Anything else you'd like to add?\n- May we follow up with you later?\n- Thanks + gift\n\n## Notes\n- Key quotes:\n- Behavioral observations:\n- Follow-up items:\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.interview-kit',
  })
  return true
}

export function bulletsToFooterReferencesText(source: string): string {
  const lines = source.split('\n')
  const refs: { label: string; url: string }[] = []
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) {
      out.push(line)
      continue
    }
    const m = line.match(/^(\s*[-*+]\s)\[(.+?)\]\((https?:\/\/[^\s)]+)\)(.*)$/)
    if (m) {
      const id = refs.length + 1
      refs.push({ label: m[2], url: m[3] })
      out.push(`${m[1]}[${m[2]}][${id}]${m[4]}`)
    } else {
      out.push(line)
    }
  }
  if (refs.length === 0) return source
  out.push('')
  for (let i = 0; i < refs.length; i++) {
    out.push(`[${i + 1}]: ${refs[i].url} "${refs[i].label}"`)
  }
  return out.join('\n')
}

export const bulletsToFooterReferences: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToFooterReferencesText, 'transform.footer-refs')

export const insertCodeReviewChecklistFull: Command = (view) => {
  const text = `## Code Review Checklist\n\n### Design\n- [ ] Approach is sound, avoids unnecessary complexity\n- [ ] Edge / error / concurrency cases considered\n- [ ] Performance acceptable (no N+1, unnecessary allocations)\n\n### Implementation\n- [ ] Naming is clear and readable\n- [ ] No duplicate code, dead code, or outstanding TODOs\n- [ ] Functions / files not too long\n\n### Tests\n- [ ] Unit tests cover core branches\n- [ ] Failure scenarios are explicitly asserted\n- [ ] No flaky tests introduced\n\n### Security & compliance\n- [ ] No hardcoded secrets\n- [ ] Input validation / SQL injection / XSS checked\n- [ ] Permission model is consistent\n\n### Documentation\n- [ ] README / CHANGELOG updated\n- [ ] Comments express WHY, not WHAT\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.code-review-full',
  })
  return true
}

export function paragraphsToCardsText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b) => {
      const lines = b.split('\n')
      const title = lines[0].trim()
      const body = lines.slice(1).join('\n').trim()
      return `> [!card] ${title}\n> ${body.replace(/\n/g, '\n> ')}`
    })
    .join('\n\n')
}

export const paragraphsToCards: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToCardsText, 'transform.cards')

export const insertOnboardingPlan30_60_90: Command = (view) => {
  const text = `# 30 / 60 / 90 Day Onboarding Plan\n\n## 30 days — Learn\n- [ ] Complete new-hire onboarding training\n- [ ] 1:1 with everyone on the team\n- [ ] Read core code / design docs\n- [ ] Shadow 1 week of standups + sprint\n- [ ] First small fix / doc contribution\n\n## 60 days — Contribute\n- [ ] Independently complete a full user story\n- [ ] Lead a code review\n- [ ] Give a team knowledge-share talk\n- [ ] Build relationships with 1-2 adjacent teams\n\n## 90 days — Lead\n- [ ] Own a clearly-defined module\n- [ ] Propose and push through 1 improvement\n- [ ] Align next-quarter OKRs with manager\n- [ ] Collect 360° feedback\n\n## Ongoing tracking\n| Week | Done | Blockers | Next week goal |\n| --- | --- | --- | --- |\n| W1 | | | |\n| W2 | | | |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.onboarding-plan',
  })
  return true
}

export function tableRowsToBulletPointsText(source: string): string {
  const lines = source.split('\n')
  const result: string[] = []
  let inTable = false
  let header: string[] = []
  for (const line of lines) {
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().split('|').slice(1, -1).map((c) => c.trim())
      if (!inTable) {
        header = cells
        inTable = true
        continue
      }
      if (cells.every((c) => /^-+$/.test(c))) continue
      const parts = header.map((h, i) => `**${h}**: ${cells[i] || ''}`)
      result.push('- ' + parts.join(' · '))
    } else {
      if (inTable && line.trim() === '') {
        result.push('')
        inTable = false
        header = []
      } else {
        result.push(line)
        inTable = false
      }
    }
  }
  return result.join('\n')
}

export const tableRowsToBulletPoints: Command = (view) =>
  applyToSelectionOrAll(view, tableRowsToBulletPointsText, 'transform.table-to-bullets')

export const insertPostmortemTimeline: Command = (view) => {
  const text = `## Incident Timeline (UTC)\n\n| Time | Event | Action | Actor |\n| --- | --- | --- | --- |\n| HH:MM | First monitoring alert | Auto page | System |\n| HH:MM | On-call engaged | Joined war room | @oncall |\n| HH:MM | Initial diagnosis | Isolated module X | @oncall |\n| HH:MM | Mitigation | rollback / hotfix | @engineer |\n| HH:MM | Recovery confirmed | Metrics back to normal | @oncall |\n| HH:MM | Closed | Draft RCA written | @author |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.postmortem-timeline',
  })
  return true
}

export function uppercaseAcronymsInTextText(source: string, acronyms: string[] = ['api', 'sql', 'json', 'yaml', 'html', 'css', 'url', 'http', 'https', 'tcp', 'udp', 'rest', 'jwt', 'oauth', 'aws', 'gcp', 'cdn', 'dns', 'ssl', 'tls']): string {
  const lines = source.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence
      if (inFence) return line
                       
      return line.replace(/`[^`]*`|[A-Za-z]+/g, (token) => {
        if (token.startsWith('`')) return token
        const lower = token.toLowerCase()
        if (acronyms.includes(lower)) return token.toUpperCase()
        return token
      })
    })
    .join('\n')
}

export const uppercaseAcronymsInText: Command = (view) =>
  applyToSelectionOrAll(view, (s) => uppercaseAcronymsInTextText(s), 'transform.uppercase-acronyms')

export const insertWeeklySnapshotChart: Command = (view) => {
  const text = `\`\`\`mermaid\n%%{init: { 'theme': 'default' } }%%\nbar\n    title Weekly key metrics\n    x-axis [Mon, Tue, Wed, Thu, Fri, Sat, Sun]\n    y-axis "Count" 0 --> 100\n    bar "Active users" [12, 23, 30, 45, 50, 38, 27]\n\`\`\`\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.weekly-snapshot',
  })
  return true
}

// ============================================================================
// Batch #210 — interview log / kanban tag / callout label / sentence count
// ============================================================================

export const insertInterviewSessionLog: Command = (view) => {
  const text = `## Session Log\n\n**Session #**: 001\n**Date**: YYYY-MM-DD\n**Duration**: 45 min\n**Recording**: [link]\n**Transcript**: [link]\n\n### Quotes\n> "I usually do X when Y happens." — Participant\n\n### Patterns observed\n- \n\n### New hypotheses\n- \n\n### Follow-up actions\n- [ ] \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.session-log',
  })
  return true
}

export function tagKanbanLanesByLabelText(source: string, label = '🏷️'): string {
  const lines = source.split('\n')
  return lines
    .map((line) => {
      const m = line.match(/^(##\s+)(.*)$/)
      if (m && !m[2].includes(label)) {
        return `${m[1]}${label} ${m[2]}`
      }
      return line
    })
    .join('\n')
}

export const tagKanbanLanesByLabel: Command = (view) =>
  applyToSelectionOrAll(view, (s) => tagKanbanLanesByLabelText(s), 'transform.kanban-tag')

export function relabelCalloutTypeText(source: string, oldType: string, newType: string): string {
  const re = new RegExp(`^(>\\s*\\[!)${oldType.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([\\]+\\-])`, 'i')
  return source
    .split('\n')
    .map((line) => line.replace(re, (_m, p1, p2) => `${p1}${newType}${p2}`))
    .join('\n')
}

export const relabelCalloutType = (oldType: string, newType: string): Command => (view) =>
  applyToSelectionOrAll(
    view,
    (s) => relabelCalloutTypeText(s, oldType, newType),
    'transform.callout-relabel',
  )

export function countSentencesPerParagraphText(source: string): string {
  const blocks = source.split(/\n{2,}/)
  return blocks
    .map((block) => {
      if (block.trim().startsWith('#') || block.trim().startsWith('```')) return block
      const sentences = block.match(/[^\p{Sentence_Terminal}]+\p{Sentence_Terminal}+/gu) ?? []
      return `${block}\n<!-- sentences: ${sentences.length} -->`
    })
    .join('\n\n')
}

export const countSentencesPerParagraph: Command = (view) =>
  applyToSelectionOrAll(view, countSentencesPerParagraphText, 'transform.sentence-count')

export const insertCustomerLifeCycleTable: Command = (view) => {
  const text = `| Stage | Touchpoint | Key metric | Main risk |\n| --- | --- | --- | --- |\n| Awareness | Ads / Search | CTR | Channel quality |\n| Acquisition | Sign-up | Conversion rate | Registration drop-off |\n| Activation | First key action | TTV | Unclear onboarding |\n| Retention | Weekly return | D7/D30 | Value loss |\n| Revenue | Payment | LTV/CAC | Pricing mismatch |\n| Referral | Invite | K-factor | Insufficient incentive |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.customer-lifecycle',
  })
  return true
}

export function sentencesToOrderedListText(source: string): string {
  const sentences = source.match(/[^\p{Sentence_Terminal}]+\p{Sentence_Terminal}+/gu) ?? []
  return sentences.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')
}

export const sentencesToOrderedList: Command = (view) =>
  applyToSelectionOrAll(view, sentencesToOrderedListText, 'transform.sentences-ordered')

export const insertDataModelSpec: Command = (view) => {
  const text = `## Data model spec\n\n### Entity: EntityName\n\n| Field | Type | Required | Default | Description |\n| --- | --- | --- | --- | --- |\n| id | uuid | Y | - | Primary key |\n| name | string(64) | Y | - | Name |\n| created_at | timestamp | Y | now() | Created time |\n| updated_at | timestamp | Y | now() | Updated time |\n\n### Indexes\n- \`UNIQUE (name)\`\n- \`INDEX (created_at)\`\n\n### Constraints\n- name must not be empty string\n- Deletion uses soft delete (deleted_at)\n\n### Relationships\n- N:1 → ParentEntity\n- 1:N → ChildEntity\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.data-model',
  })
  return true
}

export function tasksToBoardSwimlaneText(source: string): string {
  const lines = source.split('\n')
  const lanes: Record<string, string[]> = { TODO: [], DOING: [], DONE: [], BLOCKED: [] }
  for (const line of lines) {
    const m = line.match(/^(\s*)- \[(.)\]\s*(.*)$/)
    if (!m) continue
    const status = m[2].trim().toLowerCase()
    const text = m[3]
    if (status === 'x') lanes.DONE.push(text)
    else if (status === '-') lanes.BLOCKED.push(text)
    else if (/[/>]/.test(status)) lanes.DOING.push(text)
    else lanes.TODO.push(text)
  }
  const out: string[] = []
  for (const lane of ['TODO', 'DOING', 'DONE', 'BLOCKED'] as const) {
    out.push(`## ${lane}`)
    for (const t of lanes[lane]) out.push(`- ${t}`)
    out.push('')
  }
  return out.join('\n').trim()
}

export const tasksToBoardSwimlane: Command = (view) =>
  applyToSelectionOrAll(view, tasksToBoardSwimlaneText, 'transform.swimlane')

export const insertProjectCharter: Command = (view) => {
  const text = `# Project Charter\n\n## Project name\n*(Short and memorable)*\n\n## Project vision\n*(1 sentence defining success)*\n\n## Business problem\n*(Why now? Cost of not doing it?)*\n\n## Goals & metrics\n| Goal | Metric | Current | Target |\n| --- | --- | --- | --- |\n| | | | |\n\n## Scope\n**In scope**:\n-\n\n**Out of scope**:\n-\n\n## Key milestones\n- M1 (YYYY-MM-DD): \n- M2 (YYYY-MM-DD): \n- M3 (YYYY-MM-DD): \n\n## Stakeholders\n- Sponsor: \n- Product: \n- Tech Lead: \n- Designer: \n\n## Risks\n- \n\n## Budget\n- People: \n- Time: \n- Cost: \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.project-charter',
  })
  return true
}

export function moveLinesByPatternToTopText(source: string, pattern: RegExp): string {
  const lines = source.split('\n')
  const matched: string[] = []
  const rest: string[] = []
  for (const line of lines) {
    if (pattern.test(line)) matched.push(line)
    else rest.push(line)
  }
  return [...matched, ...rest].join('\n')
}

export const moveImportantTasksToTop: Command = (view) =>
  applyToSelectionOrAll(
    view,
    (s) => moveLinesByPatternToTopText(s, /^\s*[-*]\s+\[[ x]\][^\n]*(?:!{1,3}|#important|#urgent)/i),
    'transform.tasks-important-top',
  )

export const insertWritingPromptCard: Command = (view) => {
  const text = `> [!quote] Writing Prompt\n> *Pick one of your strongest feelings today and write 200 words in 5 minutes — no stopping, no editing.*\n\n## My response\n\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.writing-prompt',
  })
  return true
}

// ============================================================================
// Batch #211 — quiz / runbook / table merge / inline image / list dedup
// ============================================================================

export const insertQuizFlashSheet: Command = (view) => {
  const text = `## Quiz Sheet\n\n### Q1\n**Question**: \n\n*Answer area:*\n\n<details><summary>Answer</summary>\n\nReference answer:\n\n</details>\n\n---\n\n### Q2\n**Question**: \n\n*Answer area:*\n\n<details><summary>Answer</summary>\n\nReference answer:\n\n</details>\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.quiz-sheet',
  })
  return true
}

export const insertOperationsRunbook: Command = (view) => {
  const text = `# Runbook: <service-name>\n\n## Overview\n*(One sentence describing this service)*\n\n## Health metrics\n- Live monitoring: [link]\n- SLO: Availability 99.9%, p99 < 200ms\n\n## Common failures\n### 1. High latency\n**Symptom**: p99 > 500ms for 5 minutes\n**First action**: Check Grafana dashboard\n**Escalation condition**: Persists > 15 minutes\n\n### 2. Service unresponsive\n**Symptom**: Health check failing\n**First action**: \`kubectl rollout restart\`\n\n## Emergency contacts\n- Primary oncall: \n- Backup: \n- Manager: \n\n## Common commands\n\`\`\`bash\nkubectl get pods -n <ns>\nkubectl logs <pod> --tail=200\nkubectl describe pod <pod>\n\`\`\`\n\n## Past incidents\n- [[Incident-2026-01-15]]\n- [[Incident-2026-02-03]]\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.runbook',
  })
  return true
}

export function mergeTablesByFirstColumnText(source: string): string {
  const tables = source.split(/\n{2,}/).filter((b) => /^\s*\|/.test(b))
  if (tables.length < 2) return source
  type Row = string[]
  const parseTable = (t: string): { headers: string[]; rows: Row[] } => {
    const lines = t.trim().split('\n').filter((l) => l.startsWith('|'))
    const headers = lines[0].split('|').slice(1, -1).map((s) => s.trim())
    const dataStart = lines[1] && /^\|\s*[:\- |]+$/.test(lines[1]) ? 2 : 1
    const rows = lines
      .slice(dataStart)
      .map((l) => l.split('|').slice(1, -1).map((s) => s.trim()))
    return { headers, rows }
  }
  const parsed = tables.map(parseTable)
  const allHeaders: string[] = []
  for (const t of parsed) {
    for (const h of t.headers) if (!allHeaders.includes(h)) allHeaders.push(h)
  }
  const byKey = new Map<string, Record<string, string>>()
  for (const t of parsed) {
    for (const row of t.rows) {
      const key = row[0]
      if (!key) continue
      const obj = byKey.get(key) ?? {}
      for (let i = 0; i < t.headers.length; i++) {
        if (row[i] !== undefined && row[i] !== '') obj[t.headers[i]] = row[i]
      }
      byKey.set(key, obj)
    }
  }
  const headerRow = '| ' + allHeaders.join(' | ') + ' |'
  const sepRow = '| ' + allHeaders.map(() => '---').join(' | ') + ' |'
  const dataRows: string[] = []
  for (const [key, obj] of byKey) {
    const cells = allHeaders.map((h, idx) => (idx === 0 ? key : obj[h] ?? ''))
    dataRows.push('| ' + cells.join(' | ') + ' |')
  }
  return [headerRow, sepRow, ...dataRows].join('\n')
}

export const mergeTablesByFirstColumn: Command = (view) =>
  applyToSelectionOrAll(view, mergeTablesByFirstColumnText, 'transform.merge-tables')

export const insertInlineImageThumbnail: Command = (view) => {
  const pos = view.state.selection.main.head
  const text = `![thumbnail](https://placehold.co/120x80?text=thumb)`
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.thumbnail',
  })
  return true
}

export function listDedupCaseInsensitiveText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) {
      out.push(line)
      continue
    }
    const m = line.match(/^(\s*[-*+]\s+)(.*)$/)
    if (!m) {
      out.push(line)
      seen.clear()
      continue
    }
    const norm = m[2].toLowerCase().trim()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(line)
  }
  return out.join('\n')
}

export const listDedupCaseInsensitive: Command = (view) =>
  applyToSelectionOrAll(view, listDedupCaseInsensitiveText, 'transform.list-dedup-ci')

export const insertGameJournalEntry: Command = (view) => {
  const text = `## YYYY-MM-DD · Game log\n\n**Game**: \n**Duration**: 0h 0m\n**Progress**: \n\n### Highlights\n- \n\n### Strategies learned\n- \n\n### Next session goal\n- \n\n**Rating**: ⭐⭐⭐ / 5\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.game-journal',
  })
  return true
}

export function annotateLinksWithDomainText(source: string): string {
  return source.replace(/\[([^\]]+)\]\((https?:\/\/([^/\s)]+)[^\s)]*)\)/g, (_m, txt, url, host) => {
    if (txt.includes(' — ')) return `[${txt}](${url})`
    return `[${txt} — ${host}](${url})`
  })
}

export const annotateLinksWithDomain: Command = (view) =>
  applyToSelectionOrAll(view, annotateLinksWithDomainText, 'transform.annotate-domain')

export const insertWorkoutSessionLog: Command = (view) => {
  const text = `## YYYY-MM-DD · Workout log\n\n**Type**: Strength / Cardio / Stretch\n**Duration**: 0 min\n\n| Exercise | Sets×Reps | Weight | Notes |\n| --- | --- | --- | --- |\n| Squat | 5×5 | 60kg | |\n| Bench press | 5×5 | 50kg | |\n| Deadlift | 5×3 | 80kg | |\n\n**Avg heart rate**: bpm\n**Self-assessment**: ⭐⭐⭐⭐ / 5\n**Tomorrow focus**: \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.workout-log',
  })
  return true
}

export function paragraphsToReverseTimelineText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .reverse()
    .map((b, i) => `### T-${i}\n${b}`)
    .join('\n\n')
}

export const paragraphsToReverseTimeline: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToReverseTimelineText, 'transform.reverse-timeline')

export const insertCustomerJourneyTable: Command = (view) => {
  const text = `## Customer journey\n\n| Stage | User goal | Experience | Touchpoint | Pain point | Opportunity |\n| --- | --- | --- | --- | --- | --- |\n| Discovery | | | | | |\n| Evaluation | | | | | |\n| Decision | | | | | |\n| Usage | | | | | |\n| Retention | | | | | |\n| Advocacy | | | | | |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.customer-journey',
  })
  return true
}

export function quoteRangeToBlockquoteText(source: string, prefix = '> '): string {
  return source
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : prefix + line))
    .join('\n')
}

export const quoteRangeToBlockquote: Command = (view) =>
  applyToSelectionOrAll(view, (s) => quoteRangeToBlockquoteText(s), 'transform.range-to-quote')

export const insertWeeklyPlanningTemplate: Command = (view) => {
  const text = `# Weekly plan: YYYY-WW\n\n## Three main goals\n1. \n2. \n3. \n\n## Schedule preview\n| Day | Morning | Afternoon | Evening |\n| --- | --- | --- | --- |\n| Mon | | | |\n| Tue | | | |\n| Wed | | | |\n| Thu | | | |\n| Fri | | | |\n| Sat | | | |\n| Sun | | | |\n\n## Commitments\n- Meeting-free blocks:\n- Must-do each day (habit):\n- Won't do this week:\n\n## Daily 5-min reflection (evening)\n- What one thing today moved the weekly goal forward?\n- What was my biggest distraction?\n- How will I adjust tomorrow?\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.weekly-planning',
  })
  return true
}

export function paragraphsToFaqTextWithCount(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b, i) => `### Q${i + 1}: ${b.split('\n')[0].trim()}\n\n${b.split('\n').slice(1).join('\n')}`)
    .join('\n\n')
}

export const paragraphsToFaqWithCount: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFaqTextWithCount, 'transform.faq-count')

// ============================================================================
// Batch #212 — board chart / sparkline / tag count / lint dashes
// ============================================================================

export function numbersToSparklineText(source: string): string {
  const blocks = source.split('\n')
  const bars = '▁▂▃▄▅▆▇█'
  return blocks
    .map((line) => {
      const nums = line.match(/-?\d+(?:\.\d+)?/g)
      if (!nums || nums.length < 2) return line
      const arr = nums.map(Number)
      const min = Math.min(...arr)
      const max = Math.max(...arr)
      const range = max - min || 1
      const spark = arr
        .map((n) => bars[Math.min(7, Math.floor(((n - min) / range) * 8))])
        .join('')
      return `${line.trimEnd()}  ${spark}`
    })
    .join('\n')
}

export const numbersToSparkline: Command = (view) =>
  applyToSelectionOrAll(view, numbersToSparklineText, 'transform.sparkline')

export const insertScrumBoardSnapshot: Command = (view) => {
  const text = `\`\`\`mermaid\npie title Sprint progress\n    "Done" : 7\n    "In Progress" : 5\n    "To Do" : 12\n    "Blocked" : 2\n\`\`\`\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.scrum-snapshot',
  })
  return true
}

export function countTagOccurrencesText(source: string): string {
  const tags = new Map<string, number>()
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) continue
    const matches = line.matchAll(/(?<![A-Za-z0-9])#([A-Za-z0-9][\w-]*)/g)
    for (const m of matches) {
      const t = m[1]
      tags.set(t, (tags.get(t) ?? 0) + 1)
    }
  }
  if (tags.size === 0) return '_No tags_'
  const sorted = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const rows = ['| Tag | Count |', '| --- | --- |']
  for (const [t, n] of sorted) rows.push(`| #${t} | ${n} |`)
  return rows.join('\n')
}

export const countTagOccurrences: Command = (view) =>
  applyToSelectionOrAll(view, countTagOccurrencesText, 'transform.tag-count')

export function normalizeHorizontalRulesToDashesText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (/^([-_*])\1{2,}$/.test(t)) return '---'
      return line
    })
    .join('\n')
}

export const normalizeHorizontalRulesToDashes: Command = (view) =>
  applyToSelectionOrAll(view, normalizeHorizontalRulesToDashesText, 'transform.hr-normalize-dashes')

export const insertAdrShortForm: Command = (view) => {
  const text = `# ADR-XXXX: <title>\n\n*Status*: Draft / Proposed / Accepted / Rejected / Deprecated\n*Date*: YYYY-MM-DD\n\n## Context\n*(1 paragraph max)*\n\n## Decision\n*(1 sentence)*\n\n## Consequences\n- Positive:\n- Negative:\n- Neutral:\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.adr-short',
  })
  return true
}

export function paragraphsToCalloutByLengthText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b) => {
      const len = b.length
      const kind = len < 80 ? 'note' : len < 200 ? 'info' : 'tip'
      return `> [!${kind}]\n> ${b.replace(/\n/g, '\n> ')}`
    })
    .join('\n\n')
}

export const paragraphsToCalloutByLength: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToCalloutByLengthText, 'transform.callout-by-len')

export const insertContentCalendarTable: Command = (view) => {
  const text = `## Content calendar\n\n| Date | Title | Channel | Owner | Status |\n| --- | --- | --- | --- | --- |\n| YYYY-MM-DD | | WeChat | | Draft |\n| YYYY-MM-DD | | Email | | Formatting |\n| YYYY-MM-DD | | Social | | Published |\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.content-calendar',
  })
  return true
}

export function stripWikilinkAliasText(source: string): string {
  return source.replace(/\[\[([^\]|]+)\|[^\]]+\]\]/g, '[[$1]]')
}

export const stripWikilinkAlias: Command = (view) =>
  applyToSelectionOrAll(view, stripWikilinkAliasText, 'transform.strip-wikilink-alias')

export const insertWelcomeReadme: Command = (view) => {
  const text = `# Welcome 👋\n\nThis is my Kition vault.\n\n## How to use this vault\n- [[Index]] — all top-level notes\n- [[Glossary]] — term conventions\n- [[Templates]] — common templates\n\n## About me\n- Domain:\n- Topics of interest:\n- Contact:\n\n*Last updated: YYYY-MM-DD*\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.welcome-readme',
  })
  return true
}

export function listToBulletStarText(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/^(\s*)[-+]\s+/, '$1* '))
    .join('\n')
}

export const listToBulletStar: Command = (view) =>
  applyToSelectionOrAll(view, listToBulletStarText, 'transform.bullet-star')

export const insertBookSummaryTemplate: Command = (view) => {
  const text = `# Book summary: <title>\n\n**Author**: \n**Rating**: ⭐⭐⭐⭐ / 5\n**Category**: \n**Read**: YYYY-MM-DD → YYYY-MM-DD\n\n## One-sentence summary\n\n## Three biggest takeaways\n1. \n2. \n3. \n\n## Key concepts\n- **Concept A**:\n- **Concept B**:\n\n## Favorite quotes\n> "" — p.\n\n## Connections to what I know\n- How does this relate to [[xxx]]?\n- Does this contradict my view of [[yyy]]?\n\n## Action items\n- [ ] \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.book-summary',
  })
  return true
}

export function joinShortLinesText(source: string, threshold = 40): string {
  const blocks = source.split(/\n{2,}/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      const out: string[] = []
      let buf = ''
      for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('-') || line.startsWith('>') || line.startsWith('|') || line.startsWith('```')) {
          if (buf) {
            out.push(buf.trim())
            buf = ''
          }
          out.push(line)
          continue
        }
        if (line.trim().length === 0) {
          if (buf) {
            out.push(buf.trim())
            buf = ''
          }
          continue
        }
        if (line.length < threshold) {
          buf = buf ? buf + ' ' + line.trim() : line.trim()
        } else {
          if (buf) {
            out.push(buf.trim())
            buf = ''
          }
          out.push(line)
        }
      }
      if (buf) out.push(buf.trim())
      return out.join('\n')
    })
    .join('\n\n')
}

export const joinShortLines: Command = (view) =>
  applyToSelectionOrAll(view, (s) => joinShortLinesText(s), 'transform.join-short-lines')

// ============================================================================
// Batch #213 — focus block / brainstorm / paper / lint hashtag spacing
// ============================================================================

export const insertFocusBlock90Min: Command = (view) => {
  const text = `## 🎯 90-minute focus block\n\n**Topic**: \n**Target output**: \n**Off-limits**: Phone / tab-switching / messages\n\n### Launch checklist (3 min)\n- [ ] Notifications off\n- [ ] Water ready\n- [ ] Timer started\n\n### Time blocks\n| Segment | Task | Notes |\n| --- | --- | --- |\n| 0-25 | | |\n| 25-30 | Short break | |\n| 30-55 | | |\n| 55-60 | Short break | |\n| 60-90 | | |\n\n### Closing reflection (5 min)\n- Completion status:\n- Obstacles:\n- Next block:\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.focus-block',
  })
  return true
}

export const insertBrainstormingMatrix: Command = (view) => {
  const text = `## Brainstorming matrix\n\n*Rules: diverge first, then converge; no judgment; more is better; piggyback OK*\n\n### 1. Diverge (10 min)\n| Idea # | Description | Proposer |\n| --- | --- | --- |\n| 1 | | |\n| 2 | | |\n| 3 | | |\n\n### 2. Group (5 min)\n- Theme A: \n- Theme B: \n- Theme C: \n\n### 3. Vote (5 min)\n*(5 votes per person, dot stickers)*\n\n### 4. Converge (10 min)\nSelect top 3 and add:\n- Owner\n- First step\n- Due date\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.brainstorm-matrix',
  })
  return true
}

export const insertResearchPaperOutline: Command = (view) => {
  const text = `# Paper: <title>\n\n**Authors**: \n**Venue**: \n**Year**: \n**Link**: [DOI / arXiv]\n\n## Abstract\n*(Paste original abstract here)*\n\n## 1. Problem\n*What problem do the authors pose? Why does it matter?*\n\n## 2. Prior work\n*Previous approaches + their limitations.*\n\n## 3. Approach\n*Core idea. Architecture / algorithm / math.*\n\n## 4. Experiments\n*Datasets, baselines, key metrics.*\n\n## 5. Results\n*Main numbers, improvements.*\n\n## 6. Discussion\n*Limitations, future directions.*\n\n## 7. My critique\n- Is the evidence sufficient?\n- Are the experiments fair?\n- Where can I apply this?\n\n## 8. References\n- [[Related paper A]]\n- [[Related paper B]]\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.paper-outline',
  })
  return true
}

export function normalizeHashtagSpacingText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/(\S)(#[A-Za-z0-9][\w-]*)/g, '$1 $2')
    })
    .join('\n')
}

export const normalizeHashtagSpacing: Command = (view) =>
  applyToSelectionOrAll(view, normalizeHashtagSpacingText, 'transform.hashtag-spacing')

export const insertRoadmapQuarters: Command = (view) => {
  const text = `# Quarterly roadmap\n\n## Now (this quarter)\n- Project A: \n- Project B: \n\n## Next (next quarter)\n- Project C: \n- Project D: \n\n## Later (future)\n- Project E: \n- Project F: \n\n## Won't (explicitly not doing)\n- \n\n*Updated YYYY-MM-DD*\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.roadmap-quarters',
  })
  return true
}

export function trimTrailingPunctuationInHeadingsText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const m = line.match(/^(#{1,6}\s+.*?)([\p{Sentence_Terminal},:;]+)\s*$/u)
      if (m) return m[1]
      return line
    })
    .join('\n')
}

export const trimTrailingPunctuationInHeadings: Command = (view) =>
  applyToSelectionOrAll(view, trimTrailingPunctuationInHeadingsText, 'transform.heading-trim-punct')

export const insertProductMetricsTree: Command = (view) => {
  const text = `\`\`\`mermaid\nmindmap\n  root((North star metric))\n    (Inputs)\n      (Traffic)\n      (Retention)\n    (Conversion)\n      (Sign-up)\n      (Activation)\n    (Value)\n      (Usage frequency)\n      (Value per user)\n    (Revenue)\n      (GMV)\n      (Profit)\n\`\`\`\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.metrics-tree',
  })
  return true
}

export function lineRangeToCheckboxesText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      if (/^\s*[-*+]\s+\[[ x\-/]\]/.test(line)) return line
      if (/^\s*[-*+]\s+/.test(line)) return line.replace(/^(\s*[-*+]\s+)/, '$1[ ] ')
      return `- [ ] ${line}`
    })
    .join('\n')
}

export const lineRangeToCheckboxes: Command = (view) =>
  applyToSelectionOrAll(view, lineRangeToCheckboxesText, 'transform.line-to-checkbox')

export const insertLearningPlanTemplate: Command = (view) => {
  const text = `# Learning plan: <topic>\n\n## Why learn this\n*(Motivation, real problem to solve)*\n\n## Known vs unknown\n**Known**:\n- \n\n**Unknown**:\n- \n\n## Resource list\n| # | Type | Source | Est. time | Status |\n| --- | --- | --- | --- | --- |\n| 1 | Book | | | Unread |\n| 2 | Video | | | Unwatched |\n| 3 | Project | | | Not started |\n\n## Weekly rhythm\n- Fixed weekly slot:\n- Weekly output: 1 note / 1 code segment\n- Self-test every two weeks\n\n## Completion check\n- [ ] Can explain it to a newcomer\n- [ ] Can complete X independently\n- [ ] Published / presented once\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.learning-plan',
  })
  return true
}

export function paragraphsToCheatSheetText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b) => {
      const [first, ...rest] = b.split('\n')
      return `**${first.trim()}**\n: ${rest.join(' ').trim()}`
    })
    .join('\n\n')
}

export const paragraphsToCheatSheet: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToCheatSheetText, 'transform.cheat-sheet')

export const insertDeploymentChecklist: Command = (view) => {
  const text = `## Deployment checklist\n\n### Pre-deploy (T-24h)\n- [ ] Code freeze\n- [ ] Unit / integration / E2E all green\n- [ ] Database migration dry-run\n- [ ] CHANGELOG updated\n- [ ] Stakeholders notified\n\n### Deploy (T0)\n- [ ] Announcement (on-call + support)\n- [ ] Gradual rollout 1% → 10% → 50% → 100%\n- [ ] Monitor key metrics for 30 min\n- [ ] Rollback switch confirmed\n\n### Post-deploy (T+24h)\n- [ ] Error rate < 0.1%\n- [ ] p99 latency < 200ms\n- [ ] No spike in support tickets\n- [ ] Disable canary routing\n- [ ] Publish release report\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.deployment-checklist',
  })
  return true
}

export function uppercaseFirstLetterPerLineText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*(?:[-*+]\s+|\d+\.\s+|>\s+|#+\s+)?)([a-zà-ÿ])(.*)$/)
      if (!m) return line
      return m[1] + m[2].toUpperCase() + m[3]
    })
    .join('\n')
}

export const uppercaseFirstLetterPerLine: Command = (view) =>
  applyToSelectionOrAll(view, uppercaseFirstLetterPerLineText, 'transform.upper-first')

// ============================================================================
// Batch #214 — health log / threat matrix / hackathon / lint colon space
// ============================================================================

export const insertHealthDailyLog: Command = (view) => {
  const text = `## YYYY-MM-DD · Health log\n\n**Wake up**: 0:00  **Sleep**: 0:00  **Duration**: 0h\n**Mood**: ⭐ / 5\n**Weight**: kg\n**Water**: ml\n**Steps**: \n\n### Nutrition\n| Meal | Summary | Calories |\n| --- | --- | --- |\n| Breakfast | | |\n| Lunch | | |\n| Dinner | | |\n| Snack | | |\n\n### Exercise\n- \n\n### Issues / discomfort\n- \n\n### Tomorrow focus\n- \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.health-log',
  })
  return true
}

export const insertThreatModelMatrix: Command = (view) => {
  const text = `## Threat Model (STRIDE)\n\n| Category | Threat | Impact | Existing Mitigation | Residual Risk | Action Item |\n| --- | --- | --- | --- | --- | --- |\n| Spoofing | | | | | |\n| Tampering | | | | | |\n| Repudiation | | | | | |\n| Information Disclosure | | | | | |\n| Denial of Service | | | | | |\n| Elevation of Privilege | | | | | |\n\n### Asset Inventory\n- \n\n### Trust Boundaries\n- \n\n### Attacker Profile\n- \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.threat-model',
  })
  return true
}

export const insertHackathonPitchDeck: Command = (view) => {
  const text = `# Hackathon Pitch — <project>\n\n## 1. Problem (30s)\n*(Real user pain)*\n\n## 2. Current alternatives (30s)\n*(Why existing solutions fall short)*\n\n## 3. Our solution (60s)\n*(One sentence + Demo screenshot)*\n\n## 4. Technical highlights (30s)\n- \n\n## 5. Team (15s)\n- \n\n## 6. Next steps (15s)\n- \n\n## Demo Script\n1. \n2. \n3. \n\n## Preparation checklist\n- [ ] Demo device\n- [ ] Network backup\n- [ ] Video backup\n- [ ] Q&A prep\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.hackathon-pitch',
  })
  return true
}

export function normalizeColonSpacingText(source: string): string {
  let inFence = false
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // YAML-like inline key: value (not :// not http://)
      return line.replace(/([A-Za-z0-9_]+):(\S)/g, (_m, k, v) => {
        if (v === '/' || k === 'https' || k === 'http' || k === 'ftp') return _m
        return `${k}: ${v}`
      })
    })
    .join('\n')
}

export const normalizeColonSpacing: Command = (view) =>
  applyToSelectionOrAll(view, normalizeColonSpacingText, 'transform.colon-spacing')

export const insertOnePageProjectStatus: Command = (view) => {
  const text = `# Project Status: One-Pager\n\n| Project | Phase | Overall | Scope | Schedule | Resources |\n| --- | --- | --- | --- | --- | --- |\n| <name> | | 🟢 | 🟢 | 🟢 | 🟢 |\n\n## Completed this week\n- \n\n## Planned next week\n- \n\n## Risks & Dependencies\n| Risk | Level | Mitigation |\n| --- | --- | --- |\n| | | |\n\n## Blockers / Asks\n- \n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.one-page-status',
  })
  return true
}

export function indentBlockquoteByOneText(source: string): string {
  return source
    .split('\n')
    .map((line) => (line.startsWith('>') ? '>' + line : line))
    .join('\n')
}

export const indentBlockquoteByOne: Command = (view) =>
  applyToSelectionOrAll(view, indentBlockquoteByOneText, 'transform.blockquote-indent')

export const insertCustomerOnboardingFlow: Command = (view) => {
  const text = `## Customer Onboarding Flow\n\n\`\`\`mermaid\nflowchart LR\n  A[Invite email] --> B[Create account]\n  B --> C[Complete KYC]\n  C --> D[Connect data source]\n  D --> E[View first dashboard]\n  E --> F[Complete first key action]\n  F --> G[Activation success]\n  C -- Failed --> H[Manual follow-up]\n\`\`\`\n\n### Key Conversion Metrics\n- Sign-up → KYC: 75%\n- KYC → Data source: 65%\n- Data source → First action: 50%\n- Total activation rate: 25%\n\n### Drop-off Intervention\n- KYC failure: manual outreach within 24h\n- Data source timeout: email reminder\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.onboarding-flow',
  })
  return true
}

export function paragraphsToFlashFictionText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b, i) => {
      const wc = b.split(/\s+/).filter(Boolean).length
      return `### #${i + 1} · ${wc} words\n\n${b}\n`
    })
    .join('\n')
}

export const paragraphsToFlashFiction: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFlashFictionText, 'transform.flash-fiction')

export const insertWritingPlatformStrategy: Command = (view) => {
  const text = `# Writing Platform Strategy\n\n## Audience assumptions\n- \n\n## Topic matrix\n| Topic | Reader benefit | My edge | Frequency |\n| --- | --- | --- | --- |\n| | | | |\n\n## Distribution channels\n- Newsletter:\n- Twitter/X:\n- Blog:\n- LinkedIn:\n\n## Engagement cadence\n- Weekly recurring feature:\n- Monthly summary:\n- Quarterly retrospective:\n\n## Metrics\n- Net subscriber growth:\n- Open rate:\n- Reshare rate:\n- Revenue:\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.writing-platform',
  })
  return true
}

export function paragraphsToOneLinerSummariesText(source: string): string {
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim())
  return blocks
    .map((b) => {
      const words = b.replace(/\s+/g, ' ').trim().split(' ')
      const summary = words.slice(0, 12).join(' ')
      const suffix = words.length > 12 ? '…' : ''
      return `- ${summary}${suffix}`
    })
    .join('\n')
}

export const paragraphsToOneLinerSummaries: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToOneLinerSummariesText, 'transform.oneliner-summaries')

export const insertWeeklyRetrospectivePlus: Command = (view) => {
  const text = `## Weekly Retrospective\n\n### Data\n- Tasks completed: N\n- Tasks blocked: N\n- New tasks created: N\n\n### Three Ps\n**Progress**\n- \n\n**Problems**\n- \n\n**Plans**\n- \n\n### Key takeaway\n*(The most important lesson this week)*\n`
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.retro-plus',
  })
  return true
}

export function reverseListOrderText(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let group: string[] = []
  for (const line of lines) {
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      group.push(line)
    } else {
      if (group.length) {
        out.push(...group.reverse())
        group = []
      }
      out.push(line)
    }
  }
  if (group.length) out.push(...group.reverse())
  return out.join('\n')
}

export const reverseListOrder: Command = (view) =>
  applyToSelectionOrAll(view, reverseListOrderText, 'transform.list-reverse')

// ============================================================================
// Batch #215: dashboards, retros, learning
// ============================================================================

export const insertKPIDashboard: Command = (view) => {
  const text = [
    '## KPI Dashboard',
    '',
    '| Metric | Target | Current | Trend |',
    '| --- | --- | --- | --- |',
    '| Monthly active users | 100k | 87k | ↗ |',
    '| 7-day retention | 45% | 42% | → |',
    '| NPS | 50 | 48 | ↗ |',
    '| MRR | $1M | $920k | ↗ |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.kpi-dashboard',
  })
  return true
}

export const insertSprintRetro4Ls: Command = (view) => {
  const text = [
    '## Sprint Retrospective (4Ls)',
    '',
    '### Liked',
    '- ',
    '',
    '### Learned',
    '- ',
    '',
    '### Lacked',
    '- ',
    '',
    '### Longed for',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.retro-4ls',
  })
  return true
}

export const insertBookClubGuide: Command = (view) => {
  const text = [
    '## Book Club Discussion Guide',
    '',
    '**Title**:',
    '**Author**:',
    '**Date**:',
    '',
    '### 1. One-sentence summary',
    '',
    '### 2. Most impactful passage',
    '> ',
    '',
    '### 3. Ideas that challenged your thinking',
    '',
    '### 4. Three actionable takeaways',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### 5. Recommendation',
    '⭐⭐⭐⭐⭐',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.book-club',
  })
  return true
}

export function paragraphsToGlossaryIndexText(source: string): string {
                                 
  const blocks = source.split(/\n{2,}/).filter((b) => b.trim().length > 0)
  type Entry = { term: string; body: string }
  const entries: Entry[] = []
  for (const b of blocks) {
    const clean = b.replace(/\s+/g, ' ').trim()
    if (!clean) continue
    const m = /^([^\s\p{Sentence_Terminal}]+)[\s\p{P}]+(.+)$/u.exec(clean)
    if (m) {
      entries.push({ term: m[1], body: m[2] })
    } else {
      entries.push({ term: clean.slice(0, 10), body: clean })
    }
  }
  entries.sort((a, b) => a.term.localeCompare(b.term, 'zh'))
  const lines = ['## Glossary Index', '']
  for (const e of entries) {
    lines.push(`- **${e.term}** — ${e.body}`)
  }
  return lines.join('\n')
}

export const paragraphsToGlossaryIndex: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToGlossaryIndexText, 'transform.glossary-index')

export function normalizeTrailingWhitespaceText(source: string): string {
  return source.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n')
}

export const normalizeTrailingWhitespace: Command = (view) =>
  applyToSelectionOrAll(view, normalizeTrailingWhitespaceText, 'lint.trailing-ws')

export const insertWeeklyReviewTemplateV3: Command = (view) => {
  const text = [
    '## Weekly Review',
    '',
    '### Data',
    '- Words written:',
    '- Learning hours:',
    '- Exercise sessions:',
    '- Deep work blocks:',
    '',
    '### Completed',
    '- ',
    '',
    '### Not done',
    '- ',
    '',
    '### Reflection',
    '- Best thing this week:',
    '- Thing to stop this week:',
    '- New thing to try next week:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.weekly-review-v3',
  })
  return true
}

export const insertOrgChartMermaid: Command = (view) => {
  const text = [
    '```mermaid',
    'graph TD',
    '  CEO[CEO]',
    '  CEO --> CTO[CTO]',
    '  CEO --> COO[COO]',
    '  CEO --> CFO[CFO]',
    '  CTO --> ENG[Engineering Director]',
    '  CTO --> DATA[Data Director]',
    '  COO --> OPS[Operations Director]',
    '  COO --> CS[Customer Success]',
    '  ENG --> FE[Frontend]',
    '  ENG --> BE[Backend]',
    '  ENG --> SRE[SRE]',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.org-chart',
  })
  return true
}

export const insertCodeReviewSummary: Command = (view) => {
  const text = [
    '## Code Review Summary',
    '',
    '**PR**:',
    '**Author**:',
    '**Reviewer**:',
    '',
    '### Overall assessment',
    '',
    '### Must fix',
    '- ',
    '',
    '### Should fix',
    '- ',
    '',
    '### Could fix',
    '- ',
    '',
    '### Nit',
    '- ',
    '',
    '**Verdict**: [ ] Approved  [ ] Request Changes  [ ] Comment',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.cr-summary',
  })
  return true
}

export function bulletsToPriorityMatrixText(source: string): string {
  const lines = source.split('\n')
  type B = { content: string; tag: 'P0' | 'P1' | 'P2' | 'P3' }
  const items: B[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (!m) continue
    const content = m[1]
    let tag: B['tag'] = 'P2'
    if (/!{3}|#p0\b|urgent/i.test(content)) tag = 'P0'
    else if (/!{2}|#p1\b|important/i.test(content)) tag = 'P1'
    else if (/!{1}|#p2\b/i.test(content)) tag = 'P2'
    else tag = 'P3'
    items.push({ content: content.replace(/!{1,3}|#p[0-3]\b/gi, '').trim(), tag })
  }
  const bucket = (t: B['tag']) => items.filter((i) => i.tag === t).map((i) => `- ${i.content}`)
  return [
    '## Priority Matrix',
    '',
    '### P0 — Urgent and Important',
    ...(bucket('P0').length ? bucket('P0') : ['- (empty)']),
    '',
    '### P1 — Important',
    ...(bucket('P1').length ? bucket('P1') : ['- (empty)']),
    '',
    '### P2 — Normal',
    ...(bucket('P2').length ? bucket('P2') : ['- (empty)']),
    '',
    '### P3 — Optional',
    ...(bucket('P3').length ? bucket('P3') : ['- (empty)']),
    '',
  ].join('\n')
}

export const bulletsToPriorityMatrix: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToPriorityMatrixText, 'transform.priority-matrix')

export const insertFeedbackSynthesis: Command = (view) => {
  const text = [
    '## User Feedback Synthesis',
    '',
    '### Feedback sources',
    '- Support tickets:',
    '- App store reviews:',
    '- User interviews:',
    '- NPS survey:',
    '',
    '### High-frequency themes',
    '1. **Theme A** (N times):',
    '2. **Theme B** (N times):',
    '3. **Theme C** (N times):',
    '',
    '### Sentiment distribution',
    '- Positive:',
    '- Neutral:',
    '- Negative:',
    '',
    '### Action items',
    '- [ ] ',
    '- [ ] ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.feedback-synth',
  })
  return true
}

export const insertIdeaToImpact: Command = (view) => {
  const text = [
    '## Idea to Impact',
    '',
    '### 1. Idea',
    '> One-sentence description',
    '',
    '### 2. Hypothesis',
    '- We believe …',
    '- When …',
    '- We will see …',
    '',
    '### 3. Experiment',
    '- Scope:',
    '- Duration:',
    '- Measure:',
    '',
    '### 4. Result',
    '- Data:',
    '- Conclusion:',
    '',
    '### 5. Impact',
    '- Decision:',
    '- Next steps:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.idea-to-impact',
  })
  return true
}

export function linesToQuoteCardsText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  const out: string[] = []
  for (const line of lines) {
    out.push('> 💬', `> ${line}`, '', '---', '')
  }
  return out.join('\n')
}

export const linesToQuoteCards: Command = (view) =>
  applyToSelectionOrAll(view, linesToQuoteCardsText, 'transform.quote-cards')

// ============================================================================
// Batch #216: pull quotes, OKR, study cards
// ============================================================================

export function paragraphsToPullQuotesText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = []
  paras.forEach((p, i) => {
    const clean = p.replace(/\s+/g, ' ').trim()
    if (i % 2 === 0) {
      out.push(clean)
    } else {
      out.push(`> 🪶 *${clean}*`)
    }
    out.push('')
  })
  return out.join('\n').trimEnd()
}

export const paragraphsToPullQuotes: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToPullQuotesText, 'transform.pull-quotes')

export const insertOKRWorksheet: Command = (view) => {
  const text = [
    '## OKR Worksheet',
    '',
    '### Objective 1',
    '> Describe the objective in one sentence',
    '',
    '| Key Result | Current | Target | Progress |',
    '| --- | --- | --- | --- |',
    '| KR1 |  |  | 0% |',
    '| KR2 |  |  | 0% |',
    '| KR3 |  |  | 0% |',
    '',
    '### Objective 2',
    '> ',
    '',
    '| Key Result | Current | Target | Progress |',
    '| --- | --- | --- | --- |',
    '| KR1 |  |  | 0% |',
    '| KR2 |  |  | 0% |',
    '',
    '**Score**: 0.0–1.0 (0.7 = healthy)',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.okr',
  })
  return true
}

export function paragraphsToStudyCardsText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const out: string[] = ['## Study Cards', '']
  let n = 1
  for (const p of paras) {
    const clean = p.replace(/\s+/g, ' ').trim()
    const m = /^(.+?)[:?]\s*(.+)$/.exec(clean)
    if (m) {
      out.push(`### Q${n}. ${m[1]}`)
      out.push('')
      out.push('<details>')
      out.push(`<summary>Show answer</summary>`)
      out.push('')
      out.push(m[2])
      out.push('')
      out.push('</details>')
      out.push('')
    } else {
      out.push(`### Q${n}. ${clean}`)
      out.push('')
      out.push('<details>')
      out.push(`<summary>Show answer</summary>`)
      out.push('')
      out.push('(to be completed)')
      out.push('')
      out.push('</details>')
      out.push('')
    }
    n++
  }
  return out.join('\n').trimEnd()
}

export const paragraphsToStudyCards: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToStudyCardsText, 'transform.study-cards')

export const insertTechDebtLog: Command = (view) => {
  const text = [
    '## Tech Debt Log',
    '',
    '| ID | Module | Description | Impact | Estimate | Priority | Owner |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| TD-001 |  |  | H/M/L | Sd | P0/P1/P2 |  |',
    '| TD-002 |  |  |  |  |  |  |',
    '',
    '### Repayment strategy',
    '- Reserve 20% of each sprint for debt repayment',
    '- Ship one TD item per release',
    '- Prioritize shared modules',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.tech-debt',
  })
  return true
}

export function normalizeOrderedListToDashesText(source: string): string {
  return source.split('\n').map((line) => {
    const m = /^(\s*)\d+\.\s+(.*)$/.exec(line)
    if (m) return `${m[1]}- ${m[2]}`
    return line
  }).join('\n')
}

export const normalizeOrderedListToDashes: Command = (view) =>
  applyToSelectionOrAll(view, normalizeOrderedListToDashesText, 'lint.ol-to-dash')

export const insertWeeklyContentPlan: Command = (view) => {
  const text = [
    '## Weekly Content Plan',
    '',
    '| Day | Platform | Format | Topic | Status |',
    '| --- | --- | --- | --- | --- |',
    '| Monday | Blog | Long-form |  | Draft |',
    '| Tuesday | Instagram | Photo + text |  | Draft |',
    '| Wednesday | Twitter | Thread |  | Draft |',
    '| Thursday | YouTube | Short video |  | Draft |',
    '| Friday | Newsletter | Email |  | Draft |',
    '| Saturday | Blog | Tutorial |  | Draft |',
    '| Sunday | — | Reflection |  | — |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.weekly-content-plan',
  })
  return true
}

export const insertLessonsLearnedLog: Command = (view) => {
  const text = [
    '## Lessons Learned',
    '',
    '### 1. Triggering event',
    '',
    '### 2. Initial assumption',
    '',
    '### 3. What actually happened',
    '',
    '### 4. Root cause of the gap',
    '',
    '### 5. What to do differently next time',
    '- ',
    '',
    '### 6. Tags',
    '#lessons-learned #',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.lessons',
  })
  return true
}

export function paragraphsToTLDRWithBulletsText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const first = paras[0].replace(/\s+/g, ' ').trim()
  const firstSentence = first.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || first
  const bullets: string[] = []
  for (let i = 1; i < paras.length && bullets.length < 3; i++) {
    const s = paras[i].replace(/\s+/g, ' ').trim()
    const sent = s.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || s
    if (sent) bullets.push(`- ${sent}`)
  }
  return [
    '> [!tip]+ TL;DR',
    `> ${firstSentence}`,
    '',
    ...bullets,
    '',
    '---',
    '',
    source.trim(),
  ].join('\n')
}

export const paragraphsToTLDRWithBullets: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTLDRWithBulletsText, 'transform.tldr-bullets')

export const insertCustomerInterviewScript: Command = (view) => {
  const text = [
    '## Customer Interview Script',
    '',
    '**Interviewee**:',
    '**Role / Context**:',
    '**Date / Duration**:',
    '',
    '### Opening (3 min)',
    '> Thank you for joining. We will spend about 30 minutes talking through your real usage scenarios. There are no right or wrong answers.',
    '',
    '### Background (5 min)',
    '1. Can you briefly describe your current work?',
    '2. How much time do you spend on X each day?',
    '',
    '### Pain-point discovery (10 min)',
    '1. What is the last scenario that frustrated you?',
    '2. How did you work around it at the time?',
    '3. If you could change one thing, what would it be?',
    '',
    '### Existing solutions (5 min)',
    '1. What tools have you tried to solve this?',
    '2. Why did they not stick?',
    '',
    '### Wrap-up (5 min)',
    '1. Is there anything I did not ask that you want to share?',
    '2. Can we schedule a follow-up?',
    '',
    '### Notes',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.interview-script',
  })
  return true
}

export function bulletsToSWOTByEmojiText(source: string): string {
  const lines = source.split('\n')
  type B = { content: string; tag: 'S' | 'W' | 'O' | 'T' }
  const items: B[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (!m) continue
    const c = m[1]
    let tag: B['tag'] = 'O'
    if (/^[💪✅🟢]/.test(c) || /^S:/i.test(c)) tag = 'S'
    else if (/^[⚠️🟡⛔]/.test(c) || /^W:/i.test(c)) tag = 'W'
    else if (/^[🚀🟢🎯]/.test(c) || /^O:/i.test(c)) tag = 'O'
    else if (/^[🔴🟥💀]/.test(c) || /^T:/i.test(c)) tag = 'T'
    items.push({
      content: c
        .replace(/^[SWOT]:\s*/i, '')
        .replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}][\u{FE0E}\u{FE0F}]?\s*/u, '')
        .trim(),
      tag,
    })
  }
  const bucket = (t: B['tag']) => items.filter((i) => i.tag === t).map((i) => `- ${i.content}`)
  return [
    '## SWOT',
    '',
    '### Strengths',
    ...(bucket('S').length ? bucket('S') : ['- (empty)']),
    '',
    '### Weaknesses',
    ...(bucket('W').length ? bucket('W') : ['- (empty)']),
    '',
    '### Opportunities',
    ...(bucket('O').length ? bucket('O') : ['- (empty)']),
    '',
    '### Threats',
    ...(bucket('T').length ? bucket('T') : ['- (empty)']),
    '',
  ].join('\n')
}

export const bulletsToSWOTByEmoji: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToSWOTByEmojiText, 'transform.swot-emoji')

export const insertDecisionMatrixV2: Command = (view) => {
  const text = [
    '## Decision Matrix',
    '',
    '> Score 1–5, weight 0–1 (sum to 1)',
    '',
    '| Option \\ Dimension | Cost (w 0.3) | Time (w 0.3) | Quality (w 0.4) | Total |',
    '| --- | --- | --- | --- | --- |',
    '| Option A |  |  |  |  |',
    '| Option B |  |  |  |  |',
    '| Option C |  |  |  |  |',
    '',
    '**Recommendation**:',
    '**Rationale**:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.decision-matrix-v2',
  })
  return true
}

export function linesReverseWithIndexText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  return lines.reverse().map((l, i) => `${i + 1}. ${l}`).join('\n')
}

export const linesReverseWithIndex: Command = (view) =>
  applyToSelectionOrAll(view, linesReverseWithIndexText, 'transform.lines-reverse-index')

// ============================================================================
// Batch #217: standup, headlines, RFC
// ============================================================================

export const insertDailyStandupNotes: Command = (view) => {
  const text = [
    '## Daily Standup Notes',
    '',
    '**Date**:',
    '',
    '### Attendees',
    '- ',
    '',
    '### Yesterday',
    '- ',
    '',
    '### Today',
    '- ',
    '',
    '### Blockers / Asks',
    '- ',
    '',
    '### Action items',
    '- [ ] ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.daily-standup',
  })
  return true
}

export function paragraphsToHeadlinesText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## Headline Candidates', '']
  paras.forEach((p, i) => {
    const clean = p.replace(/\s+/g, ' ').trim()
    const sent = clean.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || clean
    let head = sent.replace(/\p{Sentence_Terminal}\s*$/u, '')
    if (head.length > 60) head = head.slice(0, 57) + '…'
    out.push(`${i + 1}. ${head}`)
  })
  return out.join('\n')
}

export const paragraphsToHeadlines: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToHeadlinesText, 'transform.headlines')

export const insertProductSpecTemplate: Command = (view) => {
  const text = [
    '# Product Spec',
    '',
    '**Author**:',
    '**Version**: v0.1',
    '**Status**: Draft',
    '',
    '## 1. Background & Problem',
    '> Who are we solving this for, and what is the problem? What does the current approach look like?',
    '',
    '## 2. Goals',
    '- Primary goal:',
    '- Secondary goal:',
    '- Non-goals:',
    '',
    '## 3. User scenarios',
    '### Persona A:',
    '> ',
    '',
    '## 4. Feature scope',
    '- [ ] Must have',
    '- [ ] Should have',
    '- [ ] Nice to have',
    '',
    '## 5. Interaction flow',
    '```mermaid',
    'flowchart LR',
    '  A[Entry] --> B[Action]',
    '  B --> C[Result]',
    '```',
    '',
    '## 6. Constraints',
    '',
    '## 7. Metrics',
    '- North star:',
    '- Secondary metrics:',
    '',
    '## 8. Risks',
    '',
    '## 9. Timeline',
    '| Milestone | Date |',
    '| --- | --- |',
    '| MVP | YYYY-MM-DD |',
    '| GA | YYYY-MM-DD |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.product-spec',
  })
  return true
}

export function linesShuffleText(source: string): string {
  const lines = source.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return source
  // Fisher-Yates with deterministic-enough seeding (Date.now-based)
  const arr = lines.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('\n')
}

export const linesShuffle: Command = (view) =>
  applyToSelectionOrAll(view, linesShuffleText, 'transform.shuffle')

export const insertSalesCallNotes: Command = (view) => {
  const text = [
    '## Sales Call Notes',
    '',
    '**Customer**:',
    '**Contact / Title**:',
    '**Date / Duration**:',
    '**Stage**: Prospect / Qualify / Proposal / Close',
    '',
    '### BANT',
    '- **Budget**:',
    '- **Authority**:',
    '- **Need**:',
    '- **Timeline**:',
    '',
    '### Pain points / Requirements',
    '- ',
    '',
    '### Current solution / Competitors',
    '- ',
    '',
    '### Objections / Concerns',
    '- ',
    '',
    '### Next steps',
    '- [ ] ',
    '',
    '**Win probability**: %',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sales-call',
  })
  return true
}

export function paragraphsToKeyTakeawaysText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## Key Takeaways', '']
  for (const p of paras) {
    const clean = p.replace(/\s+/g, ' ').trim()
    const sent = clean.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || clean
    out.push(`- ${sent}`)
  }
  return out.join('\n')
}

export const paragraphsToKeyTakeaways: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToKeyTakeawaysText, 'transform.key-takeaways')

export const insertGrantProposalOutline: Command = (view) => {
  const text = [
    '# Grant Proposal Outline',
    '',
    '## Executive Summary (max 200 words)',
    '',
    '## 1. Applicant / Team',
    '',
    '## 2. Problem Statement',
    '',
    '## 3. Proposed Solution',
    '',
    '## 4. Innovation',
    '',
    '## 5. Implementation Plan',
    '| Phase | Timeline | Key Deliverable |',
    '| --- | --- | --- |',
    '| Phase 1 |  |  |',
    '| Phase 2 |  |  |',
    '',
    '## 6. Team Members',
    '',
    '## 7. Budget',
    '| Category | Amount | Notes |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
    '## 8. Evaluation Metrics',
    '',
    '## 9. Risks & Mitigation',
    '',
    '## 10. Prior Work / References',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.grant-proposal',
  })
  return true
}

export function bulletsByDayOfWeekText(source: string): string {
  // Re-group items cycling through 7 days
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  const lines = source.split('\n')
  const bullets: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) bullets.push(m[1])
  }
  if (bullets.length === 0) return source
  const out: string[] = ['## Weekly Plan', '']
  for (let i = 0; i < bullets.length; i++) {
    const day = days[i % 7]
    out.push(`- **${day}** — ${bullets[i]}`)
  }
  return out.join('\n')
}

export const bulletsByDayOfWeek: Command = (view) =>
  applyToSelectionOrAll(view, bulletsByDayOfWeekText, 'transform.day-of-week')

export const insertHiringScorecard: Command = (view) => {
  const text = [
    '## Hiring Scorecard',
    '',
    '**Candidate**:',
    '**Role**:',
    '**Interviewer**:',
    '**Date**:',
    '',
    '| Dimension | Score (1–5) | Notes |',
    '| --- | --- | --- |',
    '| Technical depth |  |  |',
    '| System design |  |  |',
    '| Communication |  |  |',
    '| Problem solving |  |  |',
    '| Learning ability |  |  |',
    '| Culture fit |  |  |',
    '',
    '**Overall recommendation**: Strong Hire / Hire / No Hire / Strong No Hire',
    '',
    '### Highlights',
    '- ',
    '',
    '### Concerns',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.hiring-scorecard',
  })
  return true
}

export function paragraphsToOnePagerText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const norm = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  const out: string[] = []
  out.push('## One-Pager')
  out.push('')
  out.push('### TL;DR')
  out.push(norm[0] || '')
  out.push('')
  out.push('### Why')
  out.push(norm[1] || '_(to be completed)_')
  out.push('')
  out.push('### How')
  if (norm.length >= 3) out.push(norm[2])
  else out.push('_(to be completed)_')
  out.push('')
  out.push('### Risks')
  if (norm.length >= 4) out.push(norm[3])
  else out.push('_(to be completed)_')
  out.push('')
  return out.join('\n')
}

export const paragraphsToOnePager: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToOnePagerText, 'transform.one-pager')

export const insertTechnicalRFCTemplate: Command = (view) => {
  const text = [
    '# Technical RFC',
    '',
    '**Number**: RFC-XXX',
    '**Author**:',
    '**Status**: Draft / In Review / Accepted / Rejected',
    '**Date**:',
    '**Review deadline**:',
    '',
    '## Summary',
    '',
    '## Motivation',
    '> Why do this now? What happens if we do not?',
    '',
    '## Detailed Design',
    '### Data Model',
    '### API',
    '### Key Algorithm / Flow',
    '```mermaid',
    'sequenceDiagram',
    '  participant C as Client',
    '  participant S as Server',
    '  C->>S: request',
    '  S-->>C: response',
    '```',
    '',
    '## Compatibility / Migration',
    '',
    '## Alternatives',
    '- **A**:',
    '- **B**:',
    '',
    '## Security / Privacy / Compliance',
    '',
    '## Metrics & Rollback',
    '- Success signal:',
    '- Failure signal:',
    '- Rollback plan:',
    '',
    '## Review Notes',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.tech-rfc',
  })
  return true
}

export function normalizeBlankLinesMax1Text(source: string): string {
  return source.replace(/\n{3,}/g, '\n\n')
}

export const normalizeBlankLinesMax1: Command = (view) =>
  applyToSelectionOrAll(view, normalizeBlankLinesMax1Text, 'lint.max-blank-1')

// ============================================================================
// Batch #218: architecture, positioning, vision
// ============================================================================

export const insertArchitectureContainerDiagram: Command = (view) => {
  const text = [
    '```mermaid',
    'flowchart TB',
    '  subgraph User[Users]',
    '    Browser[Browser]',
    '    Mobile[Mobile]',
    '  end',
    '  subgraph Edge[Edge]',
    '    CDN[CDN]',
    '    WAF[WAF]',
    '  end',
    '  subgraph App[App Layer]',
    '    API[API Server]',
    '    WS[WebSocket]',
    '  end',
    '  subgraph Data[Data Layer]',
    '    PG[(Postgres)]',
    '    Redis[(Redis)]',
    '    Q[Message Queue]',
    '  end',
    '  Browser --> CDN',
    '  Mobile --> CDN',
    '  CDN --> WAF',
    '  WAF --> API',
    '  API --> PG',
    '  API --> Redis',
    '  API --> Q',
    '  WS --> Redis',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.arch-container',
  })
  return true
}

export function paragraphsToActionRegisterText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = []
  out.push('## Action Register')
  out.push('')
  out.push('| # | Action | Owner | Due | Status |')
  out.push('| --- | --- | --- | --- | --- |')
  paras.forEach((p, i) => {
    const clean = p.replace(/\s+/g, ' ').trim()
    const sent = clean.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || clean
    out.push(`| ${i + 1} | ${sent} | TBD | TBD | Not started |`)
  })
  out.push('')
  return out.join('\n')
}

export const paragraphsToActionRegister: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToActionRegisterText, 'transform.action-register')

export const insertPositioningTemplate: Command = (view) => {
  const text = [
    '## Product Positioning',
    '',
    '**For** [target user]',
    '**Who** [pain point]',
    '**Our product is** [category]',
    '**That** [core value]',
    '**Unlike** [competitor]',
    '**Our product** [differentiator]',
    '',
    '### Tagline',
    '> ',
    '',
    '### Three supporting points',
    '1. ',
    '2. ',
    '3. ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.positioning',
  })
  return true
}

export function linesToTableWithIndexText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  const out: string[] = []
  out.push('| # | Content |')
  out.push('| --- | --- |')
  lines.forEach((l, i) => out.push(`| ${i + 1} | ${l.replace(/\|/g, '\\|')} |`))
  return out.join('\n')
}

export const linesToTableWithIndex: Command = (view) =>
  applyToSelectionOrAll(view, linesToTableWithIndexText, 'transform.lines-to-indexed-table')

export const insertVisionMissionValues: Command = (view) => {
  const text = [
    '## Vision / Mission / Values',
    '',
    '### Vision',
    '> What does the world look like in 10 years?',
    '',
    '### Mission',
    '> Why do we exist?',
    '',
    '### Values',
    '1. **Value A** — behavioral example',
    '2. **Value B** — behavioral example',
    '3. **Value C** — behavioral example',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.vmv',
  })
  return true
}

export function paragraphsToTalkOutlineText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const norm = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  return [
    '## Presentation Outline',
    '',
    '### 🪝 Hook',
    norm[0] || '_(to be completed)_',
    '',
    '### ❓ Problem',
    norm[1] || '_(to be completed)_',
    '',
    '### 💡 Solution',
    norm[2] || '_(to be completed)_',
    '',
    '### 🙏 Ask',
    norm[3] || '_(to be completed)_',
    '',
  ].join('\n')
}

export const paragraphsToTalkOutline: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTalkOutlineText, 'transform.talk-outline')

export function tagStatsTop5Text(source: string): string {
  const counts = new Map<string, number>()
  const tagRe = /(?<=^|[\s(])(#[\p{L}\p{N}_/-]+)/gu
  for (const match of source.matchAll(tagRe)) {
    const t = match[1]
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
  const out: string[] = ['## Top 5 Tags', '']
  for (const [tag, n] of sorted) {
    out.push(`- ${tag} — ${n} occurrences`)
  }
  if (sorted.length === 0) out.push('_(no tags)_')
  return [out.join('\n'), '', source.trim()].join('\n')
}

export const tagStatsTop5: Command = (view) =>
  applyToSelectionOrAll(view, tagStatsTop5Text, 'transform.tag-top5')

export const insertReleaseChecklistPlus: Command = (view) => {
  const text = [
    '## Release Checklist+',
    '',
    '### Code',
    '- [ ] All PRs merged',
    '- [ ] CI green',
    '- [ ] Critical path manual test',
    '- [ ] Performance baseline ≤ 10% regression',
    '',
    '### Documentation',
    '- [ ] CHANGELOG updated',
    '- [ ] Upgrade / migration guide',
    '- [ ] Internal wiki / FAQ updated',
    '',
    '### Monitoring',
    '- [ ] Dashboard prepared',
    '- [ ] Alert thresholds reviewed',
    '- [ ] Log schema compatible',
    '',
    '### Rollback',
    '- [ ] Rollback plan documented',
    '- [ ] Data migration reversible / dual-write',
    '',
    '### Communication',
    '- [ ] Internal broadcast',
    '- [ ] Customer notification (if needed)',
    '- [ ] Support training',
    '',
    '### Post-launch',
    '- [ ] 30 min smoke observation',
    '- [ ] 24 h metric review',
    '- [ ] Retrospective scheduled',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.release-plus',
  })
  return true
}

export function paragraphsToPodcastNotesText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## Podcast Notes', '']
  paras.forEach((p, i) => {
    const clean = p.replace(/\s+/g, ' ').trim()
    const mm = String(Math.floor(i * 5)).padStart(2, '0')
    out.push(`### [${mm}:00] ${clean.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || clean}`)
    out.push('')
    out.push(clean)
    out.push('')
  })
  return out.join('\n').trimEnd()
}

export const paragraphsToPodcastNotes: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToPodcastNotesText, 'transform.podcast-notes')

export function normalizeFenceLanguageText(source: string): string {
                         
  const lines = source.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(```+|~~~+)(.*)$/.exec(lines[i])
    if (!m) continue
    if (!inFence) {
      const tag = m[3].trim()
      if (tag === '') {
        lines[i] = `${m[1]}${m[2]}txt`
      }
      inFence = true
    } else {
      inFence = false
    }
  }
  return lines.join('\n')
}

export const normalizeFenceLanguage: Command = (view) =>
  applyToSelectionOrAll(view, normalizeFenceLanguageText, 'lint.fence-lang')

export const insertMindDiaryTemplate: Command = (view) => {
  const text = [
    '## Mood Journal',
    '',
    '**Date**:',
    '**Overall mood**: 😀😐😞 / 1–10',
    '',
    '### What happened today',
    '',
    '### What I was thinking at the time',
    '',
    '### Looking back now',
    '',
    '### One act of self-compassion',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.mind-diary',
  })
  return true
}

export function joinLinesAsSentencesText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  const out: string[] = []
  for (const line of lines) {
    let l = line
    if (!/\p{Sentence_Terminal}$/u.test(l)) l = l + '.'
    out.push(l)
  }
  return out.join(' ')
}

export const joinLinesAsSentences: Command = (view) =>
  applyToSelectionOrAll(view, joinLinesAsSentencesText, 'transform.join-sentences')

// ============================================================================
// Batch #219: strategy canvas, story pitch, quadrant
// ============================================================================

export const insertStrategyCanvas: Command = (view) => {
  const text = [
    '## Strategy Canvas',
    '',
    '| Value factor | Industry avg | Us |',
    '| --- | --- | --- |',
    '| Price | M | L |',
    '| Speed | M | H |',
    '| Experience | M | H |',
    '| Coverage | H | M |',
    '| Service | M | H |',
    '',
    '### Eliminate',
    '- ',
    '',
    '### Reduce',
    '- ',
    '',
    '### Raise',
    '- ',
    '',
    '### Create',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.strategy-canvas',
  })
  return true
}

export function paragraphsToStoryPitchText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const first = paras[0].replace(/\s+/g, ' ').trim()
  const logline = first.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || first
  const synopsis = paras.slice(0, 3).map((p) => p.replace(/\s+/g, ' ').trim()).join(' ')
  return [
    '## Story Pitch',
    '',
    '### Logline',
    `> ${logline}`,
    '',
    '### Synopsis',
    synopsis,
    '',
    '### Tone & Audience',
    '- Style:',
    '- Audience:',
    '- Length:',
    '',
  ].join('\n')
}

export const paragraphsToStoryPitch: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToStoryPitchText, 'transform.story-pitch')

export const insertExperimentDesign: Command = (view) => {
  const text = [
    '## Experiment Design',
    '',
    '### 1. Hypothesis',
    '- We believe …',
    '- When …',
    '- We will observe …',
    '',
    '### 2. Method',
    '- User segment:',
    '- Traffic split:',
    '- Duration:',
    '- Sample size estimate:',
    '',
    '### 3. Key Metrics',
    '- Primary metric:',
    '- Guardrail metric:',
    '- Counter metric:',
    '',
    '### 4. Significance',
    '- Statistical test: t-test / chi-square / Bayesian',
    '- Significance level α: 0.05',
    '- Power 1-β: 0.8',
    '',
    '### 5. Risks',
    '- Data contamination:',
    '- Long-term effects:',
    '',
    '### 6. Exit Criteria',
    '- Early stop:',
    '- Failure rollback:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.experiment-design',
  })
  return true
}

export function bulletsNestByDepthMarkerText(source: string): string {
                                   
  const lines = source.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const m = /^(\s*)(>+)\s*[-*+]?\s*(.+)$/.exec(line)
    if (!m) {
      const bm = /^(\s*)[-*+]\s+(.+)$/.exec(line)
      if (bm) {
        out.push(`- ${bm[2]}`)
      } else {
        out.push(line)
      }
      continue
    }
    const depth = m[2].length - 1
    const indent = '  '.repeat(depth)
    out.push(`${indent}- ${m[3]}`)
  }
  return out.join('\n')
}

export const bulletsNestByDepthMarker: Command = (view) =>
  applyToSelectionOrAll(view, bulletsNestByDepthMarkerText, 'transform.nest-by-depth')

export const insertChurnAnalysis: Command = (view) => {
  const text = [
    '## Churn Analysis',
    '',
    '**Period**:',
    '**Churn definition**:',
    '',
    '### 1. Overview',
    '| Dimension | Value |',
    '| --- | --- |',
    '| Monthly churn rate | % |',
    '| Period-over-period | %p |',
    '| MRR impact | $ |',
    '',
    '### 2. Segments',
    '| Segment | Churn rate | Share |',
    '| --- | --- | --- |',
    '| New (<30d) |  |  |',
    '| Mid-stage (1–6m) |  |  |',
    '| Mature (>6m) |  |  |',
    '',
    '### 3. Top reasons (exit survey)',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### 4. Retention strategies',
    '- [ ] Improve onboarding',
    '- [ ] Proactive outreach',
    '- [ ] Pricing / plan adjustments',
    '- [ ] Feature gaps',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.churn-analysis',
  })
  return true
}

export function paragraphsToFAQShortText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## FAQ', '']
  for (const p of paras) {
    const clean = p.replace(/\s+/g, ' ').trim()
    const m = /^(.+?)[:?]\s*(.+)$/.exec(clean)
    if (m) {
      out.push(`**Q: ${m[1]}**`)
      out.push('')
      out.push(`A: ${m[2]}`)
    } else {
      out.push(`**Q: ${clean.slice(0, 40)}**`)
      out.push('')
      out.push('A: _(to be completed)_')
    }
    out.push('')
  }
  return out.join('\n').trimEnd()
}

export const paragraphsToFAQShort: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFAQShortText, 'transform.faq-short')

export const insertSpeakingPrep: Command = (view) => {
  const text = [
    '## Presentation Prep',
    '',
    '**Topic**:',
    '**Occasion / Audience**:',
    '**Duration**:',
    '',
    '### Core message',
    '> ',
    '',
    '### 3 Takeaways',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### Stories / Examples',
    '- ',
    '',
    '### Objection handling',
    '| Likely challenge | My response |',
    '| --- | --- |',
    '|  |  |',
    '',
    '### Materials',
    '- [ ] Slides',
    '- [ ] Speaker notes',
    '- [ ] Q&A notes',
    '- [ ] Backup demo / video',
    '',
    '### Self-check',
    '- [ ] Full run-through ≥ 2 times',
    '- [ ] Duration within ±10%',
    '- [ ] Key terms explained clearly',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.speaking-prep',
  })
  return true
}

export const insertQuadrantChart: Command = (view) => {
  const text = [
    '```mermaid',
    'quadrantChart',
    '  title Impact vs Effort',
    '  x-axis Low effort --> High effort',
    '  y-axis Low impact --> High impact',
    '  quadrant-1 Quick Wins',
    '  quadrant-2 Strategic',
    '  quadrant-3 Fill-ins',
    '  quadrant-4 Reconsider',
    '  Idea A: [0.2, 0.8]',
    '  Idea B: [0.7, 0.7]',
    '  Idea C: [0.3, 0.3]',
    '  Idea D: [0.8, 0.2]',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.quadrant-chart',
  })
  return true
}

export function renumberOrderedListText(source: string): string {
                                         
  const lines = source.split('\n')
  const out: string[] = []
  type Counter = { indent: number; n: number }
  let stack: Counter[] = []
  for (const line of lines) {
    const m = /^(\s*)\d+\.\s+(.*)$/.exec(line)
    if (!m) {
      out.push(line)
                       
      if (!/^\s*$/.test(line)) {
        stack = stack.filter((c) => c.indent < (line.match(/^\s*/)?.[0].length ?? 0))
      }
      continue
    }
    const ind = m[1].length
    while (stack.length > 0 && stack[stack.length - 1].indent > ind) stack.pop()
    let cur: Counter
    if (stack.length === 0 || stack[stack.length - 1].indent < ind) {
      cur = { indent: ind, n: 1 }
      stack.push(cur)
    } else {
      cur = stack[stack.length - 1]
      cur.n++
    }
    out.push(`${m[1]}${cur.n}. ${m[2]}`)
  }
  return out.join('\n')
}

export const renumberOrderedList: Command = (view) =>
  applyToSelectionOrAll(view, renumberOrderedListText, 'lint.renumber-ol')

export const insertOKRReviewSnapshot: Command = (view) => {
  const text = [
    '## OKR Quarterly Review',
    '',
    '**Quarter**:',
    '**Score**: self-assessment 0.0–1.0',
    '',
    '### Overall scores',
    '| Objective | Score | Notes |',
    '| --- | --- | --- |',
    '| O1 |  |  |',
    '| O2 |  |  |',
    '',
    '### Highlights',
    '- ',
    '',
    '### Main regrets',
    '- ',
    '',
    '### Next quarter adjustments',
    '- Continue:',
    '- Stop:',
    '- Start:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.okr-review',
  })
  return true
}

export function paragraphsToMemoText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  const out: string[] = []
  out.push('## MEMO')
  out.push('')
  out.push('**TO**:')
  out.push('**FROM**:')
  out.push('**RE**:')
  out.push(`**DATE**: ${yyyy}-${mm}-${dd}`)
  out.push('')
  out.push('---')
  out.push('')
  for (const p of paras) out.push(p.replace(/\s+/g, ' ').trim(), '')
  return out.join('\n').trimEnd()
}

export const paragraphsToMemo: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToMemoText, 'transform.memo')

export function wrapLinesInParensText(source: string): string {
  return source.split('\n').map((l) => {
    if (l.trim().length === 0) return l
    return `(${l.trim()})`
  }).join('\n')
}

export const wrapLinesInParens: Command = (view) =>
  applyToSelectionOrAll(view, wrapLinesInParensText, 'transform.wrap-parens')

// ============================================================================
// Batch #220: journey-map, brand voice, recipe
// ============================================================================

export const insertJourneyMapTemplate: Command = (view) => {
  const text = [
    '## User Journey Map',
    '',
    '**Persona**:',
    '**Scenario**:',
    '',
    '| Stage | Awareness | Touchpoint | Action | Emotion | Pain point | Opportunity |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| Discover |  |  |  | 😐 |  |  |',
    '| Consider |  |  |  | 🙂 |  |  |',
    '| Decide |  |  |  | 😀 |  |  |',
    '| Use |  |  |  | 😐 |  |  |',
    '| Advocate |  |  |  | 🤩 |  |  |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.journey-map',
  })
  return true
}

export function paragraphsToArgumentStructureText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const norm = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  return [
    '## Argument Structure',
    '',
    '### Claim',
    norm[0] || '_(to be completed)_',
    '',
    '### Reason',
    norm[1] || '_(to be completed)_',
    '',
    '### Evidence',
    norm[2] || '_(to be completed)_',
    '',
    '### Counterargument',
    norm[3] || '_(to be completed)_',
    '',
    '### Rebuttal',
    norm[4] || '_(to be completed)_',
    '',
  ].join('\n')
}

export const paragraphsToArgumentStructure: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToArgumentStructureText, 'transform.argument')

export const insertBrandVoiceGuide: Command = (view) => {
  const text = [
    '## Brand Voice Guide',
    '',
    '### Our voice is…',
    '- A set of **like... not...** examples',
    '',
    '| Like | Not like |',
    '| --- | --- |',
    '| Genuine | Flattering |',
    '| Confident | Arrogant |',
    '| Lively | Hyperbolic |',
    '| Professional | Cold |',
    '',
    '### Five usage contexts',
    '1. Marketing copy:',
    '2. Support replies:',
    '3. Error messages:',
    '4. Onboarding copy:',
    '5. Internal announcements:',
    '',
    '### Banned words',
    '- ',
    '',
    '### Preferred words',
    '- ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.brand-voice',
  })
  return true
}

export function bulletsToBingoCardText(source: string): string {
  const lines = source.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) items.push(m[1].trim())
  }
  // take 24 items; position 13 = FREE
  const cells = items.slice(0, 24)
  while (cells.length < 24) cells.push('—')
  const grid: string[] = []
  let idx = 0
  for (let row = 0; row < 5; row++) {
    const cols: string[] = []
    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) {
        cols.push('★ FREE ★')
      } else {
        cols.push(cells[idx++])
      }
    }
    grid.push('| ' + cols.join(' | ') + ' |')
    if (row === 0) {
      grid.push('| --- | --- | --- | --- | --- |')
    }
  }
  return ['## Bingo Card', '', ...grid, ''].join('\n')
}

export const bulletsToBingoCard: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToBingoCardText, 'transform.bingo-card')

export const insertWeddingChecklist: Command = (view) => {
  const text = [
    '## Wedding Checklist',
    '',
    '### 12 months out',
    '- [ ] Engagement / proposal ceremony',
    '- [ ] Overall budget',
    '- [ ] Style / theme decision',
    '- [ ] Guest list draft',
    '- [ ] Compare wedding planners',
    '',
    '### 6 months out',
    '- [ ] Venue booking',
    '- [ ] Photographer / videographer contract',
    '- [ ] Wedding dress / attire shortlist',
    '- [ ] Invitation design',
    '- [ ] Reception menu draft',
    '',
    '### 3 months out',
    '- [ ] Send invitations',
    '- [ ] Confirm wedding rings',
    '- [ ] Honeymoon itinerary',
    '- [ ] Rehearsal details',
    '',
    '### 1 month out',
    '- [ ] Final headcount',
    '- [ ] MC / officiant briefing',
    '- [ ] Hair & makeup trial',
    '- [ ] Gift envelopes prepared',
    '',
    '### The week of',
    '- [ ] Pick up attire',
    '- [ ] Pack luggage / wedding items',
    '- [ ] Emergency contacts list',
    '- [ ] Rest!',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.wedding-checklist',
  })
  return true
}

export function paragraphsToAphorismCardsText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## Aphorism Cards', '']
  for (const p of paras) {
    const clean = p.replace(/\s+/g, ' ').trim()
    const sent = clean.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || clean
    out.push('> [!quote]')
    out.push(`> ${sent}`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

export const paragraphsToAphorismCards: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToAphorismCardsText, 'transform.aphorism-cards')

export const insertRecipeTemplate: Command = (view) => {
  const text = [
    '# Recipe name',
    '',
    '**Servings**: portions',
    '**Time**: minutes',
    '**Difficulty**: Easy / Medium / Hard',
    '',
    '## Ingredients',
    '### Main',
    '- ',
    '',
    '### Seasonings',
    '- ',
    '',
    '## Steps',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Key tips',
    '> ',
    '',
    '## Substitutions',
    '- ',
    '',
    '## Nutrition',
    '| Nutrient | Per serving |',
    '| --- | --- |',
    '| Calories |  kcal |',
    '| Protein |  g |',
    '| Carbs |  g |',
    '| Fat |  g |',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.recipe',
  })
  return true
}

export function linesToIndexedFAQText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  const out: string[] = ['## FAQ Index', '']
  lines.forEach((l, i) => {
    out.push(`${i + 1}. **Q: ${l}**`)
    out.push('   A: _(to be completed)_')
    out.push('')
  })
  return out.join('\n').trimEnd()
}

export const linesToIndexedFAQ: Command = (view) =>
  applyToSelectionOrAll(view, linesToIndexedFAQText, 'transform.indexed-faq')

export function normalizeBulletMarkerToDotText(source: string): string {
               
  return source.split('\n').map((line) => {
    const m = /^(\s*)\*\s+(.+)$/.exec(line)
    if (m) return `${m[1]}• ${m[2]}`
    return line
  }).join('\n')
}

export const normalizeBulletMarkerToDot: Command = (view) =>
  applyToSelectionOrAll(view, normalizeBulletMarkerToDotText, 'lint.bullet-to-dot')

export const insertVacationItinerary: Command = (view) => {
  const text = [
    '## Vacation Itinerary',
    '',
    '**Destination**:',
    '**Dates**:',
    '**Group size**:',
    '**Budget**:',
    '',
    '### Day 1',
    '- Morning:',
    '- Afternoon:',
    '- Evening:',
    '- Accommodation:',
    '',
    '### Day 2',
    '- Morning:',
    '- Afternoon:',
    '- Evening:',
    '- Accommodation:',
    '',
    '### Essentials',
    '- [ ] Passport / ID',
    '- [ ] Charger / adapter',
    '- [ ] Medications',
    '- [ ] Cash / cards',
    '',
    '### Contingency',
    '- If raining:',
    '- Health emergency:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.vacation',
  })
  return true
}

export function paragraphsToThesisStatementText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const claim = (paras[0] || '').replace(/\s+/g, ' ').trim()
  const reason = (paras[1] || '').replace(/\s+/g, ' ').trim() || '_(to be completed)_'
  const sentClaim = claim.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || claim
  const sentReason = reason.split(/(?<=\p{Sentence_Terminal})\s/u)[0] || reason
  return [
    '## Thesis Statement',
    '',
    `**Claim**: ${sentClaim}`,
    '',
    `**Reason**: ${sentReason}`,
    '',
    `**Thesis**: ${sentClaim.replace(/\p{Sentence_Terminal}\s*$/u, '')}, because ${sentReason.replace(/\p{Sentence_Terminal}\s*$/u, '')}.`,
    '',
  ].join('\n')
}

export const paragraphsToThesisStatement: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToThesisStatementText, 'transform.thesis')

export function stripDiacriticsText(source: string): string {
                        
  return source.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

export const stripDiacritics: Command = (view) =>
  applyToSelectionOrAll(view, stripDiacriticsText, 'transform.strip-diacritics')

// ============================================================================
// Batch #221: KPI tree, lesson plan, investor update
// ============================================================================

export const insertKPITree: Command = (view) => {
  const text = [
    '```mermaid',
    'graph TD',
    '  N[North Star - MAU]',
    '  N --> A1[New users]',
    '  N --> A2[Retained users]',
    '  A1 --> B1[Channel traffic]',
    '  A1 --> B2[Activation rate]',
    '  A2 --> B3[D7 retention]',
    '  A2 --> B4[Key action completion]',
    '  B1 --> C1[SEO traffic]',
    '  B1 --> C2[Paid channels]',
    '  B1 --> C3[Social sharing]',
    '  B2 --> C4[Onboarding completion rate]',
    '  B3 --> C5[D1 / D7 funnel]',
    '  B4 --> C6[Core feature penetration rate]',
    '```',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.kpi-tree',
  })
  return true
}

export function paragraphsToSalesPitchText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const n = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  return [
    '## Sales Pitch',
    '',
    '### ❓ Problem',
    n[0] || '_(to be filled)_',
    '',
    '### 💡 Solution',
    n[1] || '_(to be filled)_',
    '',
    '### 💎 Value',
    n[2] || '_(to be filled)_',
    '',
    '### 🚀 Call to Action',
    n[3] || '_(to be filled)_',
    '',
  ].join('\n')
}

export const paragraphsToSalesPitch: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToSalesPitchText, 'transform.sales-pitch')

export const insertSleepLogTemplate: Command = (view) => {
  const text = [
    '## Sleep Log',
    '',
    '**Date**:',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| Bedtime |  |',
    '| Wake time |  |',
    '| Total duration |  h |',
    '| Wake-ups |  |',
    '| Subjective quality | 1–10 |',
    '| Energy level | 1–10 |',
    '',
    '### Associated factors',
    '- Caffeine (mg):',
    '- Exercise:',
    '- Screen time (after 9pm):',
    '- Alcohol:',
    '- Stress (1–10):',
    '',
    '### Notes',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.sleep-log',
  })
  return true
}

export function bulletsToRadarChartText(source: string): string {
  const lines = source.split('\n')
  const items: { name: string; val: number }[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+?)[\s:]+(\d+(?:\.\d+)?)\s*$/.exec(line)
    if (m) items.push({ name: m[1].trim(), val: parseFloat(m[2]) })
  }
  if (items.length === 0) return source
  const out: string[] = []
  out.push('| Dimension | Score | Visualization |')
  out.push('| --- | --- | --- |')
  const max = Math.max(...items.map((i) => i.val), 10)
  for (const it of items) {
    const filled = Math.round((it.val / max) * 10)
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
    out.push(`| ${it.name} | ${it.val} | \`${bar}\` |`)
  }
  return out.join('\n')
}

export const bulletsToRadarChart: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToRadarChartText, 'transform.radar-chart')

export const insertClassroomLessonPlan: Command = (view) => {
  const text = [
    '## Classroom Lesson Plan',
    '',
    '**Duration**: minutes',
    '**Subject**:',
    '**Audience / Level**:',
    '',
    '### 1. Learning objectives',
    '- Knowledge:',
    '- Skills:',
    '- Attitudes:',
    '',
    '### 2. Key points / Difficulties',
    '- Key points:',
    '- Difficulties:',
    '',
    '### 3. Student background',
    '',
    '### 4. Teaching process',
    '| Phase | Duration | Teacher activity | Student activity |',
    '| --- | --- | --- | --- |',
    '| Warm-up | 5 min |  |  |',
    '| Instruction | 25 min |  |  |',
    '| Practice | 10 min |  |  |',
    '| Summary | 5 min |  |  |',
    '',
    '### 5. Board design',
    '```',
    '',
    '',
    '```',
    '',
    '### 6. Homework',
    '- ',
    '',
    '### 7. Reflection',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.lesson-plan',
  })
  return true
}

export function paragraphsToStandupStatusText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const norm = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  return [
    '## Standup Report',
    '',
    '### Yesterday',
    norm[0] || '_(to be completed)_',
    '',
    '### Today',
    norm[1] || '_(to be completed)_',
    '',
    '### Blockers',
    norm[2] || '_(none)_',
    '',
  ].join('\n')
}

export const paragraphsToStandupStatus: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToStandupStatusText, 'transform.standup-status')

export const insertInvestorUpdate: Command = (view) => {
  const text = [
    '# Investor Monthly Update',
    '',
    '**Month**:',
    '**Core KPI**:',
    '',
    '## 1. Highlights',
    '- ',
    '',
    '## 2. Lowlights',
    '- ',
    '',
    '## 3. Key Metrics',
    '| Metric | Last month | This month | Growth |',
    '| --- | --- | --- | --- |',
    '| MRR |  |  |  |',
    '| Active customers |  |  |  |',
    '| Churn |  |  |  |',
    '| Cash (Runway) |  |  |  |',
    '',
    '## 4. Team',
    '- New members:',
    '- Departures:',
    '- Open roles:',
    '',
    '## 5. Asks',
    '- ',
    '',
    '## 6. Next month focus',
    '- ',
    '',
    '> Thank you for your continued support.',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.investor-update',
  })
  return true
}

export function linesToReadingListText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
  const out: string[] = ['## Reading List', '']
  for (const l of lines) {
    out.push(`- [ ] **${l}** — _author TBD_`)
  }
  return out.join('\n')
}

export const linesToReadingList: Command = (view) =>
  applyToSelectionOrAll(view, linesToReadingListText, 'transform.reading-list')

export function paragraphsToTwitterThreadText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const cleaned = paras.map((p) => p.replace(/\s+/g, ' ').trim())
  const total = cleaned.length
  const out: string[] = ['## Twitter Thread', '']
  cleaned.forEach((p, i) => {
    out.push(`### ${i + 1}/${total}`)
    out.push('')
    out.push(p.length <= 280 ? p : p.slice(0, 277) + '...')
    out.push('')
  })
  return out.join('\n').trimEnd()
}

export const paragraphsToTwitterThread: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTwitterThreadText, 'transform.twitter-thread')

export function normalizeMarkdownLinksToRefStyleText(source: string): string {
                                          
  type Ref = { idx: number; url: string }
  const refs: Ref[] = []
  let counter = 1
  const lines = source.split('\n')
  const transformed = lines.map((line) => {
                                          
    return line.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => {
      const existing = refs.find((r) => r.url === url)
      const idx = existing ? existing.idx : counter
      if (!existing) {
        refs.push({ idx: counter, url })
        counter++
      }
      return `[${text}][${idx}]`
    })
  })
  if (refs.length === 0) return source
  transformed.push('')
  for (const r of refs) {
    transformed.push(`[${r.idx}]: ${r.url}`)
  }
  return transformed.join('\n')
}

export const normalizeMarkdownLinksToRefStyle: Command = (view) =>
  applyToSelectionOrAll(view, normalizeMarkdownLinksToRefStyleText, 'lint.links-to-ref')

export const insertGroceryList: Command = (view) => {
  const text = [
    '## Grocery List',
    '',
    '### Produce',
    '- [ ] ',
    '',
    '### Meat & eggs',
    '- [ ] ',
    '',
    '### Grains / staples',
    '- [ ] ',
    '',
    '### Dairy',
    '- [ ] ',
    '',
    '### Seasonings / condiments',
    '- [ ] ',
    '',
    '### Household / cleaning',
    '- [ ] ',
    '',
    '### Snacks / drinks',
    '- [ ] ',
    '',
    '**Budget**:',
    '**Store**:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.grocery-list',
  })
  return true
}

export function headingsToTitleCaseText(source: string): string {
                                     
  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on',
    'or', 'so', 'the', 'to', 'up', 'with', 'yet',
  ])
  return source.split('\n').map((line) => {
    const m = /^(\s*#{1,6}\s+)(.*)$/.exec(line)
    if (!m) return line
    const prefix = m[1]
    const text = m[2]
    const words = text.split(/(\s+)/)
    const out: string[] = []
    let firstWordIndex = -1
    for (let i = 0; i < words.length; i++) {
      if (!/^\s+$/.test(words[i])) {
        firstWordIndex = i
        break
      }
    }
    let lastWordIndex = -1
    for (let i = words.length - 1; i >= 0; i--) {
      if (!/^\s+$/.test(words[i])) {
        lastWordIndex = i
        break
      }
    }
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (/^\s+$/.test(w)) {
        out.push(w)
        continue
      }
      const lc = w.toLowerCase()
      const isAsciiWord = /^[A-Za-z][A-Za-z0-9'-]*$/.test(w)
      if (
        isAsciiWord
        && minorWords.has(lc)
        && i !== firstWordIndex
        && i !== lastWordIndex
      ) {
        out.push(lc)
      } else if (isAsciiWord) {
        out.push(lc[0].toUpperCase() + lc.slice(1))
      } else {
        out.push(w)
      }
    }
    return prefix + out.join('')
  }).join('\n')
}

export const headingsToTitleCase: Command = (view) =>
  applyToSelectionOrAll(view, headingsToTitleCaseText, 'transform.title-case-headings')

// ============================================================================
// Batch #222: ADR tracker, UX research, advent
// ============================================================================

export const insertADRTracker: Command = (view) => {
  const text = [
    '## Architecture Decision Tracker',
    '',
    '| # | Title | Status | Date | Scope | Link |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 001 | Choose PostgreSQL | Accepted | YYYY-MM-DD | Data | [[ADR-001]] |',
    '| 002 | Replace Webpack with Vite | Accepted | YYYY-MM-DD | Build | [[ADR-002]] |',
    '| 003 | gRPC protocol | Proposed | YYYY-MM-DD | API |  |',
    '| 004 | Introduce message queue | Superseded | YYYY-MM-DD | Async | [[ADR-004]] |',
    '',
    '**Status values**: Proposed / Accepted / Deprecated / Superseded',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.adr-tracker',
  })
  return true
}

export function paragraphsToMeetingSummaryText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  type Item = { kind: 'decision' | 'action' | 'note'; text: string; owner?: string }
  const items: Item[] = []
  for (const p of paras) {
    const clean = p.replace(/\s+/g, ' ').trim()
    const dec = /^(?:decision|decided):\s*(.+)$/i.exec(clean)
    if (dec) {
      items.push({ kind: 'decision', text: dec[1] })
      continue
    }
    const act = /^(?:action|todo):\s*(.+?)(?:\s*\(([^)]+)\))?$/i.exec(clean)
    if (act) {
      items.push({ kind: 'action', text: act[1], owner: act[2] })
      continue
    }
    items.push({ kind: 'note', text: clean })
  }
  const out: string[] = ['## Meeting Notes', '']
  const decisions = items.filter((i) => i.kind === 'decision')
  const actions = items.filter((i) => i.kind === 'action')
  const notes = items.filter((i) => i.kind === 'note')
  out.push('### Decisions')
  if (decisions.length === 0) out.push('- _(none)_')
  else for (const d of decisions) out.push(`- ${d.text}`)
  out.push('')
  out.push('### Action Items')
  if (actions.length === 0) {
    out.push('- _(none)_')
  } else {
    for (const a of actions) {
      const owner = a.owner ? `(${a.owner})` : ''
      out.push(`- [ ] ${a.text} ${owner}`.trimEnd())
    }
  }
  out.push('')
  out.push('### Notes')
  if (notes.length === 0) out.push('- _(none)_')
  else for (const n of notes) out.push(`- ${n.text}`)
  out.push('')
  return out.join('\n')
}

export const paragraphsToMeetingSummary: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToMeetingSummaryText, 'transform.meeting-summary')

export const insertUXResearchPlan: Command = (view) => {
  const text = [
    '## UX Research Plan',
    '',
    '**Topic**:',
    '**Lead**:',
    '**Timeline**:',
    '',
    '### 1. Research questions',
    '- Primary question:',
    '- Sub-questions:',
    '',
    '### 2. Hypotheses',
    '- ',
    '',
    '### 3. Methods',
    '| Method | Sample size | Duration |',
    '| --- | --- | --- |',
    '| User interviews | 6 | 60 min |',
    '| Usability testing | 8 | 45 min |',
    '| Survey | 100 | 5 min |',
    '',
    '### 4. Recruitment criteria',
    '- Must have:',
    '- Exclude:',
    '- Source:',
    '',
    '### 5. Timeline',
    '| Week | Phase |',
    '| --- | --- |',
    '| W1 | Recruitment / script |',
    '| W2 | Sessions |',
    '| W3 | Analysis |',
    '| W4 | Report / share |',
    '',
    '### 6. Deliverables',
    '- [ ] Research script',
    '- [ ] Raw session notes',
    '- [ ] Thematic analysis',
    '- [ ] Summary report + recommendations',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.ux-research',
  })
  return true
}

export function linesToHaikuText(source: string): string {
  const lines = source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return source
                                    
  const estimateSyllables = (s: string): number => {
    let count = 0
    // CJK chars
    const cjk = s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)
    if (cjk) count += cjk.length
    // English words: count vowel groups
    const enWords = s.match(/[A-Za-z]+/g) || []
    for (const w of enWords) {
      const groups = w.toLowerCase().match(/[aeiouy]+/g) || []
      count += Math.max(1, groups.length)
    }
    return count
  }
  const out: string[] = ['## Haiku Draft', '']
  for (const l of lines) {
    out.push(`- ${l}  _(approximately ${estimateSyllables(l)} syllables)_`)
  }
  out.push('')
  out.push('> Haiku target: 5 / 7 / 5')
  return out.join('\n')
}

export const linesToHaiku: Command = (view) =>
  applyToSelectionOrAll(view, linesToHaikuText, 'transform.haiku')

export const insertTournamentBracket: Command = (view) => {
  const text = [
    '## Single Elimination Bracket',
    '',
    '```',
    'Semi-finals            Final',
    '',
    'Player 1 ─┐',
    '           ├─ Winner 1 ─┐',
    'Player 2 ─┘              │',
    '                          ├── Champion ──',
    'Player 3 ─┐              │',
    '           ├─ Winner 2 ─┘',
    'Player 4 ─┘',
    '```',
    '',
    '### Registration',
    '1. Player 1',
    '2. Player 2',
    '3. Player 3',
    '4. Player 4',
    '',
    '### Results',
    '- Semi-final 1:',
    '- Semi-final 2:',
    '- Final:',
    '- **Champion**:',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.tournament-bracket',
  })
  return true
}

export function paragraphsToQuoteSandwichText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  if (paras.length === 0) return source
  const out: string[] = ['## Quote Sandwich', '']
  for (let i = 0; i < paras.length; i += 3) {
    const intro = (paras[i] || '').replace(/\s+/g, ' ').trim()
    const quote = (paras[i + 1] || '').replace(/\s+/g, ' ').trim()
    const analysis = (paras[i + 2] || '').replace(/\s+/g, ' ').trim()
    if (intro) out.push(`**Context**: ${intro}`, '')
    if (quote) out.push(`> ${quote}`, '')
    if (analysis) out.push(`**Analysis**: ${analysis}`, '')
    out.push('---', '')
  }
  return out.join('\n').trimEnd()
}

export const paragraphsToQuoteSandwich: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToQuoteSandwichText, 'transform.quote-sandwich')

export const insertAdventCalendar: Command = (view) => {
  const lines: string[] = ['## 25-Day Advent Calendar', '']
  for (let i = 1; i <= 25; i++) {
    lines.push(`### Day ${i}`)
    lines.push('- [ ] ')
    lines.push('')
  }
  const text = lines.join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.advent',
  })
  return true
}

export function bulletsToSwimLaneText(source: string): string {
                                                     
  const lines = source.split('\n')
  type Msg = { from: string; to: string; text: string }
  const messages: Msg[] = []
  const actors = new Set<string>()
  for (const line of lines) {
    const m = /^\s*[-*+]\s+([^:]+):\s*(.+)$/.exec(line)
    if (!m) continue
    const from = m[1].trim()
    let to = ''
    let text = m[2].trim()
    const arrow = /^(.+?)\s*->\s*(.+?)$/.exec(text)
    if (arrow) {
      text = arrow[1].trim()
      to = arrow[2].trim()
    } else {
      to = 'Self'
    }
    actors.add(from)
    if (to !== 'Self') actors.add(to)
    messages.push({ from, to, text })
  }
  if (messages.length === 0) return source
  const out: string[] = ['```mermaid', 'sequenceDiagram']
  for (const a of actors) out.push(`  participant ${a.replace(/\s+/g, '_')}`)
  for (const m of messages) {
    if (m.to === 'Self') {
      out.push(`  ${m.from.replace(/\s+/g, '_')}->>+${m.from.replace(/\s+/g, '_')}: ${m.text}`)
    } else {
      out.push(`  ${m.from.replace(/\s+/g, '_')}->>+${m.to.replace(/\s+/g, '_')}: ${m.text}`)
    }
  }
  out.push('```')
  return out.join('\n')
}

export const bulletsToSwimLane: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToSwimLaneText, 'transform.swim-lane')

export const insertDailyMoodSnapshot: Command = (view) => {
  const text = [
    '## Daily Mood Snapshot',
    '',
    '**Date**:',
    '',
    '| Period | Mood (1–10) | Trigger |',
    '| --- | --- | --- |',
    '| Morning |  |  |',
    '| Midday |  |  |',
    '| Afternoon |  |  |',
    '| Evening |  |  |',
    '',
    '### Gratitude today',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### Intention tomorrow',
    '> ',
    '',
  ].join('\n')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'insert.mood-snapshot',
  })
  return true
}

export function normalizeHeadingSpacingText(source: string): string {
                                  
  return source.split('\n').map((line) => {
    const m = /^(#{1,6})\s*(.+?)\s*$/.exec(line)
    if (!m) return line
    if (m[2].length === 0) return line
    return `${m[1]} ${m[2]}`
  }).join('\n')
}

export const normalizeHeadingSpacing: Command = (view) =>
  applyToSelectionOrAll(view, normalizeHeadingSpacingText, 'lint.heading-spacing')

const FORTUNES = [
  'Unexpected good news is on its way today.',
  'One sentence can change your direction — stay alert.',
  'Write down what troubles you, and it will shrink by half.',
  'A neglected relationship deserves a fresh start today.',
  'Do not mistake exhaustion for clarity.',
  'Do small things well, and big things will naturally follow.',
  'An incomplete task has more value than one that never starts.',
  'Today is a good day to let go of an old goal.',
  'Your next insight is hiding in a conversation.',
  'Do not trust the first impression — but do respect it.',
]

export function paragraphsToFortuneCookiesText(source: string): string {
  const paras = source.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const base = paras.length > 0
    ? paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0)
    : FORTUNES
  // Fisher-Yates
  const arr = base.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  const out: string[] = ['## Fortune Cookies', '']
  for (const s of arr) {
    out.push('> 🥠')
    out.push(`> ${s}`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

export const paragraphsToFortuneCookies: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFortuneCookiesText, 'transform.fortune-cookies')

export function headingsToNumberedTOCLinksText(source: string): string {
                                      
  const lines = source.split('\n')
  type H = { level: number; text: string; slug: string }
  const headings: H[] = []
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const text = m[2]
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, '')
      .replace(/\s+/g, '-')
    headings.push({ level: m[1].length, text, slug })
  }
  if (headings.length === 0) return source
  const out: string[] = ['## Table of Contents', '']
  let n = 1
  for (const h of headings) {
    const indent = '  '.repeat(Math.max(0, h.level - 1))
    out.push(`${indent}${n}. [${h.text}](#${h.slug})`)
    n++
  }
  out.push('')
  out.push('---')
  out.push('')
  out.push(source.trim())
  return out.join('\n')
}

export const headingsToNumberedTOCLinks: Command = (view) =>
  applyToSelectionOrAll(view, headingsToNumberedTOCLinksText, 'transform.headings-to-numbered-toc')

// ===== Batch #223 =====

export const insertCapacityPlanningSheet: Command = (view) => {
  const text = [
    '## Capacity Planning',
    '',
    '**Period**:',
    '**Team**:',
    '',
    '| Member | Total hours | Leave | Meetings | Available | Allocated | Remaining |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '|  | 40 | 0 | 0 | 40 | 0 | 40 |',
    '|  | 40 | 0 | 0 | 40 | 0 | 40 |',
    '',
    '**Total available**:',
    '**Total allocated**:',
    '**Utilization**:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.capacity-planning' })
  return true
}

export function paragraphsToDemoScriptText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Demo Script', '']
  paragraphs.forEach((p, i) => {
    const seconds = (i + 1) * 30
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    out.push(`### [${mm}:${ss}] Scene ${i + 1}`)
    out.push('')
    out.push(`**Narration**: ${p}`)
    out.push('')
    out.push('**On-screen action**:')
    out.push('')
    out.push('---')
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToDemoScript: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToDemoScriptText, 'transform.demo-script')

export const insertColorPaletteCard: Command = (view) => {
  const text = [
    '## Color Palette',
    '',
    '**Theme name**:',
    '',
    '| Name | Hex | RGB | Usage |',
    '| --- | --- | --- | --- |',
    '| Primary | #2563EB | rgb(37,99,235) | Main brand color |',
    '| Accent | #F59E0B | rgb(245,158,11) | Emphasis / CTA |',
    '| Neutral | #6B7280 | rgb(107,114,128) | Text / borders |',
    '| Surface | #F9FAFB | rgb(249,250,251) | Background layer |',
    '| Success | #16A34A | rgb(22,163,74) | Success state |',
    '| Warning | #D97706 | rgb(217,119,6) | Warning state |',
    '| Danger | #DC2626 | rgb(220,38,38) | Error state |',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.color-palette' })
  return true
}

export function linesToABCPriorityText(source: string): string {
  const lines = source.split('\n')
  const buckets: Record<'A' | 'B' | 'C', string[]> = { A: [], B: [], C: [] }
  let any = false
  for (const raw of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(raw)
    if (!m) continue
    any = true
    const content = m[1].trim()
    let bucket: 'A' | 'B' | 'C' = 'C'
    if (/!!!|#a\b|^A:/i.test(content)) bucket = 'A'
    else if (/!!|#b\b|^B:/i.test(content)) bucket = 'B'
    const clean = content.replace(/!!!?|#[abc]\b|^[ABC]:\s*/i, '').trim()
    buckets[bucket].push(`- [${bucket}] ${clean}`)
  }
  if (!any) return source
  const out: string[] = ['## ABC Priorities', '']
  for (const k of ['A', 'B', 'C'] as const) {
    if (buckets[k].length === 0) continue
    out.push(`### Class ${k} - ${k === 'A' ? 'Must do' : k === 'B' ? 'Should do' : 'Could do'}`)
    out.push(...buckets[k])
    out.push('')
  }
  return out.join('\n')
}

export const linesToABCPriority: Command = (view) =>
  applyToSelectionOrAll(view, linesToABCPriorityText, 'transform.abc-priority')

export const insertRetroStarfish: Command = (view) => {
  const text = [
    '## Starfish Retrospective',
    '',
    '**Sprint**:',
    '**Date**:',
    '',
    '### ✨ More of',
    '- ',
    '',
    '### 🔁 Keep doing',
    '- ',
    '',
    '### 🚀 Start doing',
    '- ',
    '',
    '### ⏸️ Less of',
    '- ',
    '',
    '### 🛑 Stop doing',
    '- ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.retro-starfish' })
  return true
}

export function paragraphsToTestimonialWallText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Testimonial Wall', '']
  for (const p of paragraphs) {
    const m = /^(.+?)\s*[—-]\s*(.+)$/.exec(p)
    if (m) {
      out.push(`> "${m[1].trim()}"`)
      out.push(`> — ${m[2].trim()}`)
    } else {
      out.push(`> "${p}"`)
      out.push('> — Anonymous user')
    }
    out.push('')
  }
  return out.join('\n')
}

export const paragraphsToTestimonialWall: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToTestimonialWallText, 'transform.testimonial-wall')

export const insertRunbookTemplatePlus: Command = (view) => {
  const text = [
    '# Runbook:',
    '',
    '**Service**:',
    '**Severity**: P1 / P2 / P3',
    '**On-call contact**:',
    '',
    '## Trigger condition',
    '',
    '- Alert name:',
    '- Threshold:',
    '- Dashboard:',
    '',
    '## Diagnostic steps',
    '',
    '1. Check …',
    '2. Query logs `…`',
    '3. Verify upstream service health',
    '',
    '## Mitigation',
    '',
    '- [ ] Restart instance',
    '- [ ] Shift traffic to standby',
    '- [ ] Roll back recent release',
    '',
    '## Escalation path',
    '',
    'Not resolved within 15 min → escalate to …',
    '',
    '## Post-incident follow-up',
    '',
    '- [ ] File postmortem',
    '- [ ] Update this runbook',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.runbook-plus' })
  return true
}

export function bulletsToCommitmentLadderText(source: string): string {
  const lines = source.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) items.push(m[1].trim())
  }
  if (items.length === 0) return source
  const out: string[] = ['## Commitment Ladder', '']
  items.forEach((item, i) => {
    const level = i + 1
    const indent = '  '.repeat(i)
    out.push(`${indent}- [ ] **Lv${level}** · ${item}`)
  })
  return out.join('\n')
}

export const bulletsToCommitmentLadder: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToCommitmentLadderText, 'transform.commitment-ladder')

export const insertExecutiveSummaryTemplate: Command = (view) => {
  const text = [
    '# Executive Summary',
    '',
    '> One paragraph telling the reader: what happened, why it matters, and what they need to do.',
    '',
    '## Key findings',
    '',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## Impact',
    '',
    '- **Business**:',
    '- **Financial**:',
    '- **Risk**:',
    '',
    '## Recommendations',
    '',
    '- [ ] ',
    '',
    '## Decision required',
    '',
    '**Who needs to decide**:',
    '**By when**:',
    '**Options**:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.exec-summary' })
  return true
}

export function paragraphsToSoundbitesText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Quote Cards', '']
  for (const p of paragraphs) {
    const sentences = p.split(/(?<=\p{Sentence_Terminal})\s*/u).map((s) => s.trim()).filter(Boolean)
    if (sentences.length === 0) continue
    const best = sentences.reduce((a, b) => (Math.abs(b.length - 60) < Math.abs(a.length - 60) ? b : a))
    out.push('```')
    out.push(`💬 ${best}`)
    out.push('```')
    out.push('')
  }
  return out.join('\n')
}

export const paragraphsToSoundbites: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToSoundbitesText, 'transform.soundbites')

export function normalizeEmphasisMarkersText(source: string): string {
                                     
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    let next = line.replace(/(^|[^_\w])__([^_\s][^_]*?[^_\s]|[^_\s])__(?![_\w])/g, '$1**$2**')
    next = next.replace(/(^|[^_\w])_([^_\s][^_]*?[^_\s]|[^_\s])_(?![_\w])/g, '$1*$2*')
    out.push(next)
  }
  return out.join('\n')
}

export const normalizeEmphasisMarkers: Command = (view) =>
  applyToSelectionOrAll(view, normalizeEmphasisMarkersText, 'lint.emphasis-markers')

export const insertIncidentTimelineTemplate: Command = (view) => {
  const text = [
    '## Incident Timeline',
    '',
    '**Incident ID**:',
    '**Severity**:',
    '**Incident Commander**:',
    '',
    '| Time (UTC) | Source | Event | Actor |',
    '| --- | --- | --- | --- |',
    '| HH:MM | Alert |  |  |',
    '| HH:MM | User report |  |  |',
    '| HH:MM | Mitigation |  |  |',
    '| HH:MM | Recovery |  |  |',
    '| HH:MM | Close |  |  |',
    '',
    '**MTTD**:',
    '**MTTR**:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.incident-timeline' })
  return true
}

// ===== Batch #224 =====

export const insertReadingQueueTemplate: Command = (view) => {
  const text = [
    '## Reading Queue',
    '',
    '### 📖 Currently reading',
    '- [ ] ',
    '',
    '### ⏭️ Up next',
    '- [ ] ',
    '',
    '### 💾 Saved to read',
    '- [ ] ',
    '',
    '### ✅ Finished',
    '- [x] ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.reading-queue' })
  return true
}

export function paragraphsToStickyNoteBoardText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const colors = ['🟨', '🟦', '🟩', '🟧', '🟪', '🟥']
  const out: string[] = ['## Sticky Note Board', '']
  paragraphs.forEach((p, i) => {
    const c = colors[i % colors.length]
    out.push(`> ${c} **Note ${i + 1}**`)
    out.push(`> ${p.replace(/\n/g, '\n> ')}`)
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToStickyNoteBoard: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToStickyNoteBoardText, 'transform.sticky-board')

export const insertLinkRotScanTemplate: Command = (view) => {
  const text = [
    '## Link Audit',
    '',
    '**Scan date**:',
    '**Total links**:',
    '',
    '| URL | Status | HTTP | Checked | Replacement |',
    '| --- | --- | --- | --- | --- |',
    '|  | ✅ |  |  |  |',
    '|  | ⚠️ |  |  |  |',
    '|  | ❌ |  |  |  |',
    '',
    '### Broken link remediation',
    '- [ ] Replace with Wayback Machine snapshot',
    '- [ ] Contact author for update',
    '- [ ] Remove and archive',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.link-rot' })
  return true
}

export function linesToParetoBarText(source: string): string {
                                                         
  const lines = source.split('\n')
  type Item = { label: string; value: number }
  const items: Item[] = []
  for (const raw of lines) {
    let m: RegExpExecArray | null
    m = /^\s*[-*+]?\s*(.+?)[\s:]+(\d+(?:\.\d+)?)\s*$/.exec(raw)
    if (m) {
      items.push({ label: m[1].trim(), value: parseFloat(m[2]) })
    }
  }
  if (items.length === 0) return source
  items.sort((a, b) => b.value - a.value)
  const total = items.reduce((s, x) => s + x.value, 0) || 1
  const max = items[0].value || 1
  const out: string[] = ['## Pareto Ranking', '', '```text']
  let cum = 0
  for (const it of items) {
    const barLen = Math.max(1, Math.round((it.value / max) * 30))
    const bar = '█'.repeat(barLen)
    cum += it.value
    const pct = ((it.value / total) * 100).toFixed(1)
    const cumPct = ((cum / total) * 100).toFixed(1)
    const label = it.label.padEnd(20, ' ').slice(0, 20)
    out.push(`${label} ${bar} ${it.value} (${pct}%, cum ${cumPct}%)`)
  }
  out.push('```')
  return out.join('\n')
}

export const linesToParetoBar: Command = (view) =>
  applyToSelectionOrAll(view, linesToParetoBarText, 'transform.pareto-bar')

export const insertMindmapOutlineTemplate: Command = (view) => {
  const text = [
    '## Mindmap Outline',
    '',
    '- Central topic',
    '  - Branch A',
    '    - Sub-node A1',
    '    - Sub-node A2',
    '  - Branch B',
    '    - Sub-node B1',
    '    - Sub-node B2',
    '  - Branch C',
    '    - Sub-node C1',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.mindmap-outline' })
  return true
}

export function paragraphsToCustomerJourneyMomentsText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const phases = ['👀 Awareness', '🤔 Consideration', '🛒 Decision', '🎉 Use', '💬 Advocacy']
  const out: string[] = ['## Customer Journey Moments', '']
  paragraphs.forEach((p, i) => {
    const phase = phases[i % phases.length]
    out.push(`### ${phase}`)
    out.push('')
    out.push(`**User action**: ${p}`)
    out.push('**Emotion**:')
    out.push('**Touchpoint**:')
    out.push('**Opportunity**:')
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToCustomerJourneyMoments: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToCustomerJourneyMomentsText, 'transform.journey-moments')

export const insertLabSafetyChecklist: Command = (view) => {
  const text = [
    '## Lab Safety Checklist',
    '',
    '**Date**:',
    '**Inspector**:',
    '',
    '### Personal protection',
    '- [ ] Lab coat on',
    '- [ ] Safety glasses on',
    '- [ ] Gloves on',
    '- [ ] Hair tied back',
    '',
    '### Work area',
    '- [ ] Bench surface clear',
    '- [ ] Ventilation running',
    '- [ ] Emergency shower reachable',
    '- [ ] Fire extinguisher location known',
    '',
    '### Chemicals',
    '- [ ] SDS reviewed',
    '- [ ] Labels legible',
    '- [ ] Storage location correct',
    '- [ ] Waste disposal containers in place',
    '',
    '### Emergency',
    '- [ ] Emergency contacts known',
    '- [ ] Evacuation route confirmed',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.lab-safety' })
  return true
}

export function bulletsToGitGraphMermaidText(source: string): string {
                                                
  const lines = source.split('\n')
  const commits: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) commits.push(m[1].trim())
  }
  if (commits.length === 0) return source
  const out: string[] = ['```mermaid', 'gitGraph', '  commit id: "init"']
  commits.forEach((c, i) => {
    const safeId = c.slice(0, 30).replace(/"/g, "'")
    out.push(`  commit id: "${safeId}"`)
    if (i === Math.floor(commits.length / 3)) {
      out.push('  branch feature')
      out.push('  checkout feature')
    }
    if (i === Math.floor((commits.length * 2) / 3)) {
      out.push('  checkout main')
      out.push('  merge feature')
    }
  })
  out.push('```')
  return out.join('\n')
}

export const bulletsToGitGraphMermaid: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToGitGraphMermaidText, 'transform.git-graph')

export const insertTrainingPlanCalendar: Command = (view) => {
  const text = [
    '## Training Plan',
    '',
    '**Period**:',
    '**Goal**:',
    '',
    '| Week | Mon | Tue | Wed | Thu | Fri | Sat | Sun |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | Strength | Cardio | Rest | Strength | Cardio | Long | Rest |',
    '| 2 | Strength | Cardio | Rest | Strength | Cardio | Long | Rest |',
    '| 3 | Strength | Cardio | Rest | Strength | Cardio | Long | Rest |',
    '| 4 | Deload | Deload | Rest | Deload | Deload | Race/Test | Rest |',
    '',
    '**Intensity**: 4-week progressive → 1-week deload',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.training-calendar' })
  return true
}

export function paragraphsToUserPersonaText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## User Personas', '']
  paragraphs.forEach((p, i) => {
    out.push(`### Persona ${i + 1}`)
    out.push('')
    out.push(`![](https://api.dicebear.com/7.x/avataaars/svg?seed=persona${i + 1})`)
    out.push('')
    out.push(`**Profile**: ${p}`)
    out.push('')
    out.push('**Goals**:')
    out.push('**Pain points**:')
    out.push('**Channels**:')
    out.push('**Quote**: > "" ')
    out.push('')
    out.push('---')
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToUserPersona: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToUserPersonaText, 'transform.user-persona')

export function normalizeUnicodeWhitespaceText(source: string): string {
                                            
  let out = source
                 
  out = out.replace(/ /g, ' ')
                
  out = out.replace(/　/g, ' ')
          
  out = out.replace(/[ - ]/g, ' ')
              
  out = out.replace(/[​‌‍﻿]/g, '')
             
  out = out.replace(/­/g, '')
  return out
}

export const normalizeUnicodeWhitespace: Command = (view) =>
  applyToSelectionOrAll(view, normalizeUnicodeWhitespaceText, 'lint.unicode-whitespace')

export const insertProjectCharterTemplate: Command = (view) => {
  const text = [
    '# Project Charter',
    '',
    '**Project name**:',
    '**Sponsor**:',
    '**Project manager**:',
    '**Dates**:',
    '',
    '## Purpose & Objectives',
    '',
    '## Scope',
    '',
    '**In scope**:',
    '',
    '**Out of scope**:',
    '',
    '## Key Deliverables',
    '- ',
    '',
    '## Milestones',
    '| Milestone | Date | Criteria |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
    '## Resources & Budget',
    '',
    '## Assumptions & Constraints',
    '- Assumptions:',
    '- Constraints:',
    '',
    '## Risks',
    '| Risk | Impact | Response |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
    '## Stakeholders',
    '| Role | Name | Communication frequency |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '',
    '## Sign-off',
    '- Sponsor:',
    '- Project manager:',
    '- Date:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.project-charter' })
  return true
}

// ===== Batch #225 =====

export const insertIncidentSeverityMatrix: Command = (view) => {
  const text = [
    '## Incident Severity Matrix',
    '',
    '| Level | Impact | Reach | Response time | Escalation |',
    '| --- | --- | --- | --- | --- |',
    '| **SEV1** | Service fully unavailable | All users | Immediate (< 5 min) | CTO + on-call |',
    '| **SEV2** | Core feature degraded | Most users | < 30 min | On-call + Team lead |',
    '| **SEV3** | Minor feature impaired | Some users | < 4h | On-call |',
    '| **SEV4** | UX issue | Individual users | Business hours | Ticket |',
    '',
    '**Current incident level**:',
    '**Trigger criteria**:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.severity-matrix' })
  return true
}

export function paragraphsToExecutiveTalkingPointsText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Executive Talking Points', '']
  out.push('> Deliver every point in under five minutes')
  out.push('')
  paragraphs.forEach((p, i) => {
    out.push(`### ${i + 1}. ${p.length > 50 ? p.slice(0, 50) + '…' : p}`)
    out.push('')
    out.push(`**Core message**: ${p}`)
    out.push('')
    out.push('**Supporting data**:')
    out.push('')
    out.push('**Likely questions**:')
    out.push('')
  })
  out.push('### Close')
  out.push('')
  out.push('**Call to action**:')
  return out.join('\n')
}

export const paragraphsToExecutiveTalkingPoints: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToExecutiveTalkingPointsText, 'transform.talking-points')

export const insertABTestScorecard: Command = (view) => {
  const text = [
    '## A/B Test Scorecard',
    '',
    '**Experiment name**:',
    '**Dates**:',
    '**Traffic split**: 50% / 50%',
    '',
    '### Primary metric',
    '',
    '| Metric | Control | Treatment | Delta | p-value | Significant? |',
    '| --- | --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |  |',
    '',
    '### Guardrail metrics',
    '',
    '| Metric | Control | Treatment | Threshold | Status |',
    '| --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |',
    '',
    '### Decision',
    '',
    '- [ ] Full rollout',
    '- [ ] Partial rollout (observe at low traffic)',
    '- [ ] Rollback',
    '- [ ] Iterate further',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.ab-scorecard' })
  return true
}

export function linesToTierListText(source: string): string {
                                            
  const lines = source.split('\n')
  const buckets: Record<'S' | 'A' | 'B' | 'C' | 'D', string[]> = { S: [], A: [], B: [], C: [], D: [] }
  let any = false
  for (const raw of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(raw)
    if (!m) continue
    any = true
    const content = m[1].trim()
    let tier: 'S' | 'A' | 'B' | 'C' | 'D' = 'C'
    if (/⭐+|S-tier|legendary|perfect/i.test(content)) tier = 'S'
    else if (/great|👍|A-tier/i.test(content)) tier = 'A'
    else if (/good|B-tier/i.test(content)) tier = 'B'
    else if (/ok|average|C-tier/i.test(content)) tier = 'C'
    else if (/bad|👎|D-tier|deprecated/i.test(content)) tier = 'D'
    const clean = content
      .replace(/^(S|A|B|C|D)(?: tier| level)?\s*:?\s*/i, '')
      .replace(/[⭐👍👎]+\s*/g, '')
      .trim()
    buckets[tier].push(clean)
  }
  if (!any) return source
  const labels: Record<'S' | 'A' | 'B' | 'C' | 'D', string> = {
    S: '🏆 S Exceptional',
    A: '🥇 A Excellent',
    B: '🥈 B Good',
    C: '🥉 C Average',
    D: '⚫ D Retire',
  }
  const out: string[] = ['## Tier List', '']
  for (const k of ['S', 'A', 'B', 'C', 'D'] as const) {
    if (buckets[k].length === 0) continue
    out.push(`### ${labels[k]}`)
    for (const it of buckets[k]) out.push(`- ${it}`)
    out.push('')
  }
  return out.join('\n')
}

export const linesToTierList: Command = (view) =>
  applyToSelectionOrAll(view, linesToTierListText, 'transform.tier-list')

export const insert306090DayPlan: Command = (view) => {
  const text = [
    '## 30 / 60 / 90 Day Plan',
    '',
    '**Start date**:',
    '**Role / Project**:',
    '',
    '### 🌱 Days 1-30: Learn',
    '',
    '**Goal**: Understand current state, key relationships, and critical processes',
    '',
    '- [ ] 1:1 with all stakeholders',
    '- [ ] Read key documents',
    '- [ ] Shadow X processes',
    '- [ ] Start first set of notes',
    '',
    '### 🌿 Days 31-60: Contribute',
    '',
    '**Goal**: Deliver one visibly valuable quick win',
    '',
    '- [ ] Identify a quick win',
    '- [ ] Drive X to completion',
    '- [ ] Propose Y improvement',
    '',
    '### 🌳 Days 61-90: Lead',
    '',
    '**Goal**: Own a medium-scale improvement',
    '',
    '- [ ] Submit Q1 roadmap',
    '- [ ] Lead X project',
    '- [ ] Retrospect and adjust',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.30-60-90' })
  return true
}

export function paragraphsToPressReleaseText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const today = new Date().toISOString().slice(0, 10)
  const out: string[] = []
  out.push('# For Immediate Release')
  out.push('')
  out.push(`**${today}**`)
  out.push('')
  if (paragraphs[0]) {
    out.push(`## ${paragraphs[0]}`)
    out.push('')
  }
  if (paragraphs[1]) {
    out.push(`**${paragraphs[1]}**`)
    out.push('')
  }
  for (let i = 2; i < paragraphs.length; i++) {
    out.push(paragraphs[i])
    out.push('')
  }
  out.push('## About Us')
  out.push('')
  out.push('[Company description]')
  out.push('')
  out.push('## Media Contact')
  out.push('')
  out.push('- Name:')
  out.push('- Email:')
  out.push('- Phone:')
  out.push('')
  out.push('###')
  return out.join('\n')
}

export const paragraphsToPressRelease: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToPressReleaseText, 'transform.press-release')

export const insertDependencyMapMermaid: Command = (view) => {
  const text = [
    '```mermaid',
    'graph LR',
    '    subgraph Upstream',
    '      U1[Data source A]',
    '      U2[Data source B]',
    '    end',
    '    subgraph This service',
    '      S1[Module 1]',
    '      S2[Module 2]',
    '    end',
    '    subgraph Downstream',
    '      D1[Consumer X]',
    '      D2[Consumer Y]',
    '    end',
    '    U1 --> S1',
    '    U2 --> S2',
    '    S1 --> D1',
    '    S2 --> D2',
    '```',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.dep-map' })
  return true
}

export function bulletsToChecklistSignedOffText(source: string): string {
  const lines = source.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) items.push(m[1].trim())
  }
  if (items.length === 0) return source
  const out: string[] = ['## Sign-off Checklist', '', '| # | Item | Complete | Owner | Date | Signature |']
  out.push('| --- | --- | --- | --- | --- | --- |')
  items.forEach((item, i) => {
    out.push(`| ${i + 1} | ${item} | [ ] |  |  |  |`)
  })
  return out.join('\n')
}

export const bulletsToChecklistSignedOff: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToChecklistSignedOffText, 'transform.signed-checklist')

export const insertSecurityAuditLogTemplate: Command = (view) => {
  const text = [
    '## Security Audit Log',
    '',
    '**Audit period**:',
    '**Auditor**:',
    '',
    '| Time | Event type | Source IP | User | Action | Result | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '|  | Login |  |  | Success |  |  |',
    '|  | Permission change |  |  |  |  |  |',
    '|  | Data export |  |  |  |  |  |',
    '',
    '### Anomaly summary',
    '',
    '- Suspicious login attempts:',
    '- Unauthorized access:',
    '- Data exfiltration risk:',
    '',
    '### Follow-up actions',
    '',
    '- [ ] Notify affected users',
    '- [ ] Reset affected credentials',
    '- [ ] Update detection rules',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.security-audit' })
  return true
}

export function paragraphsToKPITreeNarrativeText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## KPI Metric Tree', '']
  if (paragraphs[0]) {
    out.push('### North Star Metric')
    out.push('')
    out.push(`> ${paragraphs[0]}`)
    out.push('')
  }
  out.push('### Supporting Metric Branches')
  out.push('')
  for (let i = 1; i < paragraphs.length; i++) {
    out.push(`#### Branch ${i}`)
    out.push('')
    out.push(`**Metric description**: ${paragraphs[i]}`)
    out.push('')
    out.push('**Drivers**:')
    out.push('- ')
    out.push('')
    out.push('**Current / Target**:')
    out.push('')
  }
  return out.join('\n')
}

export const paragraphsToKPITreeNarrative: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToKPITreeNarrativeText, 'transform.kpi-tree-narrative')

export function normalizeOrderedListMarkersText(source: string): string {
                                  
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(line.replace(/^(\s*)(\d+)\)\s+/, '$1$2. '))
  }
  return out.join('\n')
}

export const normalizeOrderedListMarkers: Command = (view) =>
  applyToSelectionOrAll(view, normalizeOrderedListMarkersText, 'lint.ordered-markers')

export const insertDataMigrationRunbook: Command = (view) => {
  const text = [
    '# Data Migration Runbook',
    '',
    '**Migration name**:',
    '**Version**:',
    '**Estimated downtime**:',
    '**Rollback budget**:',
    '',
    '## Pre-checks',
    '',
    '- [ ] Backup confirmed (location + checksum)',
    '- [ ] Affected parties notified',
    '- [ ] Validation SQL dry-run passed',
    '- [ ] Monitoring alerts silenced',
    '',
    '## Execution steps',
    '',
    '1. Enter maintenance mode',
    '2. Lock tables / shift traffic',
    '3. Run migration script',
    '4. Validation SQL green',
    '5. Restore main traffic',
    '6. Exit maintenance mode',
    '',
    '## Validation',
    '',
    '- [ ] Old table vs new table row count matches',
    '- [ ] Critical query P99 within threshold',
    '- [ ] Business-side smoke test passed',
    '',
    '## Rollback Plan',
    '',
    'Trigger conditions:',
    '- Row count difference > 0.1%',
    '- P99 increase > 30%',
    '- Business error rate > 1%',
    '',
    'Rollback steps:',
    '1. Switch traffic back to old table',
    '2. Restore backup (if necessary)',
    '3. Initiate post-mortem',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.migration-runbook' })
  return true
}

// ===== Batch #226 =====

export const insertOrgStructureMermaidV2: Command = (view) => {
  const text = [
    '```mermaid',
    'graph TD',
    '    CEO[CEO]',
    '    subgraph Product',
    '      CPO[CPO]',
    '      PM1[PM Team]',
    '      DES[Design Team]',
    '    end',
    '    subgraph Engineering',
    '      CTO[CTO]',
    '      ENG1[Platform Team]',
    '      ENG2[Business Team]',
    '      SRE[SRE]',
    '    end',
    '    subgraph Growth',
    '      CMO[CMO]',
    '      MKT[Marketing]',
    '      OPS[Operations]',
    '    end',
    '    CEO --> CPO',
    '    CEO --> CTO',
    '    CEO --> CMO',
    '    CPO --> PM1',
    '    CPO --> DES',
    '    CTO --> ENG1',
    '    CTO --> ENG2',
    '    CTO --> SRE',
    '    CMO --> MKT',
    '    CMO --> OPS',
    '```',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.org-mermaid-v2' })
  return true
}

export function paragraphsToFAQRichAnswersText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Detailed FAQ', '']
  for (const p of paragraphs) {
    const m = /^(.+?)\?\s*(.+)$/s.exec(p)
    if (m) {
      out.push(`### ❓ ${m[1].trim()}?`)
      out.push('')
      out.push('> [!tip] Short answer')
      out.push(`> ${m[2].trim()}`)
      out.push('')
      out.push('**Details**:')
      out.push('')
      out.push('**Related links**:')
      out.push('')
    } else {
      out.push(`### ❓ ${p}`)
      out.push('')
      out.push('**Answer**:')
      out.push('')
    }
  }
  return out.join('\n')
}

export const paragraphsToFAQRichAnswers: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToFAQRichAnswersText, 'transform.faq-rich')

export const insertCapacityVsDemandChart: Command = (view) => {
  const text = [
    '## Capacity vs Demand',
    '',
    '```mermaid',
    'gantt',
    '    title Weekly Capacity vs Demand',
    '    dateFormat YYYY-MM-DD',
    '    section Capacity',
    '    Available hours :a1, 2026-01-01, 7d',
    '    section Demand',
    '    Story 1    :s1, 2026-01-01, 3d',
    '    Story 2    :s2, after s1, 2d',
    '    Story 3    :s3, 2026-01-04, 3d',
    '```',
    '',
    '**Saturation**:',
    '**Risk**:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.capacity-demand' })
  return true
}

export function linesToBalancedTreeAsciiText(source: string): string {
  const items = source
    .split('\n')
    .map((l) => l.replace(/^\s*[-*+]\s+/, '').trim())
    .filter(Boolean)
  if (items.length === 0) return source
                 
  const out: string[] = ['```text']
  let level = 0
  let consumed = 0
  while (consumed < items.length) {
    const count = Math.pow(2, level)
    const slice = items.slice(consumed, consumed + count)
    consumed += count
    const padding = ' '.repeat(Math.max(0, (Math.pow(2, Math.ceil(Math.log2(items.length + 1)) - level - 1)) * 2))
    const gap = ' '.repeat(Math.max(2, padding.length * 2))
    out.push(padding + slice.map((s) => s.slice(0, 6)).join(gap))
    level++
    if (level > 6) break
  }
  out.push('```')
  return out.join('\n')
}

export const linesToBalancedTreeAscii: Command = (view) =>
  applyToSelectionOrAll(view, linesToBalancedTreeAsciiText, 'transform.balanced-tree')

export const insertRoleResponsibilityMatrix: Command = (view) => {
  const text = [
    '## Role / Responsibility Matrix (RACI+)',
    '',
    '> **R**=Responsible **A**=Accountable **C**=Consulted **I**=Informed **S**=Support',
    '',
    '| Task / Decision | PM | Design | Engineering | Operations | Legal |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Requirements definition | A/R | C | C | I | I |',
    '| UI design | C | A/R | I | I | - |',
    '| Implementation | I | I | A/R | I | - |',
    '| Launch verification | C | C | R | A | C |',
    '| Public communication | A | I | I | R | C |',
    '| Contract / terms | I | - | I | C | A/R |',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.raci-plus' })
  return true
}

export function paragraphsToMeetingAgendaFromTopicsText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Meeting Agenda', '', '**Date**:', '**Attendees**:', '', '| # | Duration | Topic | Facilitator | Expected Outcome |', '| --- | --- | --- | --- | --- |']
  let totalMin = 0
  paragraphs.forEach((p, i) => {
    const dur = i === 0 ? 5 : i === paragraphs.length - 1 ? 5 : 10
    totalMin += dur
    out.push(`| ${i + 1} | ${dur} min | ${p} |  |  |`)
  })
  out.push('')
  out.push(`**Total duration**: ${totalMin} min`)
  return out.join('\n')
}

export const paragraphsToMeetingAgendaFromTopics: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToMeetingAgendaFromTopicsText, 'transform.agenda-from-topics')

export const insertDashboardLayoutTextGrid: Command = (view) => {
  const text = [
    '## Dashboard Layout',
    '',
    '```text',
    '┌───────────────────────────────────────────────────────┐',
    '│ Header                                                │',
    '├───────────────┬───────────────┬───────────────────────┤',
    '│ KPI Card 1    │ KPI Card 2    │ KPI Card 3            │',
    '├───────────────┴───────────────┼───────────────────────┤',
    '│                               │                       │',
    '│      Main chart (trend)       │   Table (details)     │',
    '│                               │                       │',
    '├───────────────────────────────┴───────────────────────┤',
    '│ Filter bar / date range                               │',
    '└───────────────────────────────────────────────────────┘',
    '```',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.dashboard-layout' })
  return true
}

export function bulletsToOutlineNumberedText(source: string): string {
                                
  const lines = source.split('\n')
  type Item = { depth: number; content: string }
  const items: Item[] = []
  for (const raw of lines) {
    const m = /^(\s*)[-*+]\s+(.+)$/.exec(raw)
    if (!m) continue
    const depth = Math.floor(m[1].length / 2)
    items.push({ depth, content: m[2].trim() })
  }
  if (items.length === 0) return source
  const counters: number[] = []
  const out: string[] = []
  for (const it of items) {
    while (counters.length <= it.depth) counters.push(0)
    while (counters.length > it.depth + 1) counters.pop()
    counters[it.depth]++
    const num = counters.slice(0, it.depth + 1).join('.')
    const indent = '  '.repeat(it.depth)
    out.push(`${indent}${num}. ${it.content}`)
  }
  return out.join('\n')
}

export const bulletsToOutlineNumbered: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToOutlineNumberedText, 'transform.outline-numbered')

export const insertCustomerFeedbackHeatmap: Command = (view) => {
  const text = [
    '## Customer Feedback Heatmap',
    '',
    '| Feature / Module | Complaints | Suggestions | Praise | Sentiment |',
    '| --- | --- | --- | --- | --- |',
    '| Home | 🟥 | 🟧 | 🟩 | Neutral |',
    '| Search | 🟥🟥 | 🟨 | 🟩 | Negative |',
    '| Profile | 🟧 | 🟧 | 🟩🟩 | Positive |',
    '| Notifications | 🟥🟥 | 🟧 | - | Strongly negative |',
    '',
    '**Hot topics**:',
    '- ',
    '',
    '**Top improvement opportunities**:',
    '1. ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.feedback-heatmap' })
  return true
}

export function paragraphsToPressHeadlineCandidatesText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Headline Candidates', '']
  paragraphs.forEach((p, i) => {
    const short = p.slice(0, 60).replace(/\p{Sentence_Terminal}$/u, '')
    out.push(`### Candidate ${i + 1}`)
    out.push('')
    out.push(`- **Direct**: ${short}`)
    out.push(`- **Curiosity**: You will not believe ${short.slice(0, 30)} …`)
    out.push(`- **Data**: ${short} — three key numbers`)
    out.push(`- **Comparison**: From ${short.slice(0, 20)} to a new industry benchmark`)
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToPressHeadlineCandidates: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToPressHeadlineCandidatesText, 'transform.press-headline-candidates')

export function normalizeEmptyBulletItemsText(source: string): string {
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
                                                            
    if (/^\s*[-*+]\s*$/.test(line)) continue
    if (/^\s*[-*+]\s+\[ \]\s*$/.test(line)) continue
    if (/^\s*\d+\.\s*$/.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

export const normalizeEmptyBulletItems: Command = (view) =>
  applyToSelectionOrAll(view, normalizeEmptyBulletItemsText, 'lint.empty-bullets')

export const insertSprintDashboardTemplate: Command = (view) => {
  const text = [
    '## Sprint Board',
    '',
    '**Sprint #**:',
    '**Dates**:',
    '**Goal**:',
    '',
    '### Burndown',
    '',
    '| Date | Remaining story points | Done | Added |',
    '| --- | --- | --- | --- |',
    '| Day 1 |  |  |  |',
    '| Day 5 |  |  |  |',
    '| Day 10 |  |  |  |',
    '',
    '### In Progress',
    '',
    '- [ ] ',
    '',
    '### Blocked',
    '',
    '- ',
    '',
    '### Done',
    '',
    '- [x] ',
    '',
    '### Risks',
    '',
    '- ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.sprint-dashboard' })
  return true
}

// ===== Batch #227 =====

export const insertWeeklyRetrospectiveBoard: Command = (view) => {
  const text = [
    '## Weekly Retrospective Board',
    '',
    '**Week #**:',
    '**Facilitator**:',
    '**Participants**:',
    '',
    '### 😀 Highlights',
    '- ',
    '',
    '### 😟 Low points',
    '- ',
    '',
    '### 💡 Insights',
    '- ',
    '',
    '### 🎯 Next week focus',
    '- [ ] ',
    '',
    '### 📊 Data points',
    '| Metric | Last week | This week | Trend |',
    '| --- | --- | --- | --- |',
    '|  |  |  |  |',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.weekly-retro-board' })
  return true
}

export function paragraphsToCompetitiveMatrixText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Competitive Matrix', '']
  out.push('| Dimension | Ours | ' + paragraphs.map((_, i) => `Competitor ${String.fromCharCode(65 + i)}`).join(' | ') + ' |')
  out.push('| --- | --- | ' + paragraphs.map(() => '---').join(' | ') + ' |')
  out.push('| Positioning | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('| Pricing | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('| Target users | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('| Core features | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('| Differentiation | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('| Weaknesses | ✏️ | ' + paragraphs.map(() => ' ').join(' | ') + ' |')
  out.push('')
  out.push('### Competitor Notes')
  out.push('')
  paragraphs.forEach((p, i) => {
    out.push(`**Competitor ${String.fromCharCode(65 + i)}**: ${p}`)
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToCompetitiveMatrix: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToCompetitiveMatrixText, 'transform.competitive-matrix')

export const insertCustomerJourneyMomentsDashboard: Command = (view) => {
  const text = [
    '## Customer Journey Moments Dashboard',
    '',
    '| Stage | Touchpoint | User emotion | Pain point | Opportunity |',
    '| --- | --- | --- | --- | --- |',
    '| 👀 Awareness |  | 😐 |  |  |',
    '| 🤔 Consideration |  | 🙂 |  |  |',
    '| 🛒 Decision |  | 😟 |  |  |',
    '| 🎉 Usage |  | 😀 |  |  |',
    '| 💬 Referral |  | 🤩 |  |  |',
    '',
    '### MoT (Moments of Truth)',
    '',
    '1. First launch — 30 seconds to decide retention',
    '2. First value realization — Aha! moment',
    '3. First failure — trust test',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.journey-dashboard' })
  return true
}

export function linesToEisenhowerByHoursText(source: string): string {
                                                   
  const lines = source.split('\n')
  type Item = { content: string; hours: number; urgent: boolean }
  const items: Item[] = []
  for (const raw of lines) {
    const m = /^\s*[-*+]\s+(.+?)\s*\((\d+(?:\.\d+)?)\s*h\)\s*$/i.exec(raw)
    if (!m) continue
    const content = m[1].trim()
    const hours = parseFloat(m[2])
    const urgent = hours <= 2
    items.push({ content, hours, urgent })
  }
  if (items.length === 0) return source
  const buckets: Record<string, string[]> = { do: [], plan: [], delegate: [], drop: [] }
  for (const it of items) {
    const important = it.hours >= 3
    const key = it.urgent && important ? 'do'
      : !it.urgent && important ? 'plan'
        : it.urgent && !important ? 'delegate'
          : 'drop'
    buckets[key].push(`- [${it.hours}h] ${it.content}`)
  }
  const out: string[] = ['## Eisenhower Matrix (by hours)', '']
  out.push('### 🔥 Do now (Urgent + Important)')
  out.push(...(buckets.do.length ? buckets.do : ['_none_']))
  out.push('')
  out.push('### 📅 Schedule (Not urgent + Important)')
  out.push(...(buckets.plan.length ? buckets.plan : ['_none_']))
  out.push('')
  out.push('### 🤝 Delegate (Urgent + Not important)')
  out.push(...(buckets.delegate.length ? buckets.delegate : ['_none_']))
  out.push('')
  out.push('### 🗑️ Drop (Not urgent + Not important)')
  out.push(...(buckets.drop.length ? buckets.drop : ['_none_']))
  return out.join('\n')
}

export const linesToEisenhowerByHours: Command = (view) =>
  applyToSelectionOrAll(view, linesToEisenhowerByHoursText, 'transform.eisenhower-hours')

export const insertScrumPokerSessionTemplate: Command = (view) => {
  const text = [
    '## Scrum Planning Poker',
    '',
    '**Sprint**:',
    '**Facilitator**:',
    '**Estimation unit**: Fibonacci (1 / 2 / 3 / 5 / 8 / 13 / 21)',
    '',
    '| Story | Description | Estimate 1 | Estimate 2 | Estimate 3 | Consensus | Assumptions |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |  |  |',
    '',
    '### Discussion Notes',
    '',
    '- ',
    '',
    '### Stories with High Variance',
    '',
    '- ',
    '',
    '### Total Estimate',
    '',
    '- Story points total:',
    '- Team velocity:',
    '- Capacity ratio:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.scrum-poker' })
  return true
}

export function paragraphsToUserStoryAcceptanceText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## User Stories & Acceptance Criteria', '']
  paragraphs.forEach((p, i) => {
    out.push(`### Story ${i + 1}`)
    out.push('')
    out.push(`**As a** [role]`)
    out.push(`**I want to** ${p}`)
    out.push(`**So that** [value]`)
    out.push('')
    out.push('**Acceptance criteria**:')
    out.push('- [ ] **Given** [precondition]')
    out.push('- [ ] **When** [action]')
    out.push('- [ ] **Then** [result]')
    out.push('')
    out.push('**Estimate**:')
    out.push('**Priority**:')
    out.push('')
  })
  return out.join('\n')
}

export const paragraphsToUserStoryAcceptance: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToUserStoryAcceptanceText, 'transform.story-acceptance')

export const insertDeploymentReleaseNotes: Command = (view) => {
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `## Release Notes ${today}`,
    '',
    '**Version**: v',
    '**Release date**:',
    '**Released by**:',
    '',
    '### 🚀 New Features',
    '- ',
    '',
    '### 🐛 Bug Fixes',
    '- ',
    '',
    '### ⚡ Performance Improvements',
    '- ',
    '',
    '### 💔 Breaking Changes',
    '- _none_',
    '',
    '### ⬆️ Upgrade Guide',
    '',
    '```bash',
    '# upgrade command',
    '```',
    '',
    '### 🔄 Rollback Steps',
    '',
    '1. ',
    '',
    '### 🙏 Contributors',
    '',
    '- ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.release-notes' })
  return true
}

export function bulletsToRoadmapQuartersText(source: string): string {
  const lines = source.split('\n')
  const items: string[] = []
  for (const line of lines) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (m) items.push(m[1].trim())
  }
  if (items.length === 0) return source
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4']
  const out: string[] = ['## Roadmap', '']
  out.push('| Quarter | Theme | Key deliverables | Status |')
  out.push('| --- | --- | --- | --- |')
  items.forEach((item, i) => {
    const q = quarters[i % 4]
    out.push(`| ${q} |  | ${item} | ⏳ |`)
  })
  return out.join('\n')
}

export const bulletsToRoadmapQuarters: Command = (view) =>
  applyToSelectionOrAll(view, bulletsToRoadmapQuartersText, 'transform.roadmap-quarters')

export const insertOKRCascadeTemplate: Command = (view) => {
  const text = [
    '## OKR Cascade',
    '',
    '### 🏢 Company Level',
    '',
    '**Objective**:',
    '',
    '- [ ] KR1:',
    '- [ ] KR2:',
    '- [ ] KR3:',
    '',
    '### 🏛️ Department Level',
    '',
    '**Department**:',
    '**Objective**: (supports Company KR1)',
    '',
    '- [ ] KR1:',
    '- [ ] KR2:',
    '',
    '### 👥 Team Level',
    '',
    '**Team**:',
    '**Objective**: (supports Department KR1)',
    '',
    '- [ ] KR1:',
    '- [ ] KR2:',
    '',
    '### 🧑 Individual Level',
    '',
    '**Objective**: (supports Team KR1)',
    '',
    '- [ ] KR1:',
    '- [ ] KR2:',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.okr-cascade' })
  return true
}

export function paragraphsToRiskRegisterEntriesText(source: string): string {
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return source
  const out: string[] = ['## Risk Register', '']
  out.push('| # | Risk | Probability | Impact | Score | Mitigation strategy | Owner |')
  out.push('| --- | --- | --- | --- | --- | --- | --- |')
  paragraphs.forEach((p, i) => {
    out.push(`| R${String(i + 1).padStart(3, '0')} | ${p} | Medium | Medium | 4 | Mitigate |  |`)
  })
  out.push('')
  out.push('### Score Legend')
  out.push('')
  out.push('- 1-2: Low priority, monitor')
  out.push('- 3-5: Medium priority, develop response')
  out.push('- 6-9: High priority, act immediately')
  return out.join('\n')
}

export const paragraphsToRiskRegisterEntries: Command = (view) =>
  applyToSelectionOrAll(view, paragraphsToRiskRegisterEntriesText, 'transform.risk-register')

export function normalizeTrailingPunctuationText(source: string): string {
                                         
  const lines = source.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    let next = line
                  
    next = next.replace(/(\p{Sentence_Terminal})\1{1,}/gu, '$1')
                
    next = next.replace(/(\p{Sentence_Terminal})\s+$/gu, '$1')
             
    next = next.replace(/[ \t]+$/g, '')
    out.push(next)
  }
  return out.join('\n')
}

export const normalizeTrailingPunctuation: Command = (view) =>
  applyToSelectionOrAll(view, normalizeTrailingPunctuationText, 'lint.trailing-punct')

export const insertMonthlyBusinessReviewTemplate: Command = (view) => {
  const text = [
    '# Monthly Business Review',
    '',
    '**Month**:',
    '**Business**:',
    '',
    '## 📊 Key Metrics',
    '',
    '| Metric | Target | Actual | Achievement | YoY | MoM |',
    '| --- | --- | --- | --- | --- | --- |',
    '|  |  |  |  |  |  |',
    '',
    '## ✅ What We Accomplished',
    '',
    '- ',
    '',
    '## ⏰ What We Didn\'t Finish',
    '',
    '- ',
    '',
    '## 🔍 Key Findings',
    '',
    '1. ',
    '',
    '## 💡 Next Month Focus',
    '',
    '### Must do',
    '- [ ] ',
    '',
    '### Should do',
    '- [ ] ',
    '',
    '### Nice to do',
    '- [ ] ',
    '',
    '## 🚨 Risks & Dependencies',
    '',
    '- ',
    '',
    '## 🤝 Support Needed',
    '',
    '- ',
    '',
  ].join('\n')
  view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.insert.mbr' })
  return true
}

/* ---------- clearFormatting ---------- */

export const clearFormatting: Command = (view) => {
  const sel = view.state.selection.main
  if (sel.empty) return false

  const original = view.state.doc.sliceString(sel.from, sel.to)
  const stripped = original
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')

  if (stripped === original) return false
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: stripped },
    selection: { anchor: sel.from, head: sel.from + stripped.length },
  })
  view.focus()
  return true
}
