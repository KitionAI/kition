   
                
  
                                 
                                      
                        
  
                                              
   

import type { EditorState } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import type { Command } from '@codemirror/view'

type Cell = { from: number; to: number }

   
                             
                               
   
function tableCells(lineText: string, lineFrom: number): Cell[] | null {
  if (!lineText.trim().startsWith('|')) return null
  const cells: Cell[] = []
  let i = 0
           
  while (i < lineText.length && /\s/.test(lineText[i])) i++
  if (lineText[i] !== '|') return null
  i += 1
  let cellStart = i
  while (i < lineText.length) {
    if (lineText[i] === '|') {
      cells.push({ from: lineFrom + cellStart, to: lineFrom + i })
      cellStart = i + 1
    }
    i += 1
  }
  if (cells.length === 0) return null
  return cells
}

function lineIsTable(state: EditorState, lineNumber: number): boolean {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return false
  const t = state.doc.line(lineNumber).text.trim()
  return t.startsWith('|') && t.includes('|')
}

function findCellIndex(cells: Cell[], pos: number): number {
  for (let i = 0; i < cells.length; i++) {
    if (pos >= cells[i].from && pos <= cells[i].to) return i
  }
                 
  return cells.length - 1
}

function cellInsidePos(cells: Cell[], idx: number): number {
                            
  if (idx < 0 || idx >= cells.length) return cells[Math.max(0, Math.min(cells.length - 1, idx))]?.from ?? 0
  return cells[idx].from + 1 < cells[idx].to ? cells[idx].from + 1 : cells[idx].from
}

function emptyRowFor(cells: Cell[]): string {
  return '| ' + Array.from({ length: cells.length }, () => '   ').join(' | ') + ' |'
}

export const tableNextCell: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const lineObj = state.doc.lineAt(main.head)
  const cells = tableCells(lineObj.text, lineObj.from)
  if (!cells) return false
  const idx = findCellIndex(cells, main.head)
          
  if (idx < cells.length - 1) {
    view.dispatch({ selection: EditorSelection.cursor(cellInsidePos(cells, idx + 1)) })
    return true
  }
                 
  let nextLineNum = lineObj.number + 1
  if (lineIsTable(state, nextLineNum)) {
    const nextLine = state.doc.line(nextLineNum)
    if (/^\s*\|?[\s\-:|]+\|?\s*$/.test(nextLine.text)) {
      nextLineNum += 1
    }
  }
  if (lineIsTable(state, nextLineNum)) {
    const nextLine = state.doc.line(nextLineNum)
    const nextCells = tableCells(nextLine.text, nextLine.from) ?? []
    view.dispatch({ selection: EditorSelection.cursor(cellInsidePos(nextCells, 0)) })
    return true
  }
                
  const newRow = '\n' + emptyRowFor(cells)
  const insertAt = lineObj.to
  view.dispatch({
    changes: { from: insertAt, insert: newRow },
    selection: EditorSelection.cursor(insertAt + 2 + 1),             
  })
  return true
}

export const tablePrevCell: Command = (view) => {
  const state = view.state
  const main = state.selection.main
  const lineObj = state.doc.lineAt(main.head)
  const cells = tableCells(lineObj.text, lineObj.from)
  if (!cells) return false
  const idx = findCellIndex(cells, main.head)
  if (idx > 0) {
    view.dispatch({ selection: EditorSelection.cursor(cellInsidePos(cells, idx - 1)) })
    return true
  }
                 
  let prevLineNum = lineObj.number - 1
  if (lineIsTable(state, prevLineNum)) {
    const prevLine = state.doc.line(prevLineNum)
    if (/^\s*\|?[\s\-:|]+\|?\s*$/.test(prevLine.text)) {
      prevLineNum -= 1
    }
  }
  if (lineIsTable(state, prevLineNum)) {
    const prevLine = state.doc.line(prevLineNum)
    const prevCells = tableCells(prevLine.text, prevLine.from) ?? []
    view.dispatch({
      selection: EditorSelection.cursor(cellInsidePos(prevCells, prevCells.length - 1)),
    })
    return true
  }
  return false
}
