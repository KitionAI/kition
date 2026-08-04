import type { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentEditor, type DocumentEditorProps } from './DocumentEditor'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HAN_ZHONG = String.fromCodePoint(0x4e2d)
const HAN_WEN = String.fromCodePoint(0x6587)

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderEditor(
  value: string,
  onChange: (nextValue: string) => void,
  onCreateEditor?: (view: EditorView) => void,
  props: Partial<DocumentEditorProps> = {},
) {
  await act(async () => {
    root ??= createRoot(container!)
    root.render(createElement(DocumentEditor, { ...props, value, onChange, onCreateEditor }))
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
    await vi.waitFor(() => {
      expect(editorView.state.doc.toString()).toBe(finalValue)
      expect(editorView.state.selection.main.head).toBe(finalValue.length)
      expect(onChange).toHaveBeenLastCalledWith(finalValue)
    }, {
      timeout: 3000,
    })

    await renderEditor(finalValue, onChange)
    await renderEditor('External replacement', onChange)
    await vi.waitFor(() => {
      expect(editorView.state.doc.toString()).toBe('External replacement')
    }, {
      timeout: 3000,
    })
  })
})

describe('DocumentEditor publishing copy', () => {
  it('lets the document pane replace native copy for image selections', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const source = 'Before\n\n![Generated](<Agent/images/example.png>)\n\nAfter'
    const onCopySelection = vi.fn(() => true)
    let view: EditorView | null = null

    await renderEditor(source, vi.fn(), (nextView) => {
      view = nextView
    }, { onCopySelection })

    const editorView = view!
    await act(async () => {
      editorView.dispatch({ selection: { anchor: 0, head: source.length } })
    })
    const setData = vi.fn()
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copyEvent, 'clipboardData', {
      configurable: true,
      value: { setData },
    })

    editorView.contentDOM.dispatchEvent(copyEvent)

    expect(onCopySelection).toHaveBeenCalledWith(source)
    expect(copyEvent.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/plain', source)
  })

  it('keeps a read-only document focusable so Mod-A selects the whole document', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const source = '# Heading\n\nParagraph with **formatting**.'
    let view: EditorView | null = null

    await renderEditor(source, vi.fn(), (nextView) => {
      view = nextView
    }, {
      readOnly: true,
      revealSourceOnFocus: false,
      drawSelection: false,
    })

    const editorView = view!
    expect(editorView.state.readOnly).toBe(true)
    expect(editorView.contentDOM.getAttribute('contenteditable')).toBe('true')
    expect(editorView.dom.querySelector('.cm-selectionLayer')).toBeNull()
    editorView.focus()

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      editorView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
        ...modifier,
      }))
    }

    expect(editorView.state.selection.main.from).toBe(0)
    expect(editorView.state.selection.main.to).toBe(source.length)
  })
})
