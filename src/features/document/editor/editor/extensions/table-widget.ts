   
                                                                     
  
        
                                                                       
                                                                                          
  
        
                                                       
                                                                
                                                                        
                                        
                                                                        
                                                                             
                                                                           
                                                                                           
                                                                      
                                                     
                                                                     
                                                                                    
                        
  
                                  
                                                                        
                                                                        
                                                                               
                                                                                   
                                        
   

import { redo, undo } from '@codemirror/commands'
import { Annotation, type EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import i18next from 'i18next'

import { Menu } from '../../menu'
import { activateTableCellWikilink, renderCellHtml } from './table-cell-renderer'

export { renderCellHtml } from './table-cell-renderer'

                                                                 
                                      
   
                            
                              
                                                             
   
function readCellRawText(wrapper: HTMLElement): string {
  const raw = wrapper.dataset.editMode === '1'
    ? (wrapper.textContent ?? '')
    : (wrapper.dataset.rawText ?? '')
  return raw.replace(/\r?\n/g, ' ')
}

   
                                                        
   
type SyntaxNode = {
  readonly from: number
  readonly to: number
  readonly name: string
  readonly firstChild: SyntaxNode | null
  readonly nextSibling: SyntaxNode | null
}

   
                                                    
                                                                                
   
export const tableSyncAnnotation = Annotation.define<true>()

export type TableAlign = 'left' | 'center' | 'right' | null

type CellRef = { text: string }

export type TableModel = {
  tableFrom: number
  tableTo: number
  headers: CellRef[]
  aligns: TableAlign[]
  rows: CellRef[][]
}

   
                                      
                                 
  
                                                      
                                                             
                                                  
                                      
  
                                                  
                                                     
   
   
                                             
   
function scanInlineCode(body: string, start: number): number {
  const len = body.length
  let i = start
  while (i < len && body[i] === '`') i++
  const runLen = i - start
  while (i < len) {
    if (body[i] === '`') {
      const runStart = i
      while (i < len && body[i] === '`') i++
      if (i - runStart === runLen) return i
    } else {
      i++
    }
  }
  return start
}

   
                                                                    
                                                          
                       
   
function scanMath(body: string, start: number): number {
  const len = body.length
  if (body[start] !== '$') return start
  const isBlock = body[start + 1] === '$'
  if (isBlock) {
    let i = start + 2
    while (i < len) {
      if (body[i] === '\\' && i + 1 < len) {
        i += 2
        continue
      }
      if (body[i] === '$' && body[i + 1] === '$') return i + 2
      if (body[i] === '\n') return start
      i++
    }
    return start
  }
  const after = body[start + 1]
  if (!after || /\s/.test(after)) return start
  let i = start + 1
  while (i < len) {
    const ch = body[i]
    if (ch === '\n') return start
    if (ch === '\\' && i + 1 < len) {
      i += 2
      continue
    }
    if (ch === '$') {
      if (body[i + 1] === '$') {
        i += 2
        continue
      }
      const before = body[i - 1]
      if (before && !/\s/.test(before)) return i + 1
    }
    i++
  }
  return start
}

   
                                
                  
                                                                  
                                                             
  
                                                        
                          
   
export function splitRowCells(rowText: string): string[] {
  let body = rowText.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '')
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)

  const cells: string[] = []
  let buf = ''
  const len = body.length
  let i = 0
  while (i < len) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '|'
      i += 2
      continue
    }
    if (ch === '`') {
      const end = scanInlineCode(body, i)
      if (end > i) {
        buf += body.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === '$') {
      const end = scanMath(body, i)
      if (end > i) {
        buf += body.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  cells.push(buf.trim())
  return cells
}

export function parseTableFromNode(
  node: SyntaxNode,
  state: EditorState,
): TableModel | null {
  const tableFrom = node.from
  const tableTo = node.to
  const headers: CellRef[] = []
  let aligns: TableAlign[] = []
  const rows: CellRef[][] = []
  let child = node.firstChild
  while (child) {
    if (child.name === 'TableHeader') {
      const headerText = state.doc.sliceString(child.from, child.to)
      for (const t of splitRowCells(headerText)) headers.push({ text: t })
    } else if (child.name === 'TableDelimiter') {
                                                
      const text = state.doc.sliceString(child.from, child.to).trim()
      const stripped = text.replace(/^\||\|$/g, '')
      aligns = stripped.split('|').map((col) => {
        const t = col.trim()
        const left = t.startsWith(':')
        const right = t.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return null
      })
    } else if (child.name === 'TableRow') {
      const rowText = state.doc.sliceString(child.from, child.to)
      const row: CellRef[] = []
      for (const t of splitRowCells(rowText)) row.push({ text: t })
      rows.push(row)
    }
    child = child.nextSibling
  }
  if (headers.length === 0 && rows.length === 0) return null
  return { tableFrom, tableTo, headers, aligns, rows }
}

   
                                                                    
                                                                
                                               
   
function escapeCellText(t: string): string {
  let out = ''
  const len = t.length
  let i = 0
  while (i < len) {
    const ch = t[i]
    if (ch === '`') {
      const end = scanInlineCode(t, i)
      if (end > i) {
        out += t.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === '$') {
      const end = scanMath(t, i)
      if (end > i) {
        out += t.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === '|') {
      out += '\\|'
      i++
      continue
    }
    out += ch
    i++
  }
  return out.replace(/\r?\n/g, ' ')
}

function alignToDelim(a: TableAlign): string {
  if (a === 'center') return ':---:'
  if (a === 'right') return '---:'
  if (a === 'left') return ':---'
  return '---'
}

                                                  
export function buildTableMarkdown(model: TableModel): string {
  const colCount = Math.max(
    model.headers.length,
    ...model.rows.map((r) => r.length),
    1,
  )
  const aligns: TableAlign[] = []
  for (let i = 0; i < colCount; i++) aligns.push(model.aligns[i] ?? null)
  const lines: string[] = []
  const headerCells: string[] = []
  for (let i = 0; i < colCount; i++) {
    headerCells.push(escapeCellText(model.headers[i]?.text ?? ''))
  }
  lines.push('| ' + headerCells.join(' | ') + ' |')
  lines.push('|' + aligns.map(alignToDelim).join('|') + '|')
  for (const row of model.rows) {
    const cells: string[] = []
    for (let i = 0; i < colCount; i++) cells.push(escapeCellText(row[i]?.text ?? ''))
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  return lines.join('\n')
}

type RowOp =
  | { type: 'insertAbove'; row: number }
  | { type: 'insertBelow'; row: number }
  | { type: 'moveUp'; row: number }
  | { type: 'moveDown'; row: number }
  | { type: 'duplicate'; row: number }
  | { type: 'delete'; row: number }
  | { type: 'appendRow' }
  | { type: 'appendCol' }

function applyRowOp(model: TableModel, op: RowOp): TableModel {
  const rows = model.rows.map((r) => r.map((c) => ({ ...c })))
  const colCount = Math.max(
    model.headers.length,
    ...model.rows.map((r) => r.length),
    1,
  )
  const emptyRow = (): CellRef[] =>
    Array.from({ length: colCount }, () => ({ text: '' }))
  switch (op.type) {
    case 'insertAbove':
      rows.splice(op.row, 0, emptyRow())
      break
    case 'insertBelow':
      rows.splice(op.row + 1, 0, emptyRow())
      break
    case 'moveUp':
      if (op.row > 0) {
        [rows[op.row - 1], rows[op.row]] = [rows[op.row], rows[op.row - 1]]
      }
      break
    case 'moveDown':
      if (op.row < rows.length - 1) {
        [rows[op.row], rows[op.row + 1]] = [rows[op.row + 1], rows[op.row]]
      }
      break
    case 'duplicate':
      rows.splice(op.row + 1, 0, rows[op.row].map((c) => ({ ...c })))
      break
    case 'delete':
      rows.splice(op.row, 1)
      break
    case 'appendRow':
      rows.push(emptyRow())
      break
    case 'appendCol': {
                                                                   
      const newHeaders = [...model.headers, { text: '' }]
      const newAligns: TableAlign[] = [...model.aligns, null]
      for (const r of rows) r.push({ text: '' })
      return { ...model, headers: newHeaders, aligns: newAligns, rows }
    }
  }
  return { ...model, rows }
}

type ColOp =
  | { type: 'sortAsc'; col: number }
  | { type: 'sortDesc'; col: number }
  | { type: 'insertLeft'; col: number }
  | { type: 'insertRight'; col: number }
  | { type: 'appendCol' }
  | { type: 'moveLeft'; col: number }
  | { type: 'moveRight'; col: number }
  | { type: 'alignLeft'; col: number }
  | { type: 'alignCenter'; col: number }
  | { type: 'alignRight'; col: number }
  | { type: 'duplicateCol'; col: number }
  | { type: 'deleteCol'; col: number }

   
                                                                     
                                                                             
                                                                      
                     
   
export function applyColOp(model: TableModel, op: ColOp): TableModel {
  const headers = model.headers.map((c) => ({ ...c }))
  const rows = model.rows.map((r) => r.map((c) => ({ ...c })))
  const aligns: TableAlign[] = [...model.aligns]
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1)

                                                                           
  while (headers.length < colCount) headers.push({ text: '' })
  while (aligns.length < colCount) aligns.push(null)
  for (const r of rows) while (r.length < colCount) r.push({ text: '' })

  switch (op.type) {
    case 'sortAsc':
    case 'sortDesc': {
      const dir = op.type === 'sortAsc' ? 1 : -1
      rows.sort((a, b) => {
        const av = (a[op.col]?.text ?? '').toLowerCase()
        const bv = (b[op.col]?.text ?? '').toLowerCase()
                                            
        const an = Number(av)
        const bn = Number(bv)
        if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') {
          return (an - bn) * dir
        }
        if (av < bv) return -1 * dir
        if (av > bv) return 1 * dir
        return 0
      })
      break
    }
    case 'insertLeft': {
      headers.splice(op.col, 0, { text: '' })
      aligns.splice(op.col, 0, null)
      for (const r of rows) r.splice(op.col, 0, { text: '' })
      break
    }
    case 'insertRight': {
      headers.splice(op.col + 1, 0, { text: '' })
      aligns.splice(op.col + 1, 0, null)
      for (const r of rows) r.splice(op.col + 1, 0, { text: '' })
      break
    }
    case 'appendCol': {
      headers.push({ text: '' })
      aligns.push(null)
      for (const r of rows) r.push({ text: '' })
      break
    }
    case 'moveLeft': {
      if (op.col > 0) {
        [headers[op.col - 1], headers[op.col]] = [headers[op.col], headers[op.col - 1]]
        ;[aligns[op.col - 1], aligns[op.col]] = [aligns[op.col], aligns[op.col - 1]]
        for (const r of rows) {
          [r[op.col - 1], r[op.col]] = [r[op.col], r[op.col - 1]]
        }
      }
      break
    }
    case 'moveRight': {
      if (op.col < colCount - 1) {
        [headers[op.col], headers[op.col + 1]] = [headers[op.col + 1], headers[op.col]]
        ;[aligns[op.col], aligns[op.col + 1]] = [aligns[op.col + 1], aligns[op.col]]
        for (const r of rows) {
          [r[op.col], r[op.col + 1]] = [r[op.col + 1], r[op.col]]
        }
      }
      break
    }
    case 'alignLeft':
      aligns[op.col] = 'left'
      break
    case 'alignCenter':
      aligns[op.col] = 'center'
      break
    case 'alignRight':
      aligns[op.col] = 'right'
      break
    case 'duplicateCol': {
      headers.splice(op.col + 1, 0, { ...headers[op.col] })
      aligns.splice(op.col + 1, 0, aligns[op.col] ?? null)
      for (const r of rows) {
        r.splice(op.col + 1, 0, { ...(r[op.col] ?? { text: '' }) })
      }
      break
    }
    case 'deleteCol': {
      if (colCount <= 1) break               
      headers.splice(op.col, 1)
      aligns.splice(op.col, 1)
      for (const r of rows) r.splice(op.col, 1)
      break
    }
  }
  return { ...model, headers, aligns, rows }
}

const MODEL_KEY = '__cmTableModel'

function setStoredModel(dom: HTMLElement, model: TableModel): void {
  (dom as unknown as Record<string, unknown>)[MODEL_KEY] = model
}
function getStoredModel(dom: HTMLElement): TableModel | undefined {
  return (dom as unknown as Record<string, unknown>)[MODEL_KEY] as TableModel | undefined
}

                                                  
function svgIcon(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

const ICONS = {
  // lucide-panel-top-close
  panelTopClose: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="m15 14-3-3-3 3"/>'),
  // lucide-panel-bottom-close
  panelBottomClose: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="m9 10 3 3 3-3"/>'),
  // lucide-arrow-up
  arrowUp: svgIcon('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  // lucide-arrow-down
  arrowDown: svgIcon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  // lucide-copy
  copy: svgIcon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  // lucide-scissors
  scissors: svgIcon('<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>'),
  // lucide-clipboard
  clipboard: svgIcon('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  // lucide-trash-2
  trash2: svgIcon('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
                                           
  gripVertical: svgIcon('<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>'),
                                             
  gripHorizontal: svgIcon('<circle cx="12" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="5" cy="9" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="19" cy="15" r="1"/><circle cx="5" cy="15" r="1"/>'),
                                                    
  plus: svgIcon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
                                    
  sortAsc: svgIcon('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>'),
                                    
  sortDesc: svgIcon('<path d="m3 16 4 4 4-4"/><path d="M7 4v16"/><path d="M15 4h5l-5 6h5"/><path d="M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"/><path d="M20 18h-5"/>'),
                                    
  panelLeftClose: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
                                     
  panelRightClose: svgIcon('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>'),
  // lucide-arrow-left
  arrowLeft: svgIcon('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  // lucide-arrow-right
  arrowRight: svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  // lucide-align-left
  alignLeft: svgIcon('<line x1="21" x2="3" y1="6" y2="6"/><line x1="15" x2="3" y1="12" y2="12"/><line x1="17" x2="3" y1="18" y2="18"/>'),
  // lucide-align-center
  alignCenter: svgIcon('<line x1="21" x2="3" y1="6" y2="6"/><line x1="17" x2="7" y1="12" y2="12"/><line x1="19" x2="5" y1="18" y2="18"/>'),
  // lucide-align-right
  alignRight: svgIcon('<line x1="21" x2="3" y1="6" y2="6"/><line x1="21" x2="9" y1="12" y2="12"/><line x1="21" x2="7" y1="18" y2="18"/>'),
}

export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super()
  }

  eq(other: TableWidget): boolean {
    const a = this.model
    const b = other.model
    if (a.tableFrom !== b.tableFrom || a.tableTo !== b.tableTo) return false
    if (a.headers.length !== b.headers.length) return false
    for (let i = 0; i < a.headers.length; i++) {
      if (a.headers[i].text !== b.headers[i].text) return false
    }
    if (a.aligns.length !== b.aligns.length) return false
    for (let i = 0; i < a.aligns.length; i++) {
      if (a.aligns[i] !== b.aligns[i]) return false
    }
    if (a.rows.length !== b.rows.length) return false
    for (let i = 0; i < a.rows.length; i++) {
      if (a.rows[i].length !== b.rows[i].length) return false
      for (let j = 0; j < a.rows[i].length; j++) {
        if (a.rows[i][j].text !== b.rows[i][j].text) return false
      }
    }
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    return renderTableDom(this.model, view)
  }

  destroy(dom: HTMLElement): void {
    (dom as unknown as { __cmTableCleanup?: () => void }).__cmTableCleanup?.()
  }

     
                                                    
                                            
                                                      
                                            
     
  get estimatedHeight(): number {
    const ROW_HEIGHT = 37                                          
    const WIDGET_PADDING = 32                             
    const rowCount = this.model.rows.length + 1         
    return WIDGET_PADDING + rowCount * ROW_HEIGHT
  }

     
                                                      
                                                                 
                                     
     
  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const thead = dom.querySelector('thead')
    const tbody = dom.querySelector('tbody')
    if (!thead || !tbody) return false

    const headerCellDoms = thead.querySelectorAll<HTMLElement>('th .table-cell-wrapper')
    if (headerCellDoms.length !== this.model.headers.length) return false

    const bodyRowDoms = tbody.querySelectorAll<HTMLElement>('tr')
    if (bodyRowDoms.length !== this.model.rows.length) return false
    for (let r = 0; r < bodyRowDoms.length; r++) {
      const cells = bodyRowDoms[r].querySelectorAll<HTMLElement>('td .table-cell-wrapper')
      if (cells.length !== this.model.rows[r].length) return false
    }

    const applyAlign = (cell: HTMLElement | null, colIdx: number): void => {
      if (!cell) return
      const align = this.model.aligns[colIdx] ?? null
      cell.style.textAlign = align ?? ''
    }

    const headerThs = thead.querySelectorAll<HTMLElement>('th')
    for (let i = 0; i < headerCellDoms.length; i++) {
      const cellDom = headerCellDoms[i]
      applyAlign(headerThs[i] ?? null, i)
      if (cellDom.dataset.editMode === '1') continue
      const next = this.model.headers[i].text
      if (cellDom.dataset.rawText !== next) {
        cellDom.dataset.rawText = next
        cellDom.innerHTML = renderCellHtml(next)
      }
    }
    for (let r = 0; r < bodyRowDoms.length; r++) {
      const tds = bodyRowDoms[r].querySelectorAll<HTMLElement>('td')
      const cells = bodyRowDoms[r].querySelectorAll<HTMLElement>('td .table-cell-wrapper')
      for (let c = 0; c < cells.length; c++) {
        const cellDom = cells[c]
        applyAlign(tds[c] ?? null, c)
        if (cellDom.dataset.editMode === '1') continue
        const next = this.model.rows[r][c].text
        if (cellDom.dataset.rawText !== next) {
          cellDom.dataset.rawText = next
          cellDom.innerHTML = renderCellHtml(next)
        }
      }
    }
    setStoredModel(dom, this.model)
    return true
  }

     
                                                             
                                                                              
                    
     
  ignoreEvent(event: Event): boolean {
    const t = event.type
    if (
      t === 'mousedown' || t === 'mouseup' || t === 'click' || t === 'dblclick'
      || t === 'pointerdown' || t === 'pointerup' || t === 'pointermove'
      || t === 'keydown' || t === 'keyup' || t === 'keypress'
      || t === 'input' || t === 'beforeinput'
      || t === 'compositionstart' || t === 'compositionupdate' || t === 'compositionend'
      || t === 'focus' || t === 'focusin' || t === 'focusout' || t === 'blur'
      || t === 'contextmenu' || t === 'paste' || t === 'copy' || t === 'cut'
      || t === 'selectstart'
    ) {
      return true
    }
    return false
  }
}

                                                              
function renderTableDom(model: TableModel, view: EditorView): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'cm-table-widget'
  setStoredModel(wrap, model)

                                                                 
                                                                     
                                                                        
                                                        
  wrap.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement | null)?.closest('.table-cell-wrapper')) return
    e.preventDefault()
    e.stopPropagation()
  })

  // Mount guard: on first paint the drag-handles (absolutely positioned as a
  // strip above the header / left of the rows, brand-purple bg) can briefly
  // reach opacity 1 — an 80ms opacity transition firing during the widget's
  // initial layout settle — flashing a purple border around the table. Force
  // them hidden + non-interactive + transition-less until layout is stable,
  // then drop the class after two frames so hover/drag behave normally.
  wrap.classList.add('is-mounting')
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      wrap.classList.remove('is-mounting')
    }),
  )

  const wrapper = document.createElement('div')
  wrapper.className = 'table-wrapper'
  const table = document.createElement('table')

  const getModel = (): TableModel => getStoredModel(wrap) ?? model

  function dispatchModel(next: TableModel): void {
    const md = buildTableMarkdown(next)
    const m = getModel()
    view.dispatch({
      changes: { from: m.tableFrom, to: m.tableTo, insert: md },
      annotations: tableSyncAnnotation.of(true),
    })
  }
                                                                  
  function syncDomToDoc(): boolean {
    const m = getModel()
    const newHeaders: CellRef[] = []
    const headerCells = table.querySelectorAll<HTMLElement>('thead th .table-cell-wrapper')
    for (const c of Array.from(headerCells)) {
      newHeaders.push({ text: readCellRawText(c) })
    }
    const newRows: CellRef[][] = []
    const trs = table.querySelectorAll<HTMLElement>('tbody tr')
    for (const tr of Array.from(trs)) {
      const cells = tr.querySelectorAll<HTMLElement>('td .table-cell-wrapper')
      const row: CellRef[] = []
      for (const c of Array.from(cells)) {
        row.push({ text: readCellRawText(c) })
      }
      newRows.push(row)
    }

    let changed = newHeaders.length !== m.headers.length
    if (!changed) {
      for (let i = 0; i < newHeaders.length; i++) {
        if (newHeaders[i].text !== m.headers[i].text) {
          changed = true
          break
        }
      }
    }
    if (!changed) changed = newRows.length !== m.rows.length
    if (!changed) {
      outer: for (let r = 0; r < newRows.length; r++) {
        if (newRows[r].length !== m.rows[r].length) {
          changed = true
          break
        }
        for (let c = 0; c < newRows[r].length; c++) {
          if (newRows[r][c].text !== m.rows[r][c].text) {
            changed = true
            break outer
          }
        }
      }
    }
    if (!changed) return false
    dispatchModel({ ...m, headers: newHeaders, rows: newRows })
    return true
  }

                                                          
  function moveHostSelectionOutside(): void {
    try {
      const m = getModel()
                                                               
      const target = Math.min(m.tableTo, view.state.doc.length)
      const cur = view.state.selection.main
      if (cur.from === target && cur.to === target) return
      view.dispatch({ selection: { anchor: target } })
    } catch {
      /* view destroyed */
    }
  }

  function buildCell(
    tag: 'th' | 'td',
    text: string,
    colIdx: number,
    rowIdx: number,
    isHeader: boolean,
  ): HTMLElement {
    const cell = document.createElement(tag)
    const align = model.aligns[colIdx] ?? null
    if (align) cell.style.textAlign = align
    cell.dataset.col = String(colIdx)
    if (!isHeader) cell.dataset.row = String(rowIdx)

    const inner = document.createElement('div')
    inner.className = 'table-cell-wrapper'
    inner.contentEditable = 'true'
    inner.spellcheck = false
    inner.dataset.rawText = text
    inner.dataset.editMode = '0'
    inner.innerHTML = renderCellHtml(text)

    inner.addEventListener('mousedown', (event) => {
      if (inner.dataset.editMode === '1') return
      activateTableCellWikilink(event.target, event, view)
    })

                                                      
                                           
    let cellEdited = false
    inner.addEventListener('input', () => {
      cellEdited = true
    })

                                                 
    const commitAndRun = (cmd: (v: EditorView) => boolean): void => {
      syncDomToDoc()
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      cmd(view)
      view.focus()
    }

                                                          
    cell.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      const me = e as MouseEvent
                                                                      
                                   
      if (me.button === 2) {
        e.preventDefault()
        return
      }
      onCellPointerDown(cell, me)
    })
    cell.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
    })

    inner.addEventListener('focus', () => {
                             
      clearCellSelection()
                                                
                                                        
      cellEdited = false
                                                                        
                                                             
      if (inner.dataset.editMode !== '1') {
        inner.dataset.editMode = '1'
        inner.textContent = inner.dataset.rawText ?? ''
        const range = document.createRange()
        range.selectNodeContents(inner)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      moveHostSelectionOutside()
    })
    inner.addEventListener('blur', () => {
                                                                       
      const raw = (inner.textContent ?? '').replace(/\r?\n/g, ' ')
      inner.dataset.rawText = raw
      inner.dataset.editMode = '0'
      inner.innerHTML = renderCellHtml(raw)
      syncDomToDoc()
    })
    inner.addEventListener('keydown', (e: KeyboardEvent) => {
      if (
        inner.dataset.editMode !== '1'
        && (e.key === 'Enter' || e.key === ' ')
        && activateTableCellWikilink(e.target, e, view)
      ) {
        return
      }
      const mod = e.metaKey || e.ctrlKey
                                                                  
                                                           
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        if (cellEdited) return
        e.preventDefault()
        commitAndRun(e.shiftKey ? redo : undo)
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        if (cellEdited) return
        e.preventDefault()
        commitAndRun(redo)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        moveFocus(cell, 'down')
      } else if (e.key === 'Tab') {
        e.preventDefault()
        moveFocus(cell, e.shiftKey ? 'prev' : 'next')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        ;(document.activeElement as HTMLElement | null)?.blur()
        view.focus()
      } else if (e.key === 'ArrowUp' && cursorAtFirstLine(inner)) {
        e.preventDefault()
        moveFocus(cell, 'up')
      } else if (e.key === 'ArrowDown' && cursorAtLastLine(inner)) {
        e.preventDefault()
        moveFocus(cell, 'down')
      }
    })
    inner.addEventListener('paste', (e) => {
      e.preventDefault()
      const t = e.clipboardData?.getData('text/plain') ?? ''
      document.execCommand('insertText', false, t.replace(/\r?\n/g, ' '))
    })
    cell.appendChild(inner)

                                                                  
                                                                      
                                                       
                                                
                                                                                        
    if (isHeader) {
      const colHandle = document.createElement('div')
      colHandle.className = 'table-col-drag-handle'
      colHandle.setAttribute('aria-label', i18next.getFixedT(null, 'document')('editor.extensions.table.colMenuLabel'))
      colHandle.innerHTML = ICONS.gripHorizontal
      colHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation()
      })
      colHandle.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        showColContextMenu(e, colIdx)
      })
      colHandle.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        showColContextMenu(e, colIdx)
      })
      cell.appendChild(colHandle)
    } else if (colIdx === 0) {
      const rowHandle = document.createElement('div')
      rowHandle.className = 'table-row-drag-handle'
      rowHandle.setAttribute('aria-label', i18next.getFixedT(null, 'document')('editor.extensions.table.rowMenuLabel'))
      rowHandle.innerHTML = ICONS.gripVertical
      rowHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation()
      })
      rowHandle.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        showRowContextMenu(e, rowIdx)
      })
      rowHandle.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        showRowContextMenu(e, rowIdx)
      })
      cell.appendChild(rowHandle)
    }

    cell.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isHeader) {
        showColContextMenu(e, colIdx)
      } else {
        showRowContextMenu(e, rowIdx)
      }
    })
    return cell
  }

  /**
   * Uses Range API to get the caret y coordinate, compares to the cell's bounding rect.
   * If the caret is within half a line-height of the top, it's on the first visual line.
   * Empty cell (no text nodes / no caret) → defaults to true.
   */
  function cursorAtFirstLine(el: HTMLElement): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return true
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return true
    const caretRect = range.getClientRects()[0]
    if (!caretRect) return true
    const elRect = el.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
    return caretRect.top - elRect.top < lineHeight * 0.5
  }

  function cursorAtLastLine(el: HTMLElement): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return true
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return true
    const caretRect = range.getClientRects()[0]
    if (!caretRect) return true
    const elRect = el.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
    return elRect.bottom - caretRect.bottom < lineHeight * 0.5
  }

  function moveFocus(cell: HTMLElement, dir: 'prev' | 'next' | 'up' | 'down'): void {
    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'))
    const inThisRow = (cell.parentElement as HTMLTableRowElement) ?? null
    const rowIdx = inThisRow ? allRows.indexOf(inThisRow) : -1
    const cells = inThisRow
      ? Array.from(inThisRow.querySelectorAll<HTMLElement>('th, td'))
      : []
    const colIdx = cells.indexOf(cell)
    let target: HTMLElement | null = null
    if (dir === 'next') {
      target = (cells[colIdx + 1]
        ?? (allRows[rowIdx + 1]?.children[0] as HTMLElement | undefined))
        ?? null
    } else if (dir === 'prev') {
      const prevRow = allRows[rowIdx - 1]
      target = (cells[colIdx - 1]
        ?? (prevRow?.children[(prevRow.children.length ?? 1) - 1] as HTMLElement | undefined))
        ?? null
    } else if (dir === 'up') {
      target = (allRows[rowIdx - 1]?.children[colIdx] as HTMLElement | undefined) ?? null
    } else if (dir === 'down') {
      target = (allRows[rowIdx + 1]?.children[colIdx] as HTMLElement | undefined) ?? null
    }
    const inner = target?.querySelector<HTMLElement>('.table-cell-wrapper')
    if (inner) {
      inner.focus()
      const range = document.createRange()
      range.selectNodeContents(inner)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }

                                  
                                                       
                                                   
                                                  
  type CellCoord = { vrow: number; col: number }
  const selectionBox = document.createElement('div')
  selectionBox.className = 'table-cell-selection-box'
  selectionBox.style.display = 'none'
  let selAnchor: CellCoord | null = null
  let selFocus: CellCoord | null = null
  let pendingAnchor: CellCoord | null = null
  let dragActive = false

  function cellCoord(cell: HTMLElement): CellCoord | null {
    const col = Number(cell.dataset.col)
    if (Number.isNaN(col)) return null
    const tr = cell.closest('tr')
    if (!tr) return null
    const vrow = Array.from(table.querySelectorAll('tr')).indexOf(tr)
    if (vrow < 0) return null
    return { vrow, col }
  }

  function clearCellSelection(): void {
    selAnchor = null
    selFocus = null
    for (const el of Array.from(table.querySelectorAll('.is-cell-selected'))) {
      el.classList.remove('is-cell-selected')
    }
    selectionBox.style.display = 'none'
  }

  function positionSelectionBox(tl: HTMLElement, br: HTMLElement): void {
    const wrapRect = wrapper.getBoundingClientRect()
    const a = tl.getBoundingClientRect()
    const b = br.getBoundingClientRect()
    selectionBox.style.left = `${Math.min(a.left, b.left) - wrapRect.left}px`
    selectionBox.style.top = `${Math.min(a.top, b.top) - wrapRect.top}px`
    selectionBox.style.width = `${Math.max(a.right, b.right) - Math.min(a.left, b.left)}px`
    selectionBox.style.height = `${Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)}px`
    selectionBox.style.display = 'block'
  }

  function paintCellSelection(): void {
    if (!selAnchor || !selFocus) {
      clearCellSelection()
      return
    }
    const r0 = Math.min(selAnchor.vrow, selFocus.vrow)
    const r1 = Math.max(selAnchor.vrow, selFocus.vrow)
    const c0 = Math.min(selAnchor.col, selFocus.col)
    const c1 = Math.max(selAnchor.col, selFocus.col)
    let tl: HTMLElement | null = null
    let br: HTMLElement | null = null
    Array.from(table.querySelectorAll('tr')).forEach((tr, vrow) => {
      for (const cell of Array.from(tr.querySelectorAll<HTMLElement>('th, td'))) {
        const col = Number(cell.dataset.col)
        const inside = vrow >= r0 && vrow <= r1 && col >= c0 && col <= c1
        cell.classList.toggle('is-cell-selected', inside)
        if (inside) {
          if (vrow === r0 && col === c0) tl = cell
          if (vrow === r1 && col === c1) br = cell
        }
      }
    })
    if (tl && br) positionSelectionBox(tl, br)
    else selectionBox.style.display = 'none'
  }

  function onDocMouseMove(e: MouseEvent): void {
    if (!pendingAnchor) return
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    const overCell = el?.closest?.('td, th') as HTMLElement | null
    if (!overCell || !wrapper.contains(overCell)) return
    const coord = cellCoord(overCell)
    if (!coord) return
    if (!dragActive) {
                                      
      if (coord.vrow === pendingAnchor.vrow && coord.col === pendingAnchor.col) return
      dragActive = true
      selAnchor = pendingAnchor
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      window.getSelection()?.removeAllRanges()
      wrap.classList.add('is-cell-selecting')
    }
    selFocus = coord
    paintCellSelection()
    e.preventDefault()
  }

  function onDocMouseUp(): void {
    document.removeEventListener('mousemove', onDocMouseMove, true)
    document.removeEventListener('mouseup', onDocMouseUp, true)
    if (dragActive) wrap.classList.remove('is-cell-selecting')
    pendingAnchor = null
    dragActive = false
  }

  function onCellPointerDown(cell: HTMLElement, e: MouseEvent): void {
    if (e.button !== 0) return
    clearCellSelection()
    pendingAnchor = cellCoord(cell)
    dragActive = false
    if (!pendingAnchor) return
    document.addEventListener('mousemove', onDocMouseMove, true)
    document.addEventListener('mouseup', onDocMouseUp, true)
  }

                                                               
  function tsvForRange(r0: number, r1: number, c0: number, c1: number): string {
    const trs = Array.from(table.querySelectorAll('tr'))
    const lines: string[] = []
    for (let vrow = r0; vrow <= r1; vrow++) {
      const tr = trs[vrow]
      if (!tr) continue
      const cols: string[] = []
      for (const cell of Array.from(tr.querySelectorAll<HTMLElement>('th, td'))) {
        const col = Number(cell.dataset.col)
        if (col < c0 || col > c1) continue
        const inner = cell.querySelector<HTMLElement>('.table-cell-wrapper')
        cols.push(inner ? readCellRawText(inner) : '')
      }
      lines.push(cols.join('\t'))
    }
    return lines.join('\n')
  }

  function selectionToTsv(): string | null {
    if (!selAnchor || !selFocus) return null
    const r0 = Math.min(selAnchor.vrow, selFocus.vrow)
    const r1 = Math.max(selAnchor.vrow, selFocus.vrow)
    const c0 = Math.min(selAnchor.col, selFocus.col)
    const c1 = Math.max(selAnchor.col, selFocus.col)
    return tsvForRange(r0, r1, c0, c1)
  }

  function onDocCopy(e: ClipboardEvent): void {
    if (!selAnchor || !selFocus) return
    const active = document.activeElement as HTMLElement | null
                                          
    if (active && wrap.contains(active) && active.isContentEditable) return
    const tsv = selectionToTsv()
    if (tsv == null) return
    e.clipboardData?.setData('text/plain', tsv)
    e.preventDefault()
  }

                                                              
  function onDocCut(e: ClipboardEvent): void {
    if (!selAnchor || !selFocus) return
    const active = document.activeElement as HTMLElement | null
    if (active && wrap.contains(active) && active.isContentEditable) return
    const range = currentRange()
    if (!range) return
    e.clipboardData?.setData('text/plain', tsvForRange(range.r0, range.r1, range.c0, range.c1))
    e.preventDefault()
    clearSelectedCells(range)
  }

                                                                             
  function onDocKeydown(e: KeyboardEvent): void {
    if (!selAnchor || !selFocus) return
    const active = document.activeElement as HTMLElement | null
    if (active && wrap.contains(active) && active.isContentEditable) return
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault()
      ;(e.shiftKey ? redo : undo)(view)
      view.focus()
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault()
      redo(view)
      view.focus()
    }
  }

  function onDocMouseDownOutside(e: MouseEvent): void {
    if (!wrap.contains(e.target as Node)) clearCellSelection()
  }

  document.addEventListener('copy', onDocCopy, true)
  document.addEventListener('cut', onDocCut, true)
  document.addEventListener('keydown', onDocKeydown, true)
  document.addEventListener('mousedown', onDocMouseDownOutside, true)
  ;(wrap as unknown as { __cmTableCleanup?: () => void }).__cmTableCleanup = () => {
    document.removeEventListener('copy', onDocCopy, true)
    document.removeEventListener('cut', onDocCut, true)
    document.removeEventListener('keydown', onDocKeydown, true)
    document.removeEventListener('mousedown', onDocMouseDownOutside, true)
    document.removeEventListener('mousemove', onDocMouseMove, true)
    document.removeEventListener('mouseup', onDocMouseUp, true)
  }

                                                        
  function setRowHandleActive(rowIdx: number, active: boolean): void {
    const tr = table.querySelectorAll<HTMLElement>('tbody tr')[rowIdx]
    if (!tr) return
    const handle = tr.querySelector<HTMLElement>('.table-row-drag-handle')
    if (!handle) return
    handle.classList.toggle('is-active', active)
  }
                                      
  function setColHandleActive(colIdx: number, active: boolean): void {
    const thead = table.querySelector('thead')
    if (!thead) return
    const th = thead.querySelectorAll<HTMLElement>('th')[colIdx]
    if (!th) return
    const handle = th.querySelector<HTMLElement>('.table-col-drag-handle')
    if (!handle) return
    handle.classList.toggle('is-active', active)
  }

  /**
   * Attaches keyboard ↑/↓/Enter handling + mouse hover sync to an already-built menu.
   * First item is selected by default. Returned detach() must be called by cleanup().
   */
  function attachMenuKeyboardNav(menu: HTMLElement): () => void {
    const items = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('.cm-table-menu-item'))
    let selected = 0
    const render = () => {
      items().forEach((it, i) => it.classList.toggle('is-selected', i === selected))
    }
    if (items().length > 0) render()

    items().forEach((it, i) => {
      it.addEventListener('mouseenter', () => {
        selected = i
        render()
      })
    })

    const onKey = (e: KeyboardEvent): void => {
      const list = items()
      if (list.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        selected = (selected + 1) % list.length
        render()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        selected = (selected - 1 + list.length) % list.length
        render()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        list[selected]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
    }
  }

  function showRowContextMenu(event: MouseEvent, rowIdx: number): void {
    document.querySelectorAll('.cm-table-menu').forEach((n) => n.remove())

    const bodyRows = table.querySelectorAll<HTMLElement>('tbody tr')
    bodyRows.forEach((tr, i) => tr.classList.toggle('is-row-selected', i === rowIdx))
    setRowHandleActive(rowIdx, true)

    const menu = document.createElement('div')
    menu.className = 'cm-table-menu'
    menu.style.top = `${event.clientY}px`
    menu.style.left = `${event.clientX}px`

    const rowsLen = getModel().rows.length
    const rowColCount = Math.max(getModel().headers.length, ...getModel().rows.map((r) => r.length), 1)
    const rowRange: SelRange = { r0: rowIdx + 1, r1: rowIdx + 1, c0: 0, c1: rowColCount - 1 }

                                                               
    type MenuItem = { label: string; icon: string; section: string; op?: RowOp; action?: () => void; warning?: boolean }
    const t = i18next.getFixedT(null, 'document')
    const items: MenuItem[] = []
    items.push({ label: t('editor.extensions.table.insertRowAbove'), icon: ICONS.panelTopClose, op: { type: 'insertAbove', row: rowIdx }, section: 'add' })
    items.push({ label: t('editor.extensions.table.insertRowBelow'), icon: ICONS.panelBottomClose, op: { type: 'insertBelow', row: rowIdx }, section: 'add' })
    if (rowIdx > 0) {
      items.push({ label: t('editor.extensions.table.moveRowUp'), icon: ICONS.arrowUp, op: { type: 'moveUp', row: rowIdx }, section: 'move' })
    }
    if (rowIdx < rowsLen - 1) {
      items.push({ label: t('editor.extensions.table.moveRowDown'), icon: ICONS.arrowDown, op: { type: 'moveDown', row: rowIdx }, section: 'move' })
    }
    items.push({ label: t('editor.extensions.table.cellCut'), icon: ICONS.scissors, section: 'clip', action: () => { void copySelectionToClipboard(rowRange).then(() => clearSelectedCells(rowRange)) } })
    items.push({ label: t('editor.extensions.table.cellCopy'), icon: ICONS.copy, section: 'clip', action: () => { void copySelectionToClipboard(rowRange) } })
    items.push({ label: t('editor.extensions.table.cellPaste'), icon: ICONS.clipboard, section: 'clip', action: () => { void pasteIntoSelection(rowRange) } })
    items.push({ label: t('editor.extensions.table.duplicateRow'), icon: ICONS.copy, op: { type: 'duplicate', row: rowIdx }, section: 'modify' })
    items.push({ label: t('editor.extensions.table.deleteRow'), icon: ICONS.trash2, op: { type: 'delete', row: rowIdx }, section: 'danger', warning: true })

    let lastSection: string | undefined
    for (const it of items) {
      if (lastSection && it.section !== lastSection) {
        const sep = document.createElement('div')
        sep.className = 'cm-table-menu-sep'
        menu.appendChild(sep)
      }
      lastSection = it.section
      const button = document.createElement('button')
      button.type = 'button'
      button.className = it.warning ? 'cm-table-menu-item is-warning' : 'cm-table-menu-item'
      button.innerHTML = `<span class="cm-table-menu-icon">${it.icon}</span><span class="cm-table-menu-label">${it.label}</span>`
      button.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (it.action) {
          it.action()
          cleanup()
          return
        }
        if (!it.op) {
          cleanup()
          return
        }
                                                    
        const synced = syncDomToDoc()
        const base = synced ? readModelFromDom() : getModel()
        const next = applyRowOp(base, it.op)
        dispatchModel(next)
        cleanup()
      })
      menu.appendChild(button)
    }

    document.body.appendChild(menu)

    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`

    const detachKeyboard = attachMenuKeyboardNav(menu)

    const cleanup = (): void => {
      menu.remove()
      bodyRows.forEach((tr) => tr.classList.remove('is-row-selected'))
      setRowHandleActive(rowIdx, false)
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      detachKeyboard()
    }
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) cleanup()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cleanup()
    }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }

     
                                                                                      
                                                                      
                                              
     
  function showColContextMenu(event: MouseEvent, colIdx: number): void {
    document.querySelectorAll('.cm-table-menu').forEach((n) => n.remove())

    const m0 = getModel()
    const colCount = Math.max(m0.headers.length, ...m0.rows.map((r) => r.length), 1)

                                                                  
    const thCells = table.querySelectorAll<HTMLElement>('thead th')
    thCells.forEach((th, i) => th.classList.toggle('is-col-selected', i === colIdx))
    const allBodyTds: HTMLElement[] = []
    table.querySelectorAll<HTMLElement>('tbody tr').forEach((tr) => {
      const tds = tr.querySelectorAll<HTMLElement>('td')
      tds.forEach((td, i) => {
        if (i === colIdx) {
          td.classList.add('is-col-selected')
          allBodyTds.push(td)
        }
      })
    })
    setColHandleActive(colIdx, true)

    const menu = document.createElement('div')
    menu.className = 'cm-table-menu'
    menu.style.top = `${event.clientY}px`
    menu.style.left = `${event.clientX}px`

    type MenuItem = { label: string; icon: string; section: string; op?: ColOp; action?: () => void; warning?: boolean }
    const t = i18next.getFixedT(null, 'document')
    const colRange: SelRange = { r0: 0, r1: getModel().rows.length, c0: colIdx, c1: colIdx }
    const items: MenuItem[] = []
    items.push({ label: t('editor.extensions.table.sortColAsc'), icon: ICONS.sortAsc, op: { type: 'sortAsc', col: colIdx }, section: 'sort' })
    items.push({ label: t('editor.extensions.table.sortColDesc'), icon: ICONS.sortDesc, op: { type: 'sortDesc', col: colIdx }, section: 'sort' })
    items.push({ label: t('editor.extensions.table.insertColLeft'), icon: ICONS.panelLeftClose, op: { type: 'insertLeft', col: colIdx }, section: 'add' })
    items.push({ label: t('editor.extensions.table.insertColRight'), icon: ICONS.panelRightClose, op: { type: 'insertRight', col: colIdx }, section: 'add' })
    if (colIdx > 0) {
      items.push({ label: t('editor.extensions.table.moveColLeft'), icon: ICONS.arrowLeft, op: { type: 'moveLeft', col: colIdx }, section: 'move' })
    }
    if (colIdx < colCount - 1) {
      items.push({ label: t('editor.extensions.table.moveColRight'), icon: ICONS.arrowRight, op: { type: 'moveRight', col: colIdx }, section: 'move' })
    }
    items.push({ label: t('editor.extensions.table.alignLeft'), icon: ICONS.alignLeft, op: { type: 'alignLeft', col: colIdx }, section: 'align' })
    items.push({ label: t('editor.extensions.table.alignCenter'), icon: ICONS.alignCenter, op: { type: 'alignCenter', col: colIdx }, section: 'align' })
    items.push({ label: t('editor.extensions.table.alignRight'), icon: ICONS.alignRight, op: { type: 'alignRight', col: colIdx }, section: 'align' })
    items.push({ label: t('editor.extensions.table.cellCut'), icon: ICONS.scissors, section: 'clip', action: () => { void copySelectionToClipboard(colRange).then(() => clearSelectedCells(colRange)) } })
    items.push({ label: t('editor.extensions.table.cellCopy'), icon: ICONS.copy, section: 'clip', action: () => { void copySelectionToClipboard(colRange) } })
    items.push({ label: t('editor.extensions.table.cellPaste'), icon: ICONS.clipboard, section: 'clip', action: () => { void pasteIntoSelection(colRange) } })
    items.push({ label: t('editor.extensions.table.duplicateCol'), icon: ICONS.copy, op: { type: 'duplicateCol', col: colIdx }, section: 'modify' })
    if (colCount > 1) {
      items.push({ label: t('editor.extensions.table.deleteCol'), icon: ICONS.trash2, op: { type: 'deleteCol', col: colIdx }, section: 'danger', warning: true })
    }

    let lastSection: string | undefined
    for (const it of items) {
      if (lastSection && it.section !== lastSection) {
        const sep = document.createElement('div')
        sep.className = 'cm-table-menu-sep'
        menu.appendChild(sep)
      }
      lastSection = it.section
      const button = document.createElement('button')
      button.type = 'button'
      button.className = it.warning ? 'cm-table-menu-item is-warning' : 'cm-table-menu-item'
      button.innerHTML = `<span class="cm-table-menu-icon">${it.icon}</span><span class="cm-table-menu-label">${it.label}</span>`
      button.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (it.action) {
          it.action()
          cleanup()
          return
        }
        if (!it.op) {
          cleanup()
          return
        }
        const synced = syncDomToDoc()
        const base = synced ? readModelFromDom() : getModel()
        const next = applyColOp(base, it.op)
        dispatchModel(next)
        cleanup()
      })
      menu.appendChild(button)
    }

    document.body.appendChild(menu)

    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`

    const detachKeyboard = attachMenuKeyboardNav(menu)

    const cleanup = (): void => {
      menu.remove()
      thCells.forEach((th) => th.classList.remove('is-col-selected'))
      allBodyTds.forEach((td) => td.classList.remove('is-col-selected'))
      setColHandleActive(colIdx, false)
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onKey, true)
      detachKeyboard()
    }
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) cleanup()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cleanup()
    }
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }

                                   
                                                                
  type SelRange = { r0: number; r1: number; c0: number; c1: number }

  function currentRange(): SelRange | null {
    if (!selAnchor || !selFocus) return null
    return {
      r0: Math.min(selAnchor.vrow, selFocus.vrow),
      r1: Math.max(selAnchor.vrow, selFocus.vrow),
      c0: Math.min(selAnchor.col, selFocus.col),
      c1: Math.max(selAnchor.col, selFocus.col),
    }
  }

  function coordInSelection(coord: CellCoord): boolean {
    const r = currentRange()
    if (!r) return false
    return coord.vrow >= r.r0 && coord.vrow <= r.r1 && coord.col >= r.c0 && coord.col <= r.c1
  }

                                                                          
  function setCellText(base: TableModel, vrow: number, col: number, text: string): void {
    if (vrow === 0) {
      if (base.headers[col]) base.headers[col].text = text
    } else {
      const row = base.rows[vrow - 1]
      if (row && row[col]) row[col].text = text
    }
  }

  function cloneModel(base: TableModel): TableModel {
    return {
      ...base,
      headers: base.headers.map((c) => ({ ...c })),
      aligns: [...base.aligns],
      rows: base.rows.map((r) => r.map((c) => ({ ...c }))),
    }
  }

  function baseModel(): TableModel {
    const synced = syncDomToDoc()
    return synced ? readModelFromDom() : getModel()
  }

  function clearSelectedCells(range: SelRange): void {
    const next = cloneModel(baseModel())
    for (let vrow = range.r0; vrow <= range.r1; vrow++) {
      for (let col = range.c0; col <= range.c1; col++) setCellText(next, vrow, col, '')
    }
    dispatchModel(next)
  }

     
                                                    
                                                        
     
  function deleteSelectedCells(range: SelRange): void {
    const base = baseModel()
    const colCount = Math.max(base.headers.length, ...base.rows.map((r) => r.length), 1)
    const lastVrow = base.rows.length                                
    const fullHeight = range.r0 === 0 && range.r1 === lastVrow
    const fullWidth = range.c0 === 0 && range.c1 === colCount - 1
    if (fullHeight && !fullWidth) {
      let next = base
                     
      for (let col = range.c1; col >= range.c0; col--) {
        const cc = Math.max(next.headers.length, ...next.rows.map((r) => r.length), 1)
        if (cc <= 1) break          
        next = applyColOp(next, { type: 'deleteCol', col })
      }
      dispatchModel(next)
      return
    }
                            
    const modelR0 = Math.max(range.r0, 1) - 1
    const modelR1 = range.r1 - 1
    if (modelR1 < modelR0) return
    let next = base
    for (let r = modelR1; r >= modelR0; r--) {
      if (next.rows.length <= 1) break          
      next = applyRowOp(next, { type: 'delete', row: r })
    }
    dispatchModel(next)
  }

  function alignSelectedCols(range: SelRange, type: 'alignLeft' | 'alignCenter' | 'alignRight'): void {
    let next = baseModel()
    for (let col = range.c0; col <= range.c1; col++) next = applyColOp(next, { type, col })
    dispatchModel(next)
  }

  async function copySelectionToClipboard(range: SelRange): Promise<void> {
    const tsv = tsvForRange(range.r0, range.r1, range.c0, range.c1)
    try {
      await navigator.clipboard.writeText(tsv)
    } catch {
      /* Clipboard access can fail without permission or a secure context. */
    }
  }

  async function pasteIntoSelection(range: SelRange): Promise<void> {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return          
    }
    if (!text) return
    const matrix = text
      .replace(/\r/g, '')
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.split('\t'))
    const next = cloneModel(baseModel())
    const colCount = Math.max(next.headers.length, ...next.rows.map((r) => r.length), 1)
    const lastVrow = next.rows.length
    for (let i = 0; i < matrix.length; i++) {
      const vrow = range.r0 + i
      if (vrow > lastVrow) break             
      for (let j = 0; j < matrix[i].length; j++) {
        const col = range.c0 + j
        if (col >= colCount) break
        setCellText(next, vrow, col, matrix[i][j])
      }
    }
    dispatchModel(next)
  }

  function showCellContextMenu(event: MouseEvent): void {
    const range = currentRange()
    if (!range) return

                                                       
                                  
    const t = i18next.getFixedT(null, 'document')
    const menu = new Menu()
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.cellCut')).setIcon('scissors').setShortcut('⌘X').onSelect(() => { void copySelectionToClipboard(range).then(() => clearSelectedCells(range)) }))
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.cellCopy')).setIcon('copy').setShortcut('⌘C').onSelect(() => { void copySelectionToClipboard(range) }))
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.cellPaste')).setIcon('clipboard').setShortcut('⌘V').onSelect(() => { void pasteIntoSelection(range) }))
    menu.addSeparator()
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.alignLeft')).setIcon('align-left').onSelect(() => alignSelectedCols(range, 'alignLeft')))
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.alignCenter')).setIcon('align-center').onSelect(() => alignSelectedCols(range, 'alignCenter')))
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.alignRight')).setIcon('align-right').onSelect(() => alignSelectedCols(range, 'alignRight')))
    menu.addSeparator()
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.clearCells')).setIcon('eraser').onSelect(() => clearSelectedCells(range)))
    menu.addItem((i) => i.setTitle(t('editor.extensions.table.deleteCells')).setIcon('trash-2').setWarning(true).onSelect(() => deleteSelectedCells(range)))
    menu.showAtMouseEvent(event)
  }

  function onCellContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null
    const cell = target?.closest?.('th, td') as HTMLElement | null
    if (!cell || !table.contains(cell)) return
                                                                         
    e.preventDefault()
    e.stopPropagation()
    const coord = cellCoord(cell)
    if (!coord) return
                                        
    if (!coordInSelection(coord)) {
      clearCellSelection()
      selAnchor = coord
      selFocus = coord
      paintCellSelection()
    }
    showCellContextMenu(e)
  }
  table.addEventListener('contextmenu', onCellContextMenu)

  function readModelFromDom(): TableModel {
    const m = getModel()
    const newHeaders: CellRef[] = []
    const headerCells = table.querySelectorAll<HTMLElement>('thead th .table-cell-wrapper')
    for (const c of Array.from(headerCells)) {
      newHeaders.push({ text: readCellRawText(c) })
    }
    const newRows: CellRef[][] = []
    for (const tr of Array.from(table.querySelectorAll<HTMLElement>('tbody tr'))) {
      const cells = tr.querySelectorAll<HTMLElement>('td .table-cell-wrapper')
      const row: CellRef[] = []
      for (const c of Array.from(cells)) {
        row.push({ text: readCellRawText(c) })
      }
      newRows.push(row)
    }
    return { ...m, headers: newHeaders, rows: newRows }
  }

           
  if (model.headers.length > 0) {
    const thead = document.createElement('thead')
    const tr = document.createElement('tr')
    for (let i = 0; i < model.headers.length; i++) {
      tr.appendChild(buildCell('th', model.headers[i].text, i, -1, true))
    }
    thead.appendChild(tr)
    table.appendChild(thead)
  }
  const tbody = document.createElement('tbody')
  for (let r = 0; r < model.rows.length; r++) {
    const tr = document.createElement('tr')
    tr.dataset.row = String(r)
    for (let c = 0; c < model.rows[r].length; c++) {
      tr.appendChild(buildCell('td', model.rows[r][c].text, c, r, false))
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrapper.appendChild(table)
  wrapper.appendChild(selectionBox)

  // Keep pointer-down from moving the editor selection before row insertion.
                                                                         
                                                                         
                                                                              
                                                             
                                                                                   
                                                                  
  let appendBusy = false
  const fireAppend = (op: RowOp) => {
    if (appendBusy) return
    appendBusy = true
                                                         
                                              
    queueMicrotask(() => {
      try {
        const synced = syncDomToDoc()
        const base = synced ? readModelFromDom() : getModel()
        const next = applyRowOp(base, op)
        dispatchModel(next)
      } finally {
        appendBusy = false
      }
    })
  }
  const makeAppendButton = (
    cls: string,
    label: string,
    op: RowOp,
  ): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = cls
    btn.setAttribute('aria-label', label)
    btn.title = label
                                                 
    btn.textContent = '+'
    const handle = (e: Event) => {
      const me = e as MouseEvent
      if (me.button !== undefined && me.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      fireAppend(op)
    }
                                    
    btn.addEventListener('click', handle, { capture: true })
    return btn
  }
  const appendT = i18next.getFixedT(null, 'document')
  wrapper.appendChild(makeAppendButton('table-row-btn', appendT('editor.extensions.table.appendRow'), { type: 'appendRow' }))
  wrapper.appendChild(makeAppendButton('table-col-btn', appendT('editor.extensions.table.appendCol'), { type: 'appendCol' }))
  wrap.appendChild(wrapper)

  return wrap
}
