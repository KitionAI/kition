   
                     
                       
   

import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { parseTags, type TagParsed } from '../../lib/tag-parser'

export type TagNavigate = (tag: TagParsed) => void

export type TagExtensionOptions = {
  onNavigate?: TagNavigate
}

const tagMark = Decoration.mark({ class: 'cm-document-tag' })

export function tagExtension(options: TagExtensionOptions = {}): Extension {
  const { onNavigate } = options

  const plugin = ViewPlugin.fromClass(
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
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to)
          for (const tag of parseTags(text)) {
            builder.add(from + tag.from, from + tag.to, tagMark)
          }
        }
        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations },
  )

  const click = EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!onNavigate) return false
      const target = event.target as HTMLElement | null
      if (!target?.classList.contains('cm-document-tag')) return false
      if (!(event.metaKey || event.ctrlKey)) return false

      const pos = view.posAtDOM(target)
      if (pos == null) return false
      const line = view.state.doc.lineAt(pos)
      const localOffset = pos - line.from
      const tag = parseTags(line.text).find((t) => localOffset >= t.from && localOffset <= t.to)
      if (!tag) return false
      event.preventDefault()
      onNavigate(tag)
      return true
    },
  })

  return [plugin, click, tagTheme]
}

const tagTheme = EditorView.theme({
  '.cm-document-tag': {
    color: 'hsl(var(--primary, 215 85% 55%))',
    backgroundColor: 'hsl(var(--accent, 215 85% 55%) / 0.12)',
    borderRadius: '999px',
    padding: '0 6px',
    fontSize: '0.92em',
    cursor: 'pointer',
  },
})
