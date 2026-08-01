import type { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentEditor } from './DocumentEditor'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HAN_ZHONG = String.fromCodePoint(0x4e2d)
const HAN_WEN = String.fromCodePoint(0x6587)

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderEditor(value: string, onChange: (nextValue: string) => void, onCreateEditor?: (view: EditorView) => void) {
  await act(async () => {
    root ??= createRoot(container!)
    root.render(createElement(DocumentEditor, { value, onChange, onCreateEditor }))
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('DocumentEditor IME input', () => {
  it('keeps the composed text and selection when a delayed controlled value arrives', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    const initialValue = 'First line\nSecond line'
    const latinComposition = `${initialValue}z`
    const intermediateValue = `${initialValue}${HAN_ZHONG}`
    const finalValue = `${intermediateValue}${HAN_WEN}`
    const onChange = vi.fn<(nextValue: string) => void>()
    let view: EditorView | null = null

    await renderEditor(initialValue, onChange, (nextView) => {
      view = nextView
    })

    expect(view).not.toBeNull()
    const editorView = view!
    editorView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
      data: 'z',
    }))

    await act(async () => {
      editorView.dispatch({
        changes: { from: initialValue.length, insert: 'z' },
        selection: { anchor: latinComposition.length },
      })
    })
    await renderEditor(latinComposition, onChange)

    await act(async () => {
      editorView.dispatch({
        changes: {
          from: initialValue.length,
          to: latinComposition.length,
          insert: HAN_ZHONG,
        },
        selection: { anchor: intermediateValue.length },
      })
      editorView.dispatch({
        changes: { from: intermediateValue.length, insert: HAN_WEN },
        selection: { anchor: finalValue.length },
      })
      editorView.contentDOM.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: `${HAN_ZHONG}${HAN_WEN}`,
      }))
    })

    await renderEditor(intermediateValue, onChange)
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    })

    expect(editorView.state.doc.toString()).toBe(finalValue)
    expect(editorView.state.selection.main.head).toBe(finalValue.length)
    expect(onChange).toHaveBeenLastCalledWith(finalValue)

    await renderEditor(finalValue, onChange)
    await renderEditor('External replacement', onChange)
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    })
    expect(editorView.state.doc.toString()).toBe('External replacement')
  })
})
