import { countColumn, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

class BulletWidget extends WidgetType {
  constructor(readonly indent: number) { super() }

  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-md-bullet'
    dot.style.marginInlineStart = `${this.indent}em`
    dot.textContent = '•'
    return dot
  }

  eq(other: BulletWidget) { return other.indent === this.indent }
  ignoreEvent() { return true }
}

export function bulletListDecorations(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const line = state.doc.lineAt(from)
  const prefix = state.doc.sliceString(line.from, from)
  const spaces = /^[ \t]*/.exec(state.doc.sliceString(to, line.to))![0].length
  // Quotes have their own prefix layout; only replace their bullet and spacing.
  if (!/^[ \t]*$/.test(prefix)) {
    return [Decoration.replace({ widget: new BulletWidget(0) }).range(from, to + spaces)]
  }
  const indent = countColumn(prefix, state.tabSize) * 0.25
  return [
    Decoration.line({
      class: 'cm-md-bullet-line',
      attributes: { style: `--cm-list-indent: ${indent}em` },
    }).range(line.from),
    Decoration.replace({ widget: new BulletWidget(indent) }).range(line.from, to + spaces),
  ]
}

export const bulletListTheme = EditorView.baseTheme({
  '.cm-line.cm-md-bullet-line': {
    paddingInlineStart: 'calc(var(--cm-list-indent) + 0.8em)',
    textIndent: 'calc(-1 * (var(--cm-list-indent) + 0.8em))',
  },
  '.cm-md-bullet': {
    display: 'inline-block',
    width: '0.8em',
    textIndent: '0',
    color: 'hsl(var(--muted-foreground) / 0.55)',
    fontWeight: '700',
  },
})
