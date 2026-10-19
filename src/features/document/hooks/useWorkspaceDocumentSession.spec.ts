import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentExternalChange } from '@/services/desktop'
import { getDocumentSession, listDocumentSessions, writeWorkspaceMarkdown } from '@/features/document/kdm/documentSessions'
import { noteWorkspaceFiles, pruneDocumentStoreOnOpen } from '@/features/document/kdm/documentStore'
import enDocument from '@/i18n/locales/en-US/document.json'
import { notify } from '@/lib/notify'
import { useWorkspaceDocumentSession } from './useWorkspaceDocumentSession'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** The workspace files, the guarded write, and the external-change subscription, in memory. */
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string; expected?: string | null }>,
  reads: [] as string[],
  handlers: new Set<(change: WorkspaceDocumentExternalChange) => void>(),
  /** The text a document's stored replica holds, when it differs from the file. */
  stored: new Map<string, string>(),
}))

/** The documents this window offers the agent (`registerOpenDocument`), in memory. */
const bridge = vi.hoisted(() => ({
  open: new Map<string, { read: () => string; apply: (content: string, meta: { tool: string; turnId?: string }) => Promise<unknown> }>(),
}))

vi.mock('@/features/document/kdm/documentAgentBridge', () => ({
  registerOpenDocument: (path: string, handlers: { read: () => string; apply: (content: string, meta: { tool: string }) => Promise<unknown> }) => {
    bridge.open.set(path, handlers)
    return () => {
      if (bridge.open.get(path) === handlers) bridge.open.delete(path)
    }
  },
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
  const { createDocumentReplica, documentBody, renderText } = await import('@kition/document-editor/model')
  const { mergeExternalText } = await import('@kition/document-editor/model')
  const { analyzeText } = await import('@kition/document-editor/model')
  const desktop = await import('@/services/desktop')
  return {
    openDocument: vi.fn(async (path: string, fileText: string, actor: bigint) => {
      // A stored replica that held `disk.stored[path]` merges the file on open, as the store does.
      const stored = disk.stored.get(path)
      const { replica, rootId, style } = createDocumentReplica(stored ?? fileText, actor)
      const meta = { docId: replica.docId, kit: 'kit.document', path, fileHash: '', fileStamp: null, exported: '', style }
      if (stored === undefined || stored === fileText) return { replica, rootId, meta, style, fileText, isNew: stored === undefined, merged: false }
      const previousText = documentBody(replica, rootId)
      replica.transact({ kind: 'import', principal: 'file' }, (tx: any) => mergeExternalText(tx, rootId, previousText, analyzeText(fileText).text, previousText))
      return { replica, rootId, meta, style, fileText, isNew: false, merged: true, previousText }
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
    pruneDocumentStoreOnOpen: vi.fn(async () => undefined),
    noteWorkspaceFiles: vi.fn(),
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
  disk.stored.clear()
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useWorkspaceDocumentSession: the workspace’s store', () => {
  it('prunes the replica store when the workspace opens and shares its files with the store', async () => {
    vi.mocked(pruneDocumentStoreOnOpen).mockClear()
    const { options } = await renderSession()
    expect(pruneDocumentStoreOnOpen).toHaveBeenCalledWith('/vault')
    expect(noteWorkspaceFiles).toHaveBeenLastCalledWith('/vault', options.files)
  })
})

describe('useWorkspaceDocumentSession: a file deleted outside Kition', () => {
  it('says the file is gone and offers to save it again', async () => {
    const persistentError = vi.spyOn(notify, 'persistentError')
    disk.files.set(PATH, 'a\n')
    const { ref } = await renderSession()
    await open(ref)
    ref.current.activeDocumentSession!.replaceText('a\nb\n', { kind: 'person', principal: 'user:local' })
    disk.files.delete(PATH)
    for (const handler of [...disk.handlers]) handler({ path: PATH, eventType: 'unlink', mtimeMs: Date.now() })
    await settle(400)
    expect(persistentError).toHaveBeenLastCalledWith(
      enDocument.session.fileMissing,
      expect.objectContaining({ label: enDocument.session.recreate }),
      expect.objectContaining({ description: enDocument.session.fileMissingDescription }),
    )
    const action = persistentError.mock.calls[persistentError.mock.calls.length - 1][1]!
    await act(async () => {
      action.onClick()
    })
    await settle()
    expect(disk.files.get(PATH)).toBe('a\nb\n')
    persistentError.mockRestore()
  })
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

  it('merges an agent change the runtime wrote to the file, keeping unsaved edits, without a review', async () => {
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
    expect(ref.current.activeAgentReview).toBeNull()
    expect(ref.current.draftContent).toBe('mine\na\nagent\n')
    expect(disk.files.get(PATH)).toBe('mine\na\nagent\n')
    expect(options.onClearModifiedDocumentPath).toHaveBeenCalledWith(PATH)
  })
})

describe('useWorkspaceDocumentSession: live agent edits', () => {
  /** The agent's edit as the runtime sends it to this window (`document/apply`). */
  async function agentApply(path: string, content: string) {
    const handlers = bridge.open.get(path)
    if (!handlers) throw new Error(`${path} is not offered to the agent`)
    let result: unknown
    await act(async () => {
      result = await handlers.apply(content, { tool: 'document_write', turnId: 't1' })
    })
    await settle(200)
    return result
  }

  it('offers every open document to the agent: background tabs too, under a new name, until it closes', async () => {
    disk.files.set(PATH, 'a\n')
    disk.files.set('notes/other.md', 'b\n')
    const { ref } = await renderSession()
    await open(ref)
    expect([...bridge.open.keys()]).toEqual([PATH])
    await open(ref, 'notes/other.md')
    expect([...bridge.open.keys()].sort()).toEqual(['notes/other.md', PATH])
    expect(bridge.open.get(PATH)!.read()).toBe('a\n')
    disk.files.set('notes/renamed.md', 'a\n')
    disk.files.delete(PATH)
    await act(async () => {
      ref.current.remapOpenedDocuments(PATH, 'notes/renamed.md')
    })
    expect([...bridge.open.keys()].sort()).toEqual(['notes/other.md', 'notes/renamed.md'])
    await act(async () => {
      ref.current.closeOpenedDocument('notes/other.md')
    })
    await settle()
    expect([...bridge.open.keys()]).toEqual(['notes/renamed.md'])
    act(() => root?.unmount())
    root = null
    expect(bridge.open.size).toBe(0)
  })

  it('shows the edit live for review; the agent’s report keeps it; accept keeps the text', async () => {
    disk.files.set(PATH, '# Plan\n\nStarts in October.\n')
    const modified = new Set<string>()
    const { ref, options } = await renderSession(modified)
    await open(ref)
    expect(await agentApply(PATH, '# Plan\n\nStarts in November.\n')).toEqual({ applied: true, content: '# Plan\n\nStarts in November.\n' })
    expect(ref.current.draftContent).toBe('# Plan\n\nStarts in November.\n')
    expect(disk.files.get(PATH)).toBe('# Plan\n\nStarts in November.\n')
    expect(ref.current.activeAgentReview).toMatchObject({ before: '# Plan\n\nStarts in October.\n', after: '# Plan\n\nStarts in November.\n' })
    // The tool's result arrives afterwards: no second review, no reload.
    modified.add(PATH)
    externalWrite(disk.files.get(PATH)!)
    await act(async () => {
      await ref.current.reviewModifiedDocuments([PATH])
    })
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.activeAgentReview).not.toBeNull()
    expect(modified.has(PATH)).toBe(true)
    const writes = disk.writes.length
    act(() => ref.current.acceptAgentReview())
    expect(ref.current.activeAgentReview).toBeNull()
    expect(modified.has(PATH)).toBe(false)
    expect(options.onFeedback).toHaveBeenLastCalledWith('Reviewed changes accepted.')
    await settle(400)
    expect(disk.writes).toHaveLength(writes)
    expect(ref.current.draftContent).toBe('# Plan\n\nStarts in November.\n')
  })

  it('rejects the edit, keeping what the person typed meanwhile', async () => {
    disk.files.set(PATH, 'one\ntwo\n')
    const { ref } = await renderSession()
    await open(ref)
    await agentApply(PATH, 'one\nTWO\n')
    ref.current.activeDocumentSession!.replaceText('zero\none\nTWO\n', { kind: 'person', principal: 'user:local' })
    await act(async () => {
      await ref.current.rejectAgentReview()
    })
    await settle(400)
    expect(ref.current.activeAgentReview).toBeNull()
    expect(ref.current.draftContent).toBe('zero\none\ntwo\n')
    expect(disk.files.get(PATH)).toBe('zero\none\ntwo\n')
  })

  it('marks a background tab changed by the agent and keeps its review for when it is shown', async () => {
    disk.files.set(PATH, 'a\n')
    disk.files.set('notes/other.md', 'b\n')
    const { ref } = await renderSession()
    await open(ref)
    await open(ref, 'notes/other.md')
    await agentApply(PATH, 'a\nagent\n')
    expect(ref.current.isOpenedDocumentChangedByAgent(PATH)).toBe(true)
    expect(ref.current.isOpenedDocumentChangedByAgent('notes/other.md')).toBe(false)
    expect(ref.current.activeAgentReview).toBeNull()
    expect(disk.files.get(PATH)).toBe('a\nagent\n')
    await open(ref)
    expect(ref.current.activeAgentReview?.after).toBe('a\nagent\n')
    await open(ref, 'notes/other.md')
    await open(ref)
    expect(ref.current.activeAgentReview?.after).toBe('a\nagent\n')
  })

  it('decides change by change in the review panel', async () => {
    disk.files.set(PATH, 'Old start.\nStable.\nOld ending.\n')
    const { ref } = await renderSession()
    await open(ref)
    await agentApply(PATH, 'New start.\nStable.\nNew ending.\n')
    act(() => ref.current.showAgentReviewChanges())
    const changes = ref.current.activeDocumentRevision?.comparison.changes || []
    expect(ref.current.activeDocumentRevision?.live).toBe(true)
    expect(changes).toHaveLength(2)
    act(() => ref.current.decideDocumentRevisionChange(PATH, changes[0].id, 'accepted'))
    await act(async () => {
      ref.current.decideDocumentRevisionChange(PATH, changes[1].id, 'rejected')
    })
    await settle(400)
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.activeAgentReview).toBeNull()
    expect(ref.current.draftContent).toBe('New start.\nStable.\nOld ending.\n')
    expect(disk.files.get(PATH)).toBe('New start.\nStable.\nOld ending.\n')
  })

  it('closes the review panel without deciding, and when undo takes the edit back', async () => {
    disk.files.set(PATH, 'a\n')
    const { ref } = await renderSession()
    await open(ref)
    await agentApply(PATH, 'a\nb\n')
    act(() => ref.current.showAgentReviewChanges())
    act(() => ref.current.closeAgentReviewChanges())
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.activeAgentReview).not.toBeNull()
    act(() => ref.current.showAgentReviewChanges())
    act(() => {
      ref.current.activeDocumentSession!.undo()
    })
    expect(ref.current.activeDocumentRevision).toBeNull()
    expect(ref.current.activeAgentReview).toBeNull()
  })

  it('reviews on open what the agent wrote to a document that was closed', async () => {
    disk.files.set(PATH, 'a\nB\nc\n')
    disk.stored.set(PATH, 'a\nb\n')
    disk.files.set('notes/other.md', 'x\ny\n')
    disk.stored.set('notes/other.md', 'x\n')
    const modified = new Set<string>([PATH])
    const { ref } = await renderSession(modified)
    await open(ref)
    expect(ref.current.draftContent).toBe('a\nB\nc\n')
    expect(ref.current.activeAgentReview).toMatchObject({ before: 'a\nb\n', after: 'a\nB\nc\n' })
    expect(modified.has(PATH)).toBe(true)
    // Another writer's change merged on open (no agent mark) is not offered for review.
    await open(ref, 'notes/other.md')
    expect(ref.current.draftContent).toBe('x\ny\n')
    expect(ref.current.activeAgentReview).toBeNull()
    await open(ref)
    await act(async () => {
      await ref.current.rejectAgentReview()
    })
    await settle(400)
    expect(disk.files.get(PATH)).toBe('a\nb\n')
    expect(modified.has(PATH)).toBe(false)
  })
})
