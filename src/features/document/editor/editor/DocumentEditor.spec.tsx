import type { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReplicaTextSource, type DocumentTextSource } from '@/features/document/kdm/documentTextSource'
import { undoDocument } from '@/features/document/kdm/documentHistory'
import { DocumentEditor, type DocumentEditorProps } from './DocumentEditor'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HAN_ZHONG = String.fromCodePoint(0x4e2d)
const HAN_WEN = String.fromCodePoint(0x6587)

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderEditor(
  source: DocumentTextSource,
  onCreateEditor?: (view: EditorView) => void,
  props: Partial<DocumentEditorProps> = {},
) {
  await act(async () => {
    root ??= createRoot(container!)
    root.render(createElement(DocumentEditor, { ...props, source, onCreateEditor }))
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('DocumentEditor on a document replica', () => {
  it('publishes an IME composition’s edits and shows a replica change after it ends', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    const initialValue = 'First line\nSecond line'
    const latinComposition = `${initialValue}z`
    const intermediateValue = `${initialValue}${HAN_ZHONG}`
    const finalValue = `${intermediateValue}${HAN_WEN}`
    const source = createReplicaTextSource(initialValue)
    let view: EditorView | null = null

    await renderEditor(source, (nextView) => {
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
        userEvent: 'input.type.compose',
      })
    })
    expect(source.text()).toBe(latinComposition)
    // A parent render while composing changes nothing: the editor is not driven by a value.
    await renderEditor(source)

    await act(async () => {
      editorView.dispatch({
        changes: { from: initialValue.length, to: latinComposition.length, insert: HAN_ZHONG },
        selection: { anchor: intermediateValue.length },
        userEvent: 'input.type.compose',
      })
      editorView.dispatch({
        changes: { from: intermediateValue.length, insert: HAN_WEN },
        selection: { anchor: finalValue.length },
        userEvent: 'input.type.compose',
      })
      editorView.contentDOM.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: `${HAN_ZHONG}${HAN_WEN}`,
      }))
    })

    await vi.waitFor(() => {
      expect(editorView.state.doc.toString()).toBe(finalValue)
      expect(editorView.state.selection.main.head).toBe(finalValue.length)
      expect(source.text()).toBe(finalValue)
    }, { timeout: 3000 })

    // A whole-text setter (a dialog, an import) reaches the editor as a minimal change.
    await act(async () => {
      source.replaceText('External replacement', { kind: 'person', principal: 'user:local', label: 'import' })
    })
    await vi.waitFor(() => {
      expect(editorView.state.doc.toString()).toBe('External replacement')
    }, { timeout: 3000 })
  })

  it('undoes with the replica’s history, which survives a remount', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const source = createReplicaTextSource('Draft')
    let view: EditorView | null = null
    await renderEditor(source, (nextView) => {
      view = nextView
    })
    await act(async () => {
      view!.dispatch({ changes: { from: 5, insert: ' one' }, userEvent: 'input.type' })
    })
    expect(source.text()).toBe('Draft one')
    await act(async () => root?.unmount())
    root = null
    await renderEditor(source, (nextView) => {
      view = nextView
    })
    expect(view!.state.doc.toString()).toBe('Draft one')
    await act(async () => {
      expect(undoDocument(view!)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(source.text()).toBe('Draft')
    expect(view!.state.doc.toString()).toBe('Draft')
  })
})

describe('DocumentEditor publishing copy', () => {
  it('lets the document pane replace native copy with Markdown and HTML clipboard data', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const source = '# Heading\n\nFirst paragraph.\n\nSecond **bold** paragraph.'
    const onCopySelection = vi.fn((_markdown: string, clipboardData: DataTransfer | null) => {
      clipboardData?.setData('text/html', '<article><h1>Heading</h1></article>')
      return true
    })
    let view: EditorView | null = null

    await renderEditor(createReplicaTextSource(source), (nextView) => {
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

    expect(onCopySelection).toHaveBeenCalledWith(source, (copyEvent as ClipboardEvent).clipboardData)
    expect(copyEvent.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/html', '<article><h1>Heading</h1></article>')
    expect(setData).toHaveBeenCalledWith('text/plain', source)
    expect(setData).toHaveBeenCalledWith('text/markdown', source)
  })

  it('keeps a read-only document focusable so Mod-A selects the whole document', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const source = '# Heading\n\nParagraph with **formatting**.'
    let view: EditorView | null = null

    await renderEditor(createReplicaTextSource(source), (nextView) => {
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
