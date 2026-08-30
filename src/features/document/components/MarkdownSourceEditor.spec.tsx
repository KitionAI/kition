import type { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownSourceEditor } from './MarkdownSourceEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('MarkdownSourceEditor cursor context', () => {
  it('publishes the current Markdown and cursor offset on selection changes', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const onCursorChange = vi.fn()
    let view: EditorView | null = null

    await act(async () => {
      root = createRoot(container!)
      root.render(createElement(MarkdownSourceEditor, {
        value: 'A\n\nB',
        readOnly: false,
        onChange: vi.fn(),
        onCursorChange,
        onCreateEditor: (nextView) => {
          view = nextView
        },
      }))
      await Promise.resolve()
    })

    expect(onCursorChange).toHaveBeenCalledWith({ markdown: 'A\n\nB', cursorOffset: 0 })

    await act(async () => {
      view!.dispatch({ selection: { anchor: 2 } })
    })

    expect(onCursorChange).toHaveBeenLastCalledWith({ markdown: 'A\n\nB', cursorOffset: 2 })
  })
})
