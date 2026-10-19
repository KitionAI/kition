import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, Decoration } from '@codemirror/view'

import { wikilinkExtension } from './wikilink'
import type { WikilinkParsed } from '../../lib/wikilink-parser'

function makeView(doc: string, cursor = 0, opts: Parameters<typeof wikilinkExtension>[0] = {}) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  // Clamp cursor to valid doc range (plan used 99 as shorthand for "end of doc / outside")
  const anchor = Math.min(cursor, doc.length)
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [wikilinkExtension(opts)],
  })
  return new EditorView({ state, parent })
}

function collectDecorations(view: EditorView): { from: number; to: number; spec: any }[] {
  const out: { from: number; to: number; spec: any }[] = []
  const plugin = view.plugin(view.state.facet(EditorView.decorations).length
    ? (view.state.facet(EditorView.decorations)[0] as any)
    : (null as any))
  for (const f of view.state.facet(EditorView.decorations)) {
    const set = typeof f === 'function' ? f(view) : f
    if (!set) continue
    const iter = (set as any).iter()
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to, spec: iter.value.spec })
      iter.next()
    }
  }
  return out
}

describe('wikilinkExtension decorations', () => {
  it('replaces [[Target]] with chip widget when cursor is outside', () => {
    const view = makeView('text [[Target]] more', 0)
    const decos = collectDecorations(view)
    const replace = decos.find((d) => d.spec.widget && d.from === 5 && d.to === 15)
    expect(replace, 'should produce a Decoration.replace for [[Target]]').toBeTruthy()
    view.destroy()
  })

  it('does NOT replace when cursor sits inside the wikilink', () => {
    const view = makeView('text [[Target]] more', 8 /* inside Target */)
    const decos = collectDecorations(view)
    const replace = decos.find((d) => d.spec.widget && d.from === 5 && d.to === 15)
    expect(replace, 'should NOT produce a Decoration.replace when cursor is inside').toBeFalsy()
    view.destroy()
  })

  it('marks broken links with is-unresolved class', () => {
    const view = makeView('[[Missing]]', 99 /* end of doc — outside */, {
      resolve: () => false,
    })
    const html = view.dom.innerHTML
    expect(html).toContain('is-unresolved')
    view.destroy()
  })

  it('skips embed `![[…]]` (defers to embed extension)', () => {
    const view = makeView('![[X]]', 99)
    const decos = collectDecorations(view)
    const replace = decos.find((d) => d.spec.widget)
    expect(replace).toBeFalsy()
    view.destroy()
  })

  it('uses display alias when given', () => {
    const view = makeView('[[A|Alias]]', 99)
    const text = view.dom.querySelector('.cm-underline')?.textContent
    expect(text).toBe('Alias')
    view.destroy()
  })

  it('appends ` › Heading` to display when section given', () => {
    const view = makeView('[[A#H]]', 99)
    const text = view.dom.querySelector('.cm-underline')?.textContent
    expect(text).toBe('A › H')
    view.destroy()
  })

  it('falls back to Decoration.mark on heading lines (no replace)', () => {
    const view = makeView('# Title [[A]] more', 99)
    const decos = collectDecorations(view)
    const replace = decos.find((d) => d.spec.widget)
    expect(replace, 'should not produce replace widget inside heading').toBeFalsy()
    view.destroy()
  })

  it('passes display alias through mousedown navigation', () => {
    let received: WikilinkParsed | undefined
    const view = makeView('[[A|Alias]]', 99, {
      resolve: () => true,
      onNavigate: (link) => {
        received = link
      },
    })
    const widget = view.dom.querySelector('.cm-hmd-internal-link') as HTMLElement
    expect(widget).toBeTruthy()
    widget.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
    expect(received?.display).toBe('Alias')
    view.destroy()
  })
})
