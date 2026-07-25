import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useWorkspaceDerivedState } from './useWorkspaceDerivedState'
import type { EditorMode } from './useWorkspaceChrome'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function DerivedStateProbe({ editorMode }: { editorMode: EditorMode }) {
  const state = useWorkspaceDerivedState({
    activeDocument: {
      path: 'notes/example.md',
      name: 'example.md',
      content: '# Example',
      format: 'markdown',
    },
    activeDocumentFormat: 'markdown',
    draftContent: '# Example',
    editorLocked: false,
    editorMode,
    files: [],
    itemMenuOpen: false,
  })

  return createElement('output', { 'data-testid': 'preview-html' }, state.editorPreviewHtml)
}

describe('useWorkspaceDerivedState', () => {
  it('renders Markdown only when preview output is needed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(DerivedStateProbe, { editorMode: 'rich' }))
    })
    expect(container.querySelector('output')?.textContent).toBe('')

    await act(async () => {
      root.render(createElement(DerivedStateProbe, { editorMode: 'preview' }))
      await import('@/services/markdownRenderer')
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(container.querySelector('output')?.textContent).toContain('<h1>Example</h1>')

    await act(async () => root.unmount())
    container.remove()
  })
})
