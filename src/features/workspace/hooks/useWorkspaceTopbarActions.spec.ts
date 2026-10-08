import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceTopbarActions } from './useWorkspaceTopbarActions'

const openFile = vi.hoisted(() => vi.fn())
vi.mock('@/services/desktop', () => ({ isDesktopRuntime: () => true, openWorkspaceFile: openFile }))
let root: Root | undefined
let container: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

function renderActions(save: () => Promise<boolean>, hasPendingRevision = false) {
  const error = vi.fn()
  let actions: ReturnType<typeof useWorkspaceTopbarActions>
  function Wrapper() {
    actions = useWorkspaceTopbarActions({
      activeDocument: { path: 'draft.md', name: 'draft.md', content: 'Saved', format: 'markdown' },
      activeDocumentFormat: 'markdown', ensureActiveDocumentSaved: save, hasPendingRevision,
      applyWorkspaceDocument: vi.fn(), bumpEditorReset: vi.fn(), editorLocked: false,
      setDraftContent: vi.fn(), setEditorView: vi.fn(), setError: error, setFeedback: vi.fn(),
      setItemMenuOpen: vi.fn(), importInputRef: { current: null },
    })
    return null
  }
  container = document.createElement('div')
  document.body.append(container)
  act(() => { root = createRoot(container); root.render(createElement(Wrapper)) })
  return { get actions() { return actions! }, error }
}

describe('open Markdown with the system application', () => {
  it('waits for saving before opening and suppresses duplicate clicks', async () => {
    let finish!: (saved: boolean) => void
    const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const view = renderActions(save)
    let pending!: Promise<void>
    act(() => { pending = view.actions.openDocumentInSystem() })
    expect(openFile).not.toHaveBeenCalled()
    expect(view.actions.openingInSystem).toBe(true)
    await act(async () => { await view.actions.openDocumentInSystem(); finish(true); await pending })
    expect(save).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith('draft.md')
    expect(view.actions.openingInSystem).toBe(false)
  })

  it('does not open stale content after saving fails', async () => {
    const view = renderActions(async () => false)
    await act(async () => { await view.actions.openDocumentInSystem() })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('reports a failed system launch', async () => {
    openFile.mockRejectedValueOnce(new Error('No associated application'))
    const view = renderActions(async () => true)
    await act(async () => { await view.actions.openDocumentInSystem() })
    expect(view.error).toHaveBeenCalledWith(expect.stringContaining('default app'))
  })

  it('keeps unresolved review decisions intact', async () => {
    const save = vi.fn(async () => true)
    const view = renderActions(save, true)
    await act(async () => { await view.actions.openDocumentInSystem() })
    expect(save).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(view.error).toHaveBeenCalledWith(expect.stringContaining('reviewing'))
  })
})
