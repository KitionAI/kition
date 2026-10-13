import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTextFile } from '@/services/desktop'
import { useDocumentExport } from './useDocumentExport'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop')>()),
  isDesktopRuntime: vi.fn(() => true),
  saveTextFile: vi.fn(async () => '/exports/plan.md'),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(saveTextFile).mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('useDocumentExport', () => {
  it('exports the live text of the document, not the published text that lags behind typing', async () => {
    const ref: { current: ReturnType<typeof useDocumentExport> } = { current: undefined as never }
    function Wrapper() {
      ref.current = useDocumentExport({
        activeDocument: { path: 'notes/plan.md', name: 'plan.md', content: '# Plan\n' },
        activeDocumentFormat: 'markdown',
        draftContent: '# Plan\n',
        readContent: () => '# Plan\n\nTyped a moment ago.\n',
        onError: vi.fn(),
        onFeedback: vi.fn(),
      })
      return null
    }
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Wrapper))
    })
    await act(async () => {
      await ref.current.exportCurrentDocument()
    })
    expect(saveTextFile).toHaveBeenCalledWith(expect.objectContaining({ content: '# Plan\n\nTyped a moment ago.\n' }))
  })
})
