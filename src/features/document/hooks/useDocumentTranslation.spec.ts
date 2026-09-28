import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationModelMissingError, type DocumentTranslateText } from '@/features/document/lib/documentTranslation'

import { useDocumentTranslation } from './useDocumentTranslation'

type Api = ReturnType<typeof useDocumentTranslation>

const DOC = 'Intro line\n\nFirst sentence here.\nSecond line of the block.\n\nLast paragraph.'

let container: HTMLDivElement
let root: Root | null = null
let view: EditorView | null = null

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(translateText: DocumentTranslateText) {
  let api: Api | null = null
  function Harness() {
    const value = useDocumentTranslation({ getView: () => view, translateText })
    useEffect(() => { api = value })
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [history(), api!.extension] }),
    parent: container,
  })
  return () => api!
}

function selectText(text: string) {
  const from = view!.state.doc.toString().indexOf(text)
  view!.dispatch({ selection: { anchor: from, head: from + text.length } })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  view?.destroy()
  view = null
  await act(async () => { root?.unmount() })
  root = null
  container.remove()
})

describe('useDocumentTranslation', () => {
  it('translates the selection and replaces it in one change', async () => {
    const translate = vi.fn<DocumentTranslateText>(async () => 'Premiere phrase.')
    const read = await mount(translate)
    selectText('First sentence here.')

    act(() => read().open('fr'))
    expect(read().state.status).toBe('loading')
    expect(translate).toHaveBeenCalledWith('First sentence here.', 'fr', expect.any(AbortSignal))
    await flush()
    expect(read().state).toMatchObject({ status: 'ready', result: 'Premiere phrase.', target: 'fr' })
    expect(read().cardElement).not.toBeNull()

    act(() => read().replace())
    expect(view!.state.doc.toString()).toBe('Intro line\n\nPremiere phrase.\nSecond line of the block.\n\nLast paragraph.')
    expect(read().state.status).toBe('closed')
  })

  it('makes Replace its own undo step, separate from typing that follows', async () => {
    const read = await mount(async () => 'Premiere phrase.')
    selectText('First sentence here.')
    act(() => read().open('fr'))
    await flush()
    act(() => read().replace())
    const at = view!.state.selection.main.head
    view!.dispatch({ changes: { from: at, insert: '!' }, userEvent: 'input.type' })
    expect(view!.state.doc.toString()).toContain('Premiere phrase.!')

    undo(view!)
    expect(view!.state.doc.toString()).toContain('Premiere phrase.\nSecond line')
    undo(view!)
    expect(view!.state.doc.toString()).toBe(DOC)
  })

  it('inserts the translation after the block that contains the selection', async () => {
    const read = await mount(async () => 'Traduction.')
    selectText('First sentence here.')
    act(() => read().open('fr'))
    await flush()

    act(() => read().insertBelow())
    expect(view!.state.doc.toString()).toBe('Intro line\n\nFirst sentence here.\nSecond line of the block.\n\nTraduction.\n\nLast paragraph.')
  })

  it('marks the result stale when the selected text is edited, but not for edits elsewhere', async () => {
    const read = await mount(async () => 'Traduction.')
    selectText('First sentence here.')
    act(() => read().open('fr'))
    await flush()

    act(() => { view!.dispatch({ changes: { from: 0, insert: 'New ' } }) })
    expect(read().state).toMatchObject({ status: 'ready', stale: false })

    act(() => read().replace())
    expect(view!.state.doc.toString()).toContain('New Intro line\n\nTraduction.\nSecond line')
  })

  it('refuses to replace after the source range was edited', async () => {
    const read = await mount(async () => 'Traduction.')
    selectText('First sentence here.')
    act(() => read().open('fr'))
    await flush()

    const at = view!.state.doc.toString().indexOf('sentence')
    act(() => { view!.dispatch({ changes: { from: at, insert: 'long ' } }) })
    expect(read().state).toMatchObject({ stale: true })
    const before = view!.state.doc.toString()
    act(() => read().replace())
    expect(view!.state.doc.toString()).toBe(before)
  })

  it('reports a missing model as a typed error state', async () => {
    const read = await mount(async () => { throw new TranslationModelMissingError() })
    selectText('Last paragraph.')
    act(() => read().open('de'))
    await flush()
    expect(read().state).toMatchObject({ status: 'error', error: 'model' })
  })

  it('aborts the request on close and ignores its late answer', async () => {
    let signal: AbortSignal | null = null
    let resolve: (value: string) => void = () => {}
    const read = await mount((_text, _target, s) => {
      signal = s
      return new Promise((r) => { resolve = r })
    })
    selectText('Last paragraph.')
    act(() => read().open('de'))
    act(() => read().close())
    expect(signal!.aborted).toBe(true)
    resolve('Zu spaet')
    await flush()
    expect(read().state.status).toBe('closed')
  })
})
