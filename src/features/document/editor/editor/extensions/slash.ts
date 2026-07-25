   
                                       
  
                                                         
                                                                                 
                                          
                                    
   

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorState, Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import i18next from 'i18next'

import {
  insertCallout,
  insertCodeBlock,
  insertComment,
  insertDate,
  insertFootnote,
  insertHighlight,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertTOC,
  insertTable,
  insertTimestamp,
  setLineHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleQuote,
  toggleTodoList,
  wrapAsWikilink,
} from '../commands'
import {
  type SuggestProviders,
  tagCompletionSource,
  wikilinkCompletionSource,
} from './suggest'

type SlashCommand = {
  /** i18next key under document:slash.commands.<key> and document:slash.details.<key> */
  key: string
             
  order: number
                       
  apply: (view: EditorView) => void
}

const SLASH_COMMANDS: SlashCommand[] = [
  { key: 'h1Heading', order: 1, apply: (view) => { setLineHeading(1)(view) } },
  { key: 'h2Heading', order: 2, apply: (view) => { setLineHeading(2)(view) } },
  { key: 'h3Heading', order: 3, apply: (view) => { setLineHeading(3)(view) } },
  { key: 'bulletList', order: 10, apply: (view) => { toggleBulletList(view) } },
  { key: 'orderedList', order: 11, apply: (view) => { toggleOrderedList(view) } },
  { key: 'todoList', order: 12, apply: (view) => { toggleTodoList(view) } },
  { key: 'quote', order: 13, apply: (view) => { toggleQuote(view) } },
  { key: 'codeBlock', order: 20, apply: (view) => { insertCodeBlock()(view) } },
  { key: 'mermaidDiagram', order: 21, apply: (view) => { insertCodeBlock('mermaid')(view) } },
  { key: 'table3x3', order: 22, apply: (view) => { insertTable(3, 3)(view) } },
  { key: 'link', order: 30, apply: (view) => { insertLink()(view) } },
  { key: 'image', order: 31, apply: (view) => { insertImage()(view) } },
  { key: 'calloutNote', order: 40, apply: (view) => { insertCallout('note')(view) } },
  { key: 'calloutInfo', order: 41, apply: (view) => { insertCallout('info')(view) } },
  { key: 'calloutWarning', order: 42, apply: (view) => { insertCallout('warning')(view) } },
  { key: 'calloutTip', order: 43, apply: (view) => { insertCallout('tip')(view) } },
  { key: 'calloutSuccess', order: 44, apply: (view) => { insertCallout('success')(view) } },
  { key: 'calloutDanger', order: 45, apply: (view) => { insertCallout('danger')(view) } },
  {
    key: 'divider',
    order: 50,
    apply: (view) => {
      view.dispatch(view.state.replaceSelection('\n---\n'))
    },
  },
  {
    key: 'inlineMath',
    order: 60,
    apply: (view) => {
      view.dispatch(view.state.replaceSelection('$$'))
      const head = view.state.selection.main.head
      view.dispatch({ selection: { anchor: head - 1 } })
    },
  },
  {
    key: 'mathBlock',
    order: 61,
    apply: (view) => {
      view.dispatch(view.state.replaceSelection('\n$$\n\n$$\n'))
    },
  },
  { key: 'footnote', order: 70, apply: (view) => { insertFootnote(view) } },
  { key: 'highlight', order: 71, apply: (view) => { insertHighlight()(view) } },
  { key: 'comment', order: 72, apply: (view) => { insertComment()(view) } },
  { key: 'toc', order: 73, apply: (view) => { insertTOC()(view) } },
  { key: 'horizontalRule', order: 74, apply: (view) => { insertHorizontalRule()(view) } },
  { key: 'date', order: 80, apply: (view) => { insertDate()(view) } },
  { key: 'timestamp', order: 81, apply: (view) => { insertTimestamp()(view) } },
  { key: 'wikilink', order: 90, apply: (view) => { wrapAsWikilink(view) } },
]

function findSlashTrigger(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const m = /(^|\s)\/([\p{L}\p{N}_-]*)$/u.exec(before)
  if (!m) return null
  const startInLine = (m.index ?? 0) + m[1].length
  return { from: line.from + startInLine, query: m[2] }
}

function slashSource(context: CompletionContext): CompletionResult | null {
  const trigger = findSlashTrigger(context.state, context.pos)
  if (!trigger) return null
  if (!context.explicit && trigger.from === context.pos) return null
  const query = trigger.query.toLowerCase()
  const t = i18next.getFixedT(null, 'document')
  const resolved = SLASH_COMMANDS.map((cmd) => ({
    cmd,
    label: t(`slash.commands.${cmd.key}`),
    detail: t(`slash.details.${cmd.key}`),
  }))
  const options: Completion[] = resolved
    .filter((c) => !query || c.label.toLowerCase().includes(query) || c.detail.toLowerCase().includes(query))
    .sort((a, b) => a.cmd.order - b.cmd.order)
    .map(({ cmd, label, detail }) => ({
      label,
      detail,
      type: 'keyword',
      boost: -cmd.order,
      apply: (view, _completion, from, to) => {
        view.dispatch({ changes: { from, to, insert: '' } })
        cmd.apply(view)
      },
    }))
  return {
    from: trigger.from,
    options,
    validFor: /^\/[\p{L}\p{N}_-]*$/u,
  }
}

export function slashCommandExtension(providers: SuggestProviders = {}): Extension {
  const sources: CompletionSource[] = [slashSource]
  if (providers.wikilinks || providers.headingsOf || providers.blockIdsOf) {
    sources.push(wikilinkCompletionSource(providers))
  }
  if (providers.tags) sources.push(tagCompletionSource(providers.tags))
  return autocompletion({
    override: sources,
    activateOnTyping: true,
    closeOnBlur: true,
    icons: false,
    aboveCursor: false,
    defaultKeymap: true,
  })
}
