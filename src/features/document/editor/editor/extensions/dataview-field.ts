   
                       
  
                                                        
                        
  
      
                                            
                                                             
   

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'

const FIELD_RE = /^(\s*(?:[-*+]\s+|>\s*)*)([A-Za-z][\w-]*?)(::)(\s*)(.*)$/

const keyMark = Decoration.mark({ class: 'cm-dataview-field-key' })
const sepMark = Decoration.mark({ class: 'cm-dataview-field-sep' })
const valMark = Decoration.mark({ class: 'cm-dataview-field-val' })

function isInsideFence(view: EditorView, lineNo: number): boolean {
  // O(N) scan up to lineNo — kept simple; viewports are small
  const doc = view.state.doc
  let inside = false
  for (let i = 1; i < lineNo; i++) {
    const text = doc.line(i).text
    if (/^\s*```/.test(text)) inside = !inside
  }
  return inside
}

export function dataviewFieldExtension(): Extension {
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
        const doc = view.state.doc
        for (const { from, to } of view.visibleRanges) {
          const startLine = doc.lineAt(from)
          const endLine = doc.lineAt(to)
          for (let i = startLine.number; i <= endLine.number; i++) {
            const line = doc.line(i)
            if (isInsideFence(view, i)) continue
            const m = FIELD_RE.exec(line.text)
            if (!m) continue
            const prefix = m[1]
            const key = m[2]
            const sep = m[3]
            const space = m[4]
            const val = m[5]
            // skip if value is empty (still typing) — be lenient
            const keyFrom = line.from + prefix.length
            const keyTo = keyFrom + key.length
            const sepFrom = keyTo
            const sepTo = sepFrom + sep.length
            const valFrom = sepTo + space.length
            const valTo = valFrom + val.length
            builder.add(keyFrom, keyTo, keyMark)
            builder.add(sepFrom, sepTo, sepMark)
            if (val.length > 0) {
              builder.add(valFrom, valTo, valMark)
            }
          }
        }
        return builder.finish()
      }
    },
    { decorations: (v) => v.decorations },
  )

  return [plugin, theme]
}

const theme = EditorView.theme({
  '.cm-dataview-field-key': {
    color: 'hsl(var(--primary, 280 70% 55%))',
    fontWeight: '600',
  },
  '.cm-dataview-field-sep': {
    color: 'hsl(var(--muted-foreground, 0 0% 60%))',
    opacity: '0.6',
  },
  '.cm-dataview-field-val': {
    color: 'hsl(var(--foreground, 0 0% 20%))',
    fontStyle: 'italic',
  },
})
