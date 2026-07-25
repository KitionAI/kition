   
                   
  
                                
                                          
                              
                                                 
                                           
                                
                                
                              
                              
                                                       
                                                         
  
                                                                       
   

import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { codeFolding, foldKeymap } from '@codemirror/language'
import { copyLineDown, cursorLineEnd, deleteLine, moveLineDown, moveLineUp, simplifySelection } from '@codemirror/commands'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { Prec } from '@codemirror/state'
import { type Command, keymap } from '@codemirror/view'

import {
  cycleListType,
  demoteHeading,
  demoteListItem,
  foldHeadingsBelowLevel,
  insertLink,
  jumpFootnote,
  jumpToNextHeading,
  jumpToPrevHeading,
  moveSectionDown,
  moveSectionUp,
  promoteHeading,
  promoteListItem,
  setLineHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTaskCheckbox,
  toggleTodoList,
} from '../commands'
import { tableNextCell, tablePrevCell } from './table-nav'

// Wrap each selection range with `<!-- … -->` or unwrap if already wrapped.
const toggleHtmlComment: Command = (view) => {
  const state = view.state
  const changes: { from: number; to: number; insert: string }[] = []
  for (const range of state.selection.ranges) {
    const text = state.sliceDoc(range.from, range.to)
    const trimmed = text.trim()
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
                           
      const lead = text.indexOf('<!--')
      const trail = text.lastIndexOf('-->')
      const inner = text.slice(lead + 4, trail).replace(/^\s/, '').replace(/\s$/, '')
      const before = text.slice(0, lead)
      const after = text.slice(trail + 3)
      changes.push({ from: range.from, to: range.to, insert: before + inner + after })
    } else if (range.empty) {
             
      const line = state.doc.lineAt(range.from)
      const lineText = line.text
      if (lineText.trim().startsWith('<!--') && lineText.trim().endsWith('-->')) {
        const stripped = lineText.replace(/^(\s*)<!--\s?/, '$1').replace(/\s?-->\s*$/, '')
        changes.push({ from: line.from, to: line.to, insert: stripped })
      } else {
        const indent = lineText.match(/^(\s*)/)?.[1] ?? ''
        const body = lineText.slice(indent.length)
        changes.push({ from: line.from, to: line.to, insert: `${indent}<!-- ${body} -->` })
      }
    } else {
      changes.push({ from: range.from, to: range.to, insert: `<!-- ${text} -->` })
    }
  }
  if (changes.length === 0) return false
  view.dispatch({ changes })
  return true
}

export function documentKeymap() {
  return [
    codeFolding(),
    keymap.of(foldKeymap),
    Prec.high(
      keymap.of([
        { key: 'Mod-b', run: toggleBold, preventDefault: true },
        { key: 'Mod-i', run: toggleItalic, preventDefault: true },
        { key: 'Mod-e', run: toggleInlineCode, preventDefault: true },
        { key: 'Mod-Shift-k', run: toggleStrike, preventDefault: true },
        { key: 'Mod-k', run: insertLink(), preventDefault: true },
        { key: 'Mod-1', run: setLineHeading(1), preventDefault: true },
        { key: 'Mod-2', run: setLineHeading(2), preventDefault: true },
        { key: 'Mod-3', run: setLineHeading(3), preventDefault: true },
        { key: 'Mod-4', run: setLineHeading(4), preventDefault: true },
        { key: 'Mod-5', run: setLineHeading(5), preventDefault: true },
        { key: 'Mod-6', run: setLineHeading(6), preventDefault: true },
        { key: 'Mod-0', run: setLineHeading(0), preventDefault: true },
        { key: 'Mod-Shift-7', run: toggleOrderedList, preventDefault: true },
        { key: 'Mod-Shift-8', run: toggleBulletList, preventDefault: true },
        { key: 'Mod-Shift-9', run: toggleTodoList, preventDefault: true },
        { key: 'Mod-Shift-.', run: toggleQuote, preventDefault: true },
        { key: 'Mod-Shift-l', run: cycleListType, preventDefault: true },
        { key: 'Mod-Alt-1', run: foldHeadingsBelowLevel(1), preventDefault: true },
        { key: 'Mod-Alt-2', run: foldHeadingsBelowLevel(2), preventDefault: true },
        { key: 'Mod-Alt-3', run: foldHeadingsBelowLevel(3), preventDefault: true },
        { key: 'Mod-Alt-4', run: foldHeadingsBelowLevel(4), preventDefault: true },
        { key: 'Mod-Alt-5', run: foldHeadingsBelowLevel(5), preventDefault: true },
        { key: 'Mod-Alt-l', run: gotoLine, preventDefault: true },
        { key: 'Mod-f', run: openSearchPanel, preventDefault: true },
        { key: 'Mod-/', run: toggleHtmlComment, preventDefault: true },
        { key: 'Mod-d', run: copyLineDown, preventDefault: true },
        { key: 'Mod-Shift-d', run: deleteLine, preventDefault: true },
        { key: 'Mod-Enter', run: toggleTaskCheckbox, preventDefault: true },
        { key: 'Mod-Shift-[', run: promoteHeading, preventDefault: true },
        { key: 'Mod-Shift-]', run: demoteHeading, preventDefault: true },
        { key: 'Tab', run: tableNextCell },
        { key: 'Tab', run: demoteListItem },
        { key: 'Shift-Tab', run: tablePrevCell },
        { key: 'Shift-Tab', run: promoteListItem },
        { key: 'Alt-ArrowUp', run: moveLineUp, preventDefault: true },
        { key: 'Alt-ArrowDown', run: moveLineDown, preventDefault: true },
        { key: 'Alt-Shift-ArrowUp', run: moveSectionUp, preventDefault: true },
        { key: 'Alt-Shift-ArrowDown', run: moveSectionDown, preventDefault: true },
        { key: 'Mod-Alt-f', run: jumpFootnote, preventDefault: true },
        { key: 'Mod-Alt-ArrowDown', run: jumpToNextHeading, preventDefault: true },
        { key: 'Mod-Alt-ArrowUp', run: jumpToPrevHeading, preventDefault: true },
        { key: 'Escape', run: simplifySelection },
        { key: 'End', run: cursorLineEnd },
        { key: 'Enter', run: insertNewlineContinueMarkup },
      ]),
    ),
  ]
}
