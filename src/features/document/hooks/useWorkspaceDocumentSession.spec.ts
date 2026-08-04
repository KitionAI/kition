import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceDocumentSession } from './useWorkspaceDocumentSession'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const desktopMocks = vi.hoisted(() => ({
  listWorkspaceDocuments: vi.fn(),
  openWorkspaceFile: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  subscribe: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
}))

const autosaveMocks = vi.hoisted(() => ({
  cancelPendingAutoSave: vi.fn(),
  persistActiveDocument: vi.fn().mockResolvedValue(true),
  saveInFlightRef: { current: false },
  waitForActiveSave: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop')>()),
  listWorkspaceDocuments: desktopMocks.listWorkspaceDocuments,
  openWorkspaceFile: desktopMocks.openWorkspaceFile,
  readWorkspaceDocument: desktopMocks.readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges: desktopMocks.subscribe,
  writeWorkspaceDocument: desktopMocks.writeWorkspaceDocument,
}))

vi.mock('@/features/document/hooks/useWorkspaceDocumentAutosave', () => ({
  useWorkspaceDocumentAutosave: () => ({
    autoSaveStatus: 'saved',
    ...autosaveMocks,
  }),
}))

let container: HTMLDivElement
let root: Root | null = null
let externalChangeHandler: ((change: {
  path: string
  eventType: 'add' | 'change' | 'unlink'
  mtimeMs?: number
}) => void) | null = null

async function renderSession() {
  const ref: { current: ReturnType<typeof useWorkspaceDocumentSession> } = {
    current: undefined as never,
  }
  const options = {
    editorLocked: false,
    editorMode: 'rich' as const,
    files: [{ type: 'file' as const, path: 'notes/today.md', name: 'today.md', format: 'markdown' as const }],
    isModifiedDocumentPath: vi.fn().mockReturnValue(false),
    onClearModifiedDocumentPath: vi.fn(),
    onError: vi.fn(),
    onFeedback: vi.fn(),
    onOpenDocumentTab: vi.fn(),
    onOpenFileViewerTab: vi.fn(),
    onRequireMarkdownMode: vi.fn(),
    setTreeItems: vi.fn(),
  }

  function Wrapper() {
    const value = useWorkspaceDocumentSession(options)
    ref.current = value
    useEffect(() => {
      ref.current = value
    })
    return null
  }

  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Wrapper))
    await Promise.resolve()
  })
  return { ref, options }
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  externalChangeHandler = null
  desktopMocks.listWorkspaceDocuments.mockReset().mockResolvedValue({ root_path: '/vault', items: [] })
  desktopMocks.openWorkspaceFile.mockReset()
  desktopMocks.readWorkspaceDocument.mockReset()
  desktopMocks.writeWorkspaceDocument.mockReset().mockImplementation(async (path: string, content: string) => ({
    path,
    name: path.split('/').pop() || path,
    content,
    format: 'markdown',
  }))
  desktopMocks.subscribe.mockReset().mockImplementation((handler) => {
    externalChangeHandler = handler
    return () => {
      if (externalChangeHandler === handler) {
        externalChangeHandler = null
      }
    }
  })
  autosaveMocks.cancelPendingAutoSave.mockReset()
  autosaveMocks.persistActiveDocument.mockClear()
  autosaveMocks.waitForActiveSave.mockClear()
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useWorkspaceDocumentSession external changes', () => {
  it('opens revision review when the Agent reports a completed document patch', async () => {
    desktopMocks.readWorkspaceDocument
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Original article',
        format: 'markdown',
      })
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Improved article',
        format: 'markdown',
      })
    const { ref } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
    })
    await act(async () => {
      await ref.current.reviewModifiedDocuments(['notes\\today.md'])
    })

    expect(ref.current.draftContent).toBe('# Original article')
    expect(ref.current.activeDocumentRevision?.proposedDocument.content).toBe('# Improved article')
    expect(ref.current.activeDocumentRevision?.comparison.changes).toHaveLength(1)
  })

  it('opens revision review from the modified-file View action', async () => {
    desktopMocks.readWorkspaceDocument
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Original article',
        format: 'markdown',
      })
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Improved article',
        format: 'markdown',
      })
    const { ref } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
    })
    await act(async () => {
      await ref.current.openModifiedDocumentReview('/workspace/notes/today.md')
    })

    expect(ref.current.draftContent).toBe('# Original article')
    expect(ref.current.activeDocumentRevision?.proposedDocument.content).toBe('# Improved article')
    expect(ref.current.activeDocumentRevision?.comparison.changes).toHaveLength(1)
  })

  it('opens a revision review for a clean active document after an external write', async () => {
    desktopMocks.readWorkspaceDocument
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Old content',
        format: 'markdown',
      })
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: '# Updated by AI',
        format: 'markdown',
      })
    const { ref, options } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
    })
    expect(ref.current.draftContent).toBe('# Old content')
    options.onClearModifiedDocumentPath.mockClear()

    await act(async () => {
      externalChangeHandler?.({ path: 'notes/today.md', eventType: 'change', mtimeMs: 42 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(ref.current.draftContent).toBe('# Old content')
    expect(ref.current.activeDocument?.content).toBe('# Old content')
    expect(ref.current.activeDocumentRevision?.proposedDocument.content).toBe('# Updated by AI')
    expect(ref.current.activeDocumentRevision?.comparison.changes).toHaveLength(1)
    expect(options.onClearModifiedDocumentPath).not.toHaveBeenCalledWith('notes/today.md')

    await act(async () => {
      ref.current.resolveAllDocumentRevisionChanges('notes/today.md', 'accepted')
      await Promise.resolve()
    })

    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('# Updated by AI')
    expect(ref.current.activeDocument?.content).toBe('# Updated by AI')
    expect(desktopMocks.writeWorkspaceDocument).not.toHaveBeenCalled()
    expect(options.onClearModifiedDocumentPath).toHaveBeenCalledWith('notes/today.md')
  })

  it('writes the original content back when all external changes are rejected', async () => {
    desktopMocks.readWorkspaceDocument
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: 'Original paragraph.\n',
        format: 'markdown',
      })
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: 'Rewritten paragraph.\n',
        format: 'markdown',
      })
    const { ref } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
    })
    await act(async () => {
      externalChangeHandler?.({ path: 'notes/today.md', eventType: 'change', mtimeMs: 44 })
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      ref.current.resolveAllDocumentRevisionChanges('notes/today.md', 'rejected')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(desktopMocks.writeWorkspaceDocument).toHaveBeenCalledWith(
      'notes/today.md',
      'Original paragraph.\n',
    )
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('Original paragraph.\n')
  })

  it('combines accepted and rejected change locations before writing', async () => {
    desktopMocks.readWorkspaceDocument
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: 'Old start.\nStable.\nOld ending.\n',
        format: 'markdown',
      })
      .mockResolvedValueOnce({
        path: 'notes/today.md',
        name: 'today.md',
        content: 'New start.\nStable.\nNew ending.\n',
        format: 'markdown',
      })
    const { ref } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
    })
    await act(async () => {
      externalChangeHandler?.({ path: 'notes/today.md', eventType: 'change', mtimeMs: 45 })
      await Promise.resolve()
      await Promise.resolve()
    })

    const changes = ref.current.activeDocumentRevision?.comparison.changes || []
    expect(changes).toHaveLength(2)
    act(() => {
      ref.current.decideDocumentRevisionChange('notes/today.md', changes[0].id, 'accepted')
    })
    await act(async () => {
      ref.current.decideDocumentRevisionChange('notes/today.md', changes[1].id, 'rejected')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(desktopMocks.writeWorkspaceDocument).toHaveBeenCalledWith(
      'notes/today.md',
      'New start.\nStable.\nOld ending.\n',
    )
    expect(ref.current.draftContent).toBe('New start.\nStable.\nOld ending.\n')
  })

  it('keeps unsaved editor content when the file changes externally', async () => {
    desktopMocks.readWorkspaceDocument.mockResolvedValue({
      path: 'notes/today.md',
      name: 'today.md',
      content: '# Disk content',
      format: 'markdown',
    })
    const { ref, options } = await renderSession()

    await act(async () => {
      await ref.current.openDocument('notes/today.md')
      ref.current.handleDraftContentChange('# Unsaved local edit')
      await vi.advanceTimersByTimeAsync(200)
    })

    await act(async () => {
      externalChangeHandler?.({ path: 'notes/today.md', eventType: 'change', mtimeMs: 43 })
      await Promise.resolve()
    })

    expect(ref.current.draftContent).toBe('# Unsaved local edit')
    expect(desktopMocks.readWorkspaceDocument).toHaveBeenCalledTimes(1)
    expect(autosaveMocks.cancelPendingAutoSave).toHaveBeenCalled()
    expect(options.onFeedback).toHaveBeenCalledWith(
      'File changed on disk. Your unsaved editor content was kept.',
    )
  })
})
