import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmOpts } from '@kition/app-ui/confirm'
import enWorkspace from '@/i18n/locales/en-US/workspace.json'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'
import { useWorkspaceTabControllers } from './useWorkspaceTabControllers'

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const confirm = vi.fn<(opts: ConfirmOpts | string) => Promise<boolean>>()
vi.mock('@kition/app-ui/confirm', () => ({
  useConfirm: () => confirm,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const BOARD: WorkspaceTab = { id: 'board:Plan.kiboard', type: 'board', title: 'Plan', path: 'Plan.kiboard' }
const DESIGN: WorkspaceTab = { id: 'design:Poster.kidesign', type: 'design', title: 'Poster', path: 'Poster.kidesign' }
const DOCUMENT: WorkspaceTab = { id: 'document:Notes.md', type: 'document', title: 'Notes', path: 'Notes.md', format: 'markdown', uid: 'notes' }

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTabControllers> | null = null
const closeWorkspaceTab = vi.fn()
const unregisters: Array<() => void> = []

/** An open editor of `path`, as the edit-session registry sees it. */
function openEditor(path: string, flush: () => Promise<void>) {
  const session = { flush: vi.fn(flush), discard: vi.fn() }
  unregisters.push(registerWorkspaceEditSession(session.flush, path, { discard: session.discard }))
  return session
}

function Surface({ tabs }: { tabs: WorkspaceTab[] }) {
  api = useWorkspaceTabControllers({
    workspaceTabs: tabs,
    activeWorkspaceTab: tabs[0],
    activeWorkspaceTabId: tabs[0]?.id ?? '',
    closeWorkspaceTab,
    upsertWorkspaceTab: () => {},
    setActiveResourcePath: () => {},
    workflowOpen: false,
    openDesign: () => {},
    openBoard: () => {},
    openDocument: async () => {},
  })
  return null
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function closeTab(tabId: string) {
  await act(async () => {
    api!.handleCloseWorkspaceTabById(tabId)
  })
  await settle()
}

/** A confirmation that waits until the test answers it. */
function heldConfirm() {
  let answer!: (value: boolean) => void
  confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
    answer = resolve
  }))
  return async (value: boolean) => {
    answer(value)
    await settle()
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  confirm.mockReset()
  closeWorkspaceTab.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Surface, { tabs: [BOARD, DESIGN] }))
  })
})

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister()
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceTabControllers', () => {
  it('closes a Board tab only after its pending save is written', async () => {
    let finish!: () => void
    const editor = openEditor(BOARD.path, () => new Promise<void>((resolve) => {
      finish = resolve
    }))
    await closeTab(BOARD.id)
    expect(editor.flush).toHaveBeenCalledTimes(1)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()

    await act(async () => finish())
    await settle()
    expect(closeWorkspaceTab).toHaveBeenCalledWith(BOARD.id)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks whether to discard a Board’s changes when its save fails on close', async () => {
    openEditor(BOARD.path, () => Promise.reject(new Error('disk full')))
    heldConfirm()
    await closeTab(BOARD.id)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      message: enWorkspace.whiteboard.file.closeUnsavedMessage,
      confirmLabel: enWorkspace.whiteboard.file.closeUnsavedDiscard,
      cancelLabel: enWorkspace.whiteboard.file.closeUnsavedKeep,
      variant: 'destructive',
    })
    expect(enWorkspace.whiteboard.file.closeUnsavedMessage)
      .toBe('Your latest changes to this Board could not be saved. Close it and discard them?')
    expect(enWorkspace.whiteboard.file.closeUnsavedDiscard).toBe('Discard changes and close')
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
  })

  it('keeps the Board tab and its changes when the user keeps it open', async () => {
    const editor = openEditor(BOARD.path, () => Promise.reject(new Error('disk full')))
    const answer = heldConfirm()
    await closeTab(BOARD.id)
    await answer(false)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
    expect(editor.discard).not.toHaveBeenCalled()
    expect(editor.flush).toHaveBeenCalledTimes(1)
  })

  it('discards the Board’s changes without saving, then closes its tab', async () => {
    const editor = openEditor(BOARD.path, () => Promise.reject(new Error('disk full')))
    const answer = heldConfirm()
    await closeTab(BOARD.id)
    closeWorkspaceTab.mockImplementation(() => {
      // The session already stopped saving when the tab (and its editor) closes.
      expect(editor.discard).toHaveBeenCalledTimes(1)
    })
    await answer(true)
    expect(editor.discard).toHaveBeenCalledTimes(1)
    expect(closeWorkspaceTab).toHaveBeenCalledWith(BOARD.id)
    // Discarding never tries to save again.
    expect(editor.flush).toHaveBeenCalledTimes(1)
  })

  it('asks once while a Board’s close is already waiting for an answer', async () => {
    openEditor(BOARD.path, () => Promise.reject(new Error('disk full')))
    const answer = heldConfirm()
    await closeTab(BOARD.id)
    await closeTab(BOARD.id)
    expect(confirm).toHaveBeenCalledTimes(1)
    await answer(false)

    confirm.mockResolvedValueOnce(false)
    await closeTab(BOARD.id)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('commits the table cell being edited in a document before its close saves', async () => {
    await act(async () => {
      root!.render(createElement(Surface, { tabs: [DOCUMENT, BOARD] }))
    })
    const order: string[] = []
    // A table cell being edited: its text reaches the document when the cell loses focus.
    const editorDom = document.createElement('div')
    editorDom.className = 'cm-editor'
    const cell = document.createElement('div')
    cell.setAttribute('contenteditable', 'true')
    cell.tabIndex = 0
    editorDom.appendChild(cell)
    document.body.appendChild(editorDom)
    cell.addEventListener('blur', () => order.push('cell committed'))
    cell.focus()
    expect(document.activeElement).toBe(cell)
    openEditor(DOCUMENT.path, async () => {
      order.push('flushed')
    })

    await closeTab(DOCUMENT.id)
    expect(order).toEqual(['cell committed', 'flushed'])
    expect(closeWorkspaceTab).toHaveBeenCalledWith(DOCUMENT.id)
    editorDom.remove()
  })

  it('keeps a Design tab open and shows the save failure when its save fails', async () => {
    const editor = openEditor(DESIGN.path, () => Promise.reject(new Error('disk full')))
    await closeTab(DESIGN.id)
    expect(closeWorkspaceTab).not.toHaveBeenCalled()
    expect(notify.error).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(editor.discard).not.toHaveBeenCalled()
  })
})
