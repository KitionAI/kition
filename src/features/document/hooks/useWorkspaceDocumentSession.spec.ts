import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentExternalChange } from '@/services/desktop'
import { getDocumentSession, listDocumentSessions, writeWorkspaceMarkdown } from '@/features/document/kdm/documentSessions'
import { useWorkspaceDocumentSession } from './useWorkspaceDocumentSession'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** The workspace files, the guarded write, and the external-change subscription, in memory. */
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string; expected?: string | null }>,
  reads: [] as string[],
  handlers: new Set<(change: WorkspaceDocumentExternalChange) => void>(),
}))

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop')>()),
  listWorkspaceDocuments: vi.fn(async () => ({ root_path: '/vault', items: [] })),
  openWorkspaceFile: vi.fn(async () => ''),
  readWorkspaceDocument: vi.fn(async (path: string) => {
    disk.reads.push(path)
    const content = disk.files.get(path)
    if (content === undefined) throw new Error(`document not found: ${path}`)
    return { path, name: path.split('/').pop() || path, content, format: 'markdown' }
  }),
  writeWorkspaceDocument: vi.fn(async (path: string, content: string, guard?: { expected_root: string; expected_content: string | null }) => {
    disk.writes.push({ path, content, expected: guard?.expected_content })
    if (guard && (disk.files.get(path) ?? null) !== guard.expected_content) throw new Error('DESIGN_SAVE_CONFLICT')
    disk.files.set(path, content)
    return { path, name: path.split('/').pop() || path, content, format: 'markdown' }
  }),
  subscribeWorkspaceDocumentExternalChanges: vi.fn((handler: (change: WorkspaceDocumentExternalChange) => void) => {
    disk.handlers.add(handler)
    return () => disk.handlers.delete(handler)
  }),
}))

// A store faithful to the contract in `documentStore.ts`, without the private store files.
vi.mock('@/features/document/kdm/documentStore', async () => {
  const { createDocumentReplica, documentBody, renderText } = await import('@/features/document/kdm/documentText')
  const { mergeExternalText } = await import('@/features/document/kdm/documentMerge')
  const { analyzeText } = await import('@/features/document/kdm/documentText')
  const desktop = await import('@/services/desktop')
  return {
    openDocument: vi.fn(async (path: string, fileText: string, actor: bigint) => {
      const { replica, rootId, style } = createDocumentReplica(fileText, actor)
      const meta = { docId: replica.docId, kit: 'kit.document', path, fileHash: '', fileStamp: null, exported: '', style }
      return { replica, rootId, meta, style, fileText, isNew: true, merged: false }
    }),
    saveDocument: vi.fn(async (input: { path: string; opened: any; expectedFileText: string; expectedRoot?: string }) => {
      const fileText = renderText(documentBody(input.opened.replica, input.opened.rootId), input.opened.style)
      await desktop.writeWorkspaceDocument(input.path, fileText, { expected_root: input.expectedRoot ?? '', expected_content: input.expectedFileText })
      return { fileText, meta: input.opened.meta }
    }),
    mergeFileIntoReplica: vi.fn((opened: any, baseText: string, fileText: string) => opened.replica.transact(
      { kind: 'import', principal: 'file' },
      (tx: any) => mergeExternalText(tx, opened.rootId, analyzeText(baseText).text, analyzeText(fileText).text, tx.text(opened.rootId, 'body')),
    )),
  }
})

const PATH = 'notes/today.md'
let container: HTMLDivElement
let root: Root | null = null

async function renderSession(modified = new Set<string>()) {
  const ref: { current: ReturnType<typeof useWorkspaceDocumentSession> } = { current: undefined as never }
  const options = {
    editorLocked: false,
    editorMode: 'rich' as const,
    files: [
      { type: 'file' as const, path: PATH, name: 'today.md', format: 'markdown' as const },
      { type: 'file' as const, path: 'notes/other.md', name: 'other.md', format: 'markdown' as const },
    ],
    rootPath: '/vault',
    isModifiedDocumentPath: vi.fn((path: string) => modified.has(path)),
    onClearModifiedDocumentPath: vi.fn((path: string) => {
      modified.delete(path)
    }),
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
  return { ref, options, modified }
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function open(ref: { current: ReturnType<typeof useWorkspaceDocumentSession> }, path = PATH) {
  await act(async () => {
    await ref.current.openDocument(path)
  })
  await settle()
}

function externalWrite(content: string, path = PATH) {
  disk.files.set(path, content)
  for (const handler of [...disk.handlers]) handler({ path, eventType: 'change', mtimeMs: Date.now() })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  disk.files.clear()
  disk.writes.length = 0
  disk.reads.length = 0
  disk.handlers.clear()
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useWorkspaceDocumentSession: opening', () => {
  it('opens a Markdown document on its replica session', async () => {
    disk.files.set(PATH, '# Today\n')
    const { ref, options } = await renderSession()
    await open(ref)
    expect(ref.current.activeDocument?.path).toBe(PATH)
    expect(ref.current.activeDocumentSession?.path).toBe(PATH)
    expect(ref.current.draftContent).toBe('# Today\n')
    expect(getDocumentSession(PATH)).toBe(ref.current.activeDocumentSession)
    expect(options.onOpenDocumentTab).toHaveBeenCalledWith(expect.objectContaining({ path: PATH }))
  })

  it('opens one session when a document is opened twice at once', async () => {
    disk.files.set(PATH, 'once\n')
    const { ref } = await renderSession()
    const document = { path: PATH, name: 'today.md', content: 'once\n' }
    await act(async () => {
      await Promise.all([ref.current.applyWorkspaceDocument(document), ref.current.applyWorkspaceDocument(document)])
    })
    expect(listDocumentSessions()).toHaveLength(1)
    expect(ref.current.activeDocumentSession).toBe(listDocumentSessions()[0])
  })

  it('reports an unreadable file and opens nothing', async () => {
    const { ref, options } = await renderSession()
    await open(ref, 'notes/missing.md')
    expect(options.onError).toHaveBeenLastCalledWith('document not found: notes/missing.md')
    expect(ref.current.activeDocument).toBeNull()
    expect(getDocumentSession('notes/missing.md')).toBeNull()
  })

  it('keeps a background tab’s session: switching back neither reads nor reloads it', async () => {
    disk.files.set(PATH, 'a\n')
    disk.files.set('notes/other.md', 'b\n')
    const { ref } = await renderSession()
    await open(ref)
    const session = ref.current.activeDocumentSession!
    session.replaceText('a\nlocal\n', { kind: 'person', principal: 'user:local' })
    await open(ref, 'notes/other.md')
    expect(ref.current.activeDocumentSession?.path).toBe('notes/other.md')
    disk.reads.length = 0
    await open(ref)
    expect(disk.reads).toEqual([])
    expect(ref.current.activeDocumentSession).toBe(session)
    expect(ref.current.draftContent).toBe('a\nlocal\n')
  })

  it('marks a background tab modified until its session saved', async () => {
    disk.files.set(PATH, 'a\n')
    disk.files.set('notes/other.md', 'b\n')
    const { ref } = await renderSession()
    await open(ref)
    ref.current.activeDocumentSession!.replaceText('a!\n', { kind: 'person', principal: 'user:local' })
    await open(ref, 'notes/other.md')
    expect(ref.current.isOpenedDocumentModified(PATH)).toBe(true)
    await settle(400)
    expect(ref.current.isOpenedDocumentModified(PATH)).toBe(false)
    expect(disk.files.get(PATH)).toBe('a!\n')
  })

  it('stops a closed document’s session after writing its edit', async () => {
    disk.files.set(PATH, 'a\n')
    const { ref } = await renderSession()
    await open(ref)
    ref.current.activeDocumentSession!.replaceText('a\nb\n', { kind: 'person', principal: 'user:local' })
    await act(async () => {
      ref.current.closeOpenedDocument(PATH)
    })
    await settle()
    expect(disk.files.get(PATH)).toBe('a\nb\n')
    expect(listDocumentSessions()).toEqual([])
    expect(ref.current.activeDocumentSession).toBeNull()
  })

  it('moves an open session with its file', async () => {
    disk.files.set(PATH, 'a\n')
    const { ref } = await renderSession()
    await open(ref)
    const session = ref.current.activeDocumentSession!
    disk.files.set('notes/renamed.md', 'a\n')
    disk.files.delete(PATH)
    await act(async () => {
      ref.current.remapOpenedDocuments(PATH, 'notes/renamed.md')
    })
    expect(session.path).toBe('notes/renamed.md')
    expect(ref.current.activeDocument?.path).toBe('notes/renamed.md')
    expect(ref.current.getOpenedDocument('notes/renamed.md')).not.toBeNull()
    session.replaceText('a\nb\n', { kind: 'person', principal: 'user:local' })
    await settle(400)
    expect(disk.files.get('notes/renamed.md')).toBe('a\nb\n')
    expect(disk.files.has(PATH)).toBe(false)
  })
})

describe('useWorkspaceDocumentSession: text setters', () => {
  it('restores the saved version and imports a file as undoable edits', async () => {
    disk.files.set(PATH, 'saved\n')
    const { ref } = await renderSession()
    await open(ref)
    const session = ref.current.activeDocumentSession!
    session.replaceText('saved\nunsaved\n', { kind: 'person', principal: 'user:local' })
    await act(async () => {
      expect(ref.current.restoreSavedVersion()).toBe(true)
    })
    expect(session.text()).toBe('saved\n')
    session.undo()
    expect(session.text()).toBe('saved\nunsaved\n')
    await act(async () => {
      expect(ref.current.replaceActiveDocumentText('# Imported\n', 'import')).toBe(true)
    })
    await settle(400)
    expect(ref.current.draftContent).toBe('# Imported\n')
    expect(disk.files.get(PATH)).toBe('# Imported\n')
  })

  it('takes a write from another Kition feature into the open document', async () => {
    disk.files.set(PATH, '- one\n')
    const { ref } = await renderSession()
    await open(ref)
    await act(async () => {
      await writeWorkspaceMarkdown(PATH, '- one\n- two\n')
    })
    await settle(400)
    expect(ref.current.draftContent).toBe('- one\n- two\n')
    expect(disk.files.get(PATH)).toBe('- one\n- two\n')
  })
})

describe('useWorkspaceDocumentSession: external changes', () => {
  it('merges a plain external change into a clean document', async () => {
    disk.files.set(PATH, '# Old content\n')
    const { ref } = await renderSession()
    await open(ref)
    externalWrite('# Old content\nAdded elsewhere.\n')
    await settle(200)
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('# Old content\nAdded elsewhere.\n')
    expect(disk.writes).toEqual([])
  })

  it('keeps unsaved edits and merges the file change (nothing is dropped or overwritten)', async () => {
    disk.files.set(PATH, 'line one\n')
    const { ref } = await renderSession()
    await open(ref)
    ref.current.activeDocumentSession!.replaceText('local line\nline one\n', { kind: 'person', principal: 'user:local' })
    externalWrite('line one\nexternal line\n')
    await settle(400)
    expect(ref.current.draftContent).toBe('local line\nline one\nexternal line\n')
    expect(disk.files.get(PATH)).toBe('local line\nline one\nexternal line\n')
  })

  it('opens revision review when the Agent reports a completed document patch', async () => {
    disk.files.set(PATH, '# Original article')
    const modified = new Set<string>()
    const { ref } = await renderSession(modified)
    await open(ref)
    modified.add(PATH)
    externalWrite('# Improved article')
    await settle()
    expect(ref.current.draftContent).toBe('# Original article')
    await act(async () => {
      await ref.current.reviewModifiedDocuments(['notes\\today.md'])
    })
    expect(ref.current.draftContent).toBe('# Original article')
    expect(ref.current.activeDocumentRevision?.proposedDocument.content).toBe('# Improved article')
    expect(ref.current.activeDocumentRevision?.comparison.changes).toHaveLength(1)

    await act(async () => {
      ref.current.resolveAllDocumentRevisionChanges(PATH, 'accepted')
    })
    await settle(200)
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('# Improved article')
    expect(disk.writes).toEqual([])
    expect(modified.has(PATH)).toBe(false)
    // The accepted proposal is one undo step of the person's history.
    ref.current.activeDocumentSession!.undo()
    expect(ref.current.activeDocumentSession!.text()).toBe('# Original article')
  })

  it('opens revision review from the modified-file View action', async () => {
    disk.files.set(PATH, '# Original article')
    const modified = new Set<string>()
    const { ref } = await renderSession(modified)
    await open(ref)
    modified.add(PATH)
    disk.files.set(PATH, '# Improved article')
    await act(async () => {
      await ref.current.openModifiedDocumentReview('/workspace/notes/today.md')
    })
    expect(ref.current.activeDocumentRevision?.proposedDocument.content).toBe('# Improved article')
  })

  it('writes the original content back, guarded, when all agent changes are rejected', async () => {
    disk.files.set(PATH, 'Original paragraph.\n')
    const modified = new Set<string>()
    const { ref } = await renderSession(modified)
    await open(ref)
    modified.add(PATH)
    externalWrite('Rewritten paragraph.\n')
    await act(async () => {
      await ref.current.reviewModifiedDocuments([PATH])
    })
    await act(async () => {
      ref.current.resolveAllDocumentRevisionChanges(PATH, 'rejected')
    })
    await settle(200)
    expect(disk.writes).toEqual([{ path: PATH, content: 'Original paragraph.\n', expected: 'Rewritten paragraph.\n' }])
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('Original paragraph.\n')
  })

  it.each(['individual', 'remaining'])('combines decisions before writing (%s)', async (mode) => {
    disk.files.set(PATH, 'Old start.\nStable.\nOld ending.\n')
    const modified = new Set<string>([PATH])
    const { ref } = await renderSession(modified)
    await act(async () => {
      await ref.current.applyWorkspaceDocument({ path: PATH, name: 'today.md', content: 'Old start.\nStable.\nOld ending.\n' })
    })
    externalWrite('New start.\nStable.\nNew ending.\n')
    await act(async () => {
      await ref.current.reviewModifiedDocuments([PATH])
    })
    const changes = ref.current.activeDocumentRevision?.comparison.changes || []
    expect(changes).toHaveLength(2)
    act(() => {
      ref.current.decideDocumentRevisionChange(PATH, changes[0].id, 'accepted')
    })
    await act(async () => {
      if (mode === 'remaining') ref.current.resolveAllDocumentRevisionChanges(PATH, 'rejected')
      else ref.current.decideDocumentRevisionChange(PATH, changes[1].id, 'rejected')
    })
    await settle(200)
    expect(disk.files.get(PATH)).toBe('New start.\nStable.\nOld ending.\n')
    expect(ref.current.draftContent).toBe('New start.\nStable.\nOld ending.\n')
  })

  it('merges an agent change into a document with unsaved edits instead of reviewing it', async () => {
    disk.files.set(PATH, 'a\n')
    const modified = new Set<string>()
    const { ref, options } = await renderSession(modified)
    await open(ref)
    ref.current.activeDocumentSession!.replaceText('mine\na\n', { kind: 'person', principal: 'user:local' })
    modified.add(PATH)
    externalWrite('a\nagent\n')
    await act(async () => {
      await ref.current.reviewModifiedDocuments([PATH])
    })
    await settle(400)
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.draftContent).toBe('mine\na\nagent\n')
    expect(disk.files.get(PATH)).toBe('mine\na\nagent\n')
    expect(options.onClearModifiedDocumentPath).toHaveBeenCalledWith(PATH)
  })
})
