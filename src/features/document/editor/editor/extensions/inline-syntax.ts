   
                                                 
                                 
   

import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'

const HIGHLIGHT_RE = /==([^=\n]+)==/g
const COMMENT_RE = /%%([\s\S]+?)%%/g
const BLOCK_ID_RE = /(?<=^|\s)\^([A-Za-z0-9_-]+)(?=\s|$)/gm

const highlightMark = Decoration.mark({ class: 'cm-document-highlight' })
const commentMark = Decoration.mark({ class: 'cm-document-comment' })
const blockIdMark = Decoration.mark({ class: 'cm-document-block-id' })

function buildFromRegex(view: EditorView, re: RegExp, deco: Decoration, builder: RangeSetBuilder<Decoration>) {
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      builder.add(from + match.index, from + match.index + match[0].length, deco)
    }
  }
}

function makeRegexPlugin(re: RegExp, deco: Decoration): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
      }
      private build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        buildFromRegex(view, re, deco, builder)
        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations },
  )
}

export const highlightExtension = (): Extension => [
  makeRegexPlugin(HIGHLIGHT_RE, highlightMark),
  EditorView.theme({
    '.cm-document-highlight': {
      backgroundColor: 'hsl(50 95% 60% / 0.35)',
      borderRadius: '2px',
      padding: '0 2px',
    },
  }),
]

export const commentExtension = (): Extension => [
  makeRegexPlugin(COMMENT_RE, commentMark),
  EditorView.theme({
    '.cm-document-comment': {
      color: 'hsl(var(--muted-foreground, 215 15% 55%))',
      backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.4)',
      fontStyle: 'italic',
    },
  }),
]

export const blockIdExtension = (): Extension => [
  makeRegexPlugin(BLOCK_ID_RE, blockIdMark),
  EditorView.theme({
    '.cm-document-block-id': {
      color: 'hsl(var(--muted-foreground, 215 15% 55%))',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      fontSize: '0.85em',
    },
  }),
]
