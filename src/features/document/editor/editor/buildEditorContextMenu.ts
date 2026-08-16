import { selectAll } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import i18next from 'i18next'
import type { DocumentAgentActionRequest } from '@/features/document/lib/documentAgentActions'
import { Menu } from '../menu'
import {
  toggleBold,
  toggleItalic,
  toggleStrike,
  toggleInlineCode,
  insertHighlight,
  insertComment,
  clearFormatting,
  setLineHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTodoList,
  toggleQuote,
  insertCodeBlock,
  insertMathBlock,
  insertTable,
  insertFootnote,
  insertHorizontalRule,
  insertLink,
  insertWikilink,
} from './commands'

export function buildEditorContextMenu(
  view: EditorView,
  options: { onAskAgent?: (request: DocumentAgentActionRequest) => void } = {},
): Menu {
  const menu = new Menu()
  const t = i18next.getFixedT(null, 'document')

  // insertWikilink and insertLink are curried factories: (args?) => Command
  menu.addItem((i) => i.setTitle(t('editor.contextMenu.addLink')).setIcon('link').onSelect(() => insertWikilink()(view)))
  menu.addItem((i) => i.setTitle(t('editor.contextMenu.addExternalLink')).setIcon('external-link').onSelect(() => insertLink()(view)))
  menu.addSeparator()

  menu.addItem((i) => {
    i.setTitle(t('editor.contextMenu.textFormat')).setIcon('type')
    const sub = i.setSubmenu()
    // toggleBold/toggleItalic/toggleStrike/toggleInlineCode are direct Commands
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.bold')).setIcon('bold').setShortcut('⌘B').onSelect(() => toggleBold(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.italic')).setIcon('italic').setShortcut('⌘I').onSelect(() => toggleItalic(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.strikethrough')).setIcon('strikethrough').onSelect(() => toggleStrike(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.inlineCode')).setIcon('code').setShortcut('⌘E').onSelect(() => toggleInlineCode(view)))
    // insertHighlight and insertComment are zero-arg factories: () => Command
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.highlight')).setIcon('highlighter').onSelect(() => insertHighlight()(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.comment')).setIcon('message-square').onSelect(() => insertComment()(view)))
    sub.addSeparator()
    // clearFormatting is a direct Command
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.clearFormat')).setIcon('eraser').onSelect(() => clearFormatting(view)))
  })

  menu.addItem((i) => {
    i.setTitle(t('editor.contextMenu.paragraphSettings')).setIcon('pilcrow')
    const sub = i.setSubmenu()
    // setLineHeading is (level) => Command
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.body')).setIcon('text').setShortcut('⌘0').onSelect(() => setLineHeading(0)(view)))
    for (const lvl of [1, 2, 3, 4, 5, 6] as const) {
      sub.addItem((s) =>
        s
          .setTitle(t('editor.contextMenu.headingLevel', { level: lvl }))
          .setIcon(`heading-${lvl}`)
          .setShortcut(`⌘${lvl}`)
          .onSelect(() => setLineHeading(lvl)(view)),
      )
    }
    sub.addSeparator()
    // toggleBulletList/toggleOrderedList/toggleTodoList/toggleQuote are direct Commands
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.bulletList')).setIcon('list').onSelect(() => toggleBulletList(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.orderedList')).setIcon('list-ordered').onSelect(() => toggleOrderedList(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.taskList')).setIcon('list-checks').onSelect(() => toggleTodoList(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.quote')).setIcon('quote').onSelect(() => toggleQuote(view)))
  })

  menu.addItem((i) => {
    i.setTitle(t('editor.contextMenu.insert')).setIcon('plus')
    const sub = i.setSubmenu()
    // insertCodeBlock/insertMathBlock/insertTable/insertHorizontalRule are factories
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.codeBlock')).setIcon('code-2').onSelect(() => insertCodeBlock()(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.mathBlock')).setIcon('sigma').onSelect(() => insertMathBlock()(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.table')).setIcon('table').onSelect(() => insertTable()(view)))
    // insertFootnote is a direct Command
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.footnote')).setIcon('footnote').onSelect(() => insertFootnote(view)))
    sub.addItem((s) => s.setTitle(t('editor.contextMenu.divider')).setIcon('minus').onSelect(() => insertHorizontalRule()(view)))
  })

  if (options.onAskAgent) {
    const selection = readAgentSelection(view)
    menu.addItem((i) => {
      i.setTitle(t('editor.contextMenu.askAi')).setIcon('sparkles')
      const sub = i.setSubmenu()
      sub.addItem((s) => s
        .setTitle(selection ? t('editor.contextMenu.askAiCustomSelection') : t('editor.contextMenu.askAiCurrentDocument'))
        .setIcon('sparkles')
        .onSelect(() => options.onAskAgent?.({ action: 'custom', selection })))
      sub.addItem((s) => s
        .setTitle(t('editor.contextMenu.askAiImprove'))
        .setIcon('wand')
        .setDisabled(!selection)
        .onSelect(() => options.onAskAgent?.({ action: 'improve', selection })))
      sub.addItem((s) => s
        .setTitle(t('editor.contextMenu.askAiShorten'))
        .setIcon('minimize')
        .setDisabled(!selection)
        .onSelect(() => options.onAskAgent?.({ action: 'shorten', selection })))
      sub.addItem((s) => s
        .setTitle(t('editor.contextMenu.askAiExpand'))
        .setIcon('maximize')
        .setDisabled(!selection)
        .onSelect(() => options.onAskAgent?.({ action: 'expand', selection })))
    })
  }

  menu.addSeparator()

  const sel = view.state.selection.main
  const hasSelection = !sel.empty
  const selectedText = view.state.doc.sliceString(sel.from, sel.to)

  async function pasteText(plain: boolean): Promise<void> {
    const text = await navigator.clipboard.readText()
    const insert = plain ? text.replace(/\r\n/g, '\n') : text
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
    })
    view.focus()
  }

  menu.addItem((i) =>
    i.setTitle(t('editor.contextMenu.cut')).setIcon('scissors').setShortcut('⌘X').setDisabled(!hasSelection).onSelect(() => {
      void navigator.clipboard.writeText(selectedText)
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
      view.focus()
    }),
  )
  menu.addItem((i) =>
    i.setTitle(t('editor.contextMenu.copy')).setIcon('copy').setShortcut('⌘C').setDisabled(!hasSelection).onSelect(() => {
      void navigator.clipboard.writeText(selectedText)
    }),
  )
  menu.addItem((i) =>
    i.setTitle(t('editor.contextMenu.paste')).setIcon('clipboard').setShortcut('⌘V').onSelect(() => pasteText(false)),
  )
  menu.addItem((i) =>
    i
      .setTitle(t('editor.contextMenu.pastePlain'))
      .setIcon('clipboard-paste')
      .setShortcut('⌘⇧V')
      .onSelect(() => pasteText(true)),
  )
  menu.addItem((i) =>
    i.setTitle(t('editor.contextMenu.selectAll')).setIcon('text-cursor').setShortcut('⌘A').onSelect(() => {
      selectAll(view)
    }),
  )

  return menu
}

function readAgentSelection(view: EditorView) {
  const selection = view.state.selection.main
  if (selection.empty) return null
  const text = view.state.doc.sliceString(selection.from, selection.to).trim()
  if (!text) return null
  return {
    text,
    from: selection.from,
    to: selection.to,
    line: view.state.doc.lineAt(selection.from).number,
  }
}
