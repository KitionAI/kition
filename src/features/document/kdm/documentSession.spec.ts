import { isolateHistory } from '@codemirror/commands'
import { EditorState, type ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkspaceDocument, type WorkspaceDocumentExternalChange } from '@/services/desktop'
import { flushWorkspaceEditSessions, discardWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import { redoDocument, undoDocument } from './documentHistory'
import { DocumentSession, SAVE_DELAY_MS, TYPING_GROUP_MS } from './documentSession'
import { openDocument } from './documentStore'
import {
  readWorkspaceMarkdown,
  registerDocumentSession,
  remapDocumentSessions,
  unregisterDocumentSession,
  updateWorkspaceMarkdown,
  writeWorkspaceMarkdown,
  getDocumentSession,
} from './documentSessions'

/** The workspace files, the guarded write, and the external-change subscription, in memory. */
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string; expected?: string | null }>,
  handlers: new Set<(change: WorkspaceDocumentExternalChange) => void>(),
  failWrites: null as Error | null,
  failReads: null as Error | null,
  /** Called before each write lands: tests change the file meanwhile. */
  beforeWrite: null as null | ((path: string) => void),
  /** The text a document's stored replica holds, when it differs from the file. */
  stored: new Map<string, string>(),
}))

vi.mock('@/services/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop')>()),
  readWorkspaceDocument: vi.fn(async (path: string) => {
    if (disk.failReads) throw disk.failReads
    const content = disk.files.get(path)
    if (content === undefined) throw new Error(`document not found: ${path}`)
    return { path, name: path, content, format: 'markdown' }
  }),
  writeWorkspaceDocument: vi.fn(async (path: string, content: string, guard?: { expected_root: string; expected_content: string | null }) => {
    disk.beforeWrite?.(path)
    disk.writes.push({ path, content, expected: guard?.expected_content })
    if (disk.failWrites) throw disk.failWrites
    if (guard && (disk.files.get(path) ?? null) !== guard.expected_content) throw new Error('DESIGN_SAVE_CONFLICT')
    disk.files.set(path, content)
    return { path, name: path, content, format: 'markdown' }
  }),
  subscribeWorkspaceDocumentExternalChanges: vi.fn((handler: (change: WorkspaceDocumentExternalChange) => void) => {
    disk.handlers.add(handler)
    return () => disk.handlers.delete(handler)
  }),
}))

// A store faithful to the contract in `documentStore.ts`, without the private store files.
vi.mock('./documentStore', async () => {
  const { analyzeText, createDocumentReplica, documentBody, renderText } = await import('./documentText')
  const { mergeExternalText } = await import('./documentMerge')
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
  }
})

/** The documents this window offers the agent (`registerOpenDocument`), in memory. */
const bridge = vi.hoisted(() => ({
  open: new Map<string, { read: () => string; apply: (content: string, meta: { tool: string; turnId?: string }) => Promise<unknown> }>(),
  log: [] as string[],
}))

vi.mock('./documentAgentBridge', () => ({
  registerOpenDocument: (path: string, handlers: { read: () => string; apply: (content: string, meta: { tool: string }) => Promise<unknown> }) => {
    bridge.open.set(path, handlers)
    bridge.log.push(`+${path}`)
    return () => {
      if (bridge.open.get(path) === handlers) bridge.open.delete(path)
      bridge.log.push(`-${path}`)
    }
  },
}))

const PATH = 'notes/plan.md'
const views: EditorView[] = []
const sessions: DocumentSession[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(readWorkspaceDocument).mockClear()
  disk.files.clear()
  disk.writes.length = 0
  disk.handlers.clear()
  disk.failWrites = null
  disk.failReads = null
  disk.beforeWrite = null
  disk.stored.clear()
  bridge.open.clear()
  bridge.log.length = 0
})

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  for (const session of sessions.splice(0)) {
    session.discard()
    session.dispose()
    unregisterDocumentSession(session)
  }
  vi.useRealTimers()
})

async function open(text: string, path = PATH) {
  disk.files.set(path, text)
  const session = new DocumentSession(path, { root: '/vault' })
  sessions.push(session)
  await session.start(text)
  return session
}

/** An editor view bound to the session, like the app's editors. */
function editor(session: DocumentSession) {
  const binding = session.createBinding()
  const view = new EditorView({
    state: EditorState.create({ doc: session.text(), extensions: [binding.extension, session.historyExtension(), session.agentReviewExtension()] }),
    parent: document.body,
  })
  views.push(view)
  return {
    view,
    binding,
    text: () => view.state.doc.toString(),
    type: (changes: ChangeSpec, userEvent = 'input.type') => view.dispatch({ changes, userEvent }),
  }
}

/** Lets timers and the promise queue run. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(0)
}

function externalWrite(content: string, path = PATH) {
  disk.files.set(path, content)
  for (const handler of disk.handlers) handler({ path, eventType: 'change' })
}

describe('DocumentSession: editing', () => {
  it('publishes typing as exact edits and saves the file with the guard', async () => {
    const session = await open('# Plan\n')
    const a = editor(session)
    a.type({ from: 7, insert: 'Ship it.' })
    expect(session.text()).toBe('# Plan\nShip it.')
    expect(session.isDirty()).toBe(true)
    await settle(SAVE_DELAY_MS)
    expect(disk.writes).toEqual([{ path: PATH, content: '# Plan\nShip it.', expected: '# Plan\n' }])
    expect(session.isDirty()).toBe(false)
    expect(session.getState().status).toBe('ready')
  })

  it('keeps an IME composition’s result as typed text', async () => {
    const session = await open('ab')
    const a = editor(session)
    a.type({ from: 1, insert: 'n' }, 'input.type.compose')
    a.type({ from: 1, to: 2, insert: String.fromCodePoint(0x306e) }, 'input.type.compose')
    expect(session.text()).toBe(`a${String.fromCodePoint(0x306e)}b`)
    expect(a.text()).toBe(session.text())
  })

  it('keeps two views of one document equal', async () => {
    const session = await open('one\n')
    const a = editor(session)
    const b = editor(session)
    a.type({ from: 4, insert: 'two\n' })
    await settle()
    expect(b.text()).toBe('one\ntwo\n')
    b.type({ from: 0, insert: '> ' })
    await settle()
    expect(a.text()).toBe('> one\ntwo\n')
    expect(session.text()).toBe('> one\ntwo\n')
  })

  it('reattaches a remounted editor without losing the undo history', async () => {
    const session = await open('x')
    const first = editor(session)
    first.type({ from: 1, insert: 'y' })
    first.view.destroy()
    session.releaseBinding(first.binding)
    const second = editor(session)
    expect(second.text()).toBe('xy')
    expect(undoDocument(second.view)).toBe(true)
    await settle()
    expect(second.text()).toBe('x')
  })

  it('groups a run of keystrokes into one undo step, like CodeMirror’s history', async () => {
    const session = await open('')
    const a = editor(session)
    for (const [index, char] of [...'word'].entries()) {
      a.type({ from: index, insert: char })
      await settle(50)
    }
    await settle(TYPING_GROUP_MS + 10)
    a.type({ from: 4, insert: ' next' }, 'input.paste')
    expect(session.text()).toBe('word next')
    session.undo()
    await settle()
    expect(a.text()).toBe('word')
    session.undo()
    await settle()
    expect(a.text()).toBe('')
    expect(redoDocument(a.view)).toBe(true)
    await settle()
    expect(a.text()).toBe('word')
  })

  it('runs the browser’s native undo and redo (Edit menu, execCommand) on the replica', async () => {
    const session = await open('Hello')
    const a = editor(session)
    a.type({ from: 5, insert: ' there' })
    await settle(TYPING_GROUP_MS + 10)
    const native = (inputType: string) => {
      const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
      a.view.contentDOM.dispatchEvent(event)
      return event
    }
    const undo = native('historyUndo')
    expect(undo.defaultPrevented).toBe(true)
    await settle()
    expect(session.text()).toBe('Hello')
    expect(a.text()).toBe('Hello')
    const redo = native('historyRedo')
    expect(redo.defaultPrevented).toBe(true)
    await settle()
    expect(session.text()).toBe('Hello there')
    expect(a.text()).toBe('Hello there')
  })

  it('keeps an isolated transaction (a translation) its own undo step', async () => {
    const session = await open('Hello')
    const a = editor(session)
    a.type({ from: 5, insert: ' there' })
    a.view.dispatch({ changes: { from: 0, to: 5, insert: 'Bonjour' }, annotations: isolateHistory.of('full'), userEvent: 'input.type' })
    a.type({ from: 13, insert: '!' })
    expect(session.text()).toBe('Bonjour there!')
    session.undo()
    await settle()
    expect(session.text()).toBe('Bonjour there')
    session.undo()
    await settle()
    expect(session.text()).toBe('Hello there')
  })

  it('replaces the whole text as minimal edits in one undo step', async () => {
    const lines = Array.from({ length: 50 }, (_, index) => `Line ${index}`).join('\n')
    const session = await open(lines)
    const a = editor(session)
    const replica = session.replica!
    const transact = vi.spyOn(replica, 'transact')
    const next = lines.replace('Line 25', 'Line twenty-five')
    expect(session.replaceText(next, { kind: 'person', principal: 'user:local', label: 'properties' })).toBe(true)
    expect(transact).toHaveBeenCalledTimes(1)
    await settle()
    expect(a.text()).toBe(next)
    session.undo()
    await settle()
    expect(a.text()).toBe(lines)
  })
})

describe('DocumentSession: edits made from an earlier text', () => {
  it('applies a dialog’s result three-way, keeping changes made since the dialog opened', async () => {
    const base = '---\ntitle: Plan\ntags: a\n---\n\nBody\n'
    const session = await open(base)
    const a = editor(session)
    // While the dialog is open, the file changes elsewhere and the person types in the body.
    externalWrite('---\ntitle: Plan\ntags: a\n---\n\nBody\nExternal\n')
    await settle()
    a.type({ from: session.text().indexOf('Body') + 4, insert: '!' })
    await settle(TYPING_GROUP_MS + 10)
    const next = '---\ntitle: Roadmap\ntags: a\n---\n\nBody\n'
    expect(session.applyFrom(base, next, { kind: 'person', principal: 'user:local', label: 'properties' })).toBe(true)
    await settle()
    expect(session.text()).toBe('---\ntitle: Roadmap\ntags: a\n---\n\nBody!\nExternal\n')
    expect(a.text()).toBe(session.text())
    // One undo step: the dialog's change only.
    session.undo()
    expect(session.text()).toBe('---\ntitle: Plan\ntags: a\n---\n\nBody!\nExternal\n')
  })

  it('answers false when the result does not change the text', async () => {
    const session = await open('same\n')
    expect(session.applyFrom('same\n', 'same\n', { kind: 'person', principal: 'user:local' })).toBe(false)
    expect(session.replica!.canUndo()).toBe(false)
  })
})

describe('DocumentSession: file changes', () => {
  it('merges an external change while the person types, keeping both', async () => {
    const session = await open('alpha\nbeta\n')
    const a = editor(session)
    a.type({ from: 0, insert: 'mine ' })
    externalWrite('alpha\nbeta\ngamma\n')
    await settle()
    expect(session.text()).toBe('mine alpha\nbeta\ngamma\n')
    expect(a.text()).toBe(session.text())
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe('mine alpha\nbeta\ngamma\n')
  })

  it('undo reverts only local typing, not a merged file change', async () => {
    const session = await open('alpha\n')
    const a = editor(session)
    a.type({ from: 6, insert: 'local' })
    await settle(TYPING_GROUP_MS + 10)
    // The file already holds the typing (saved meanwhile); another writer adds a line on top.
    externalWrite('external\nalpha\nlocal')
    await settle()
    expect(session.text()).toBe('external\nalpha\nlocal')
    session.undo()
    await settle()
    expect(session.text()).toBe('external\nalpha\n')
    expect(session.undo()).toBe(false)
    expect(a.text()).toBe('external\nalpha\n')
  })

  it('merges a change made to the file while it was opening', async () => {
    disk.files.set(PATH, 'alpha\nbeta\n')
    const session = new DocumentSession(PATH, { root: '/vault' })
    sessions.push(session)
    await session.start('alpha\n')
    await settle()
    expect(session.text()).toBe('alpha\nbeta\n')
    expect(session.isDirty()).toBe(false)
  })

  it('reads the file for merges and conflicts in the workspace it was opened in', async () => {
    const session = await open('one\n')
    const a = editor(session)
    externalWrite('one\nexternal\n')
    await settle()
    let changedOnce = false
    disk.beforeWrite = () => {
      if (changedOnce) return
      changedOnce = true
      disk.files.set(PATH, 'zero\none\nexternal\n')
    }
    a.type({ from: 0, insert: 'x' })
    await settle(SAVE_DELAY_MS)
    const reads = vi.mocked(readWorkspaceDocument).mock.calls
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const call of reads) expect(call).toEqual([PATH, '/vault'])
  })

  it('merges a file that changed between its last read and the save, then writes again', async () => {
    const session = await open('one\n')
    const a = editor(session)
    let changedOnce = false
    disk.beforeWrite = () => {
      if (changedOnce) return
      changedOnce = true
      disk.files.set(PATH, 'zero\none\n')
    }
    a.type({ from: 4, insert: 'two\n' })
    await settle(SAVE_DELAY_MS)
    expect(disk.writes.map((write) => write.expected)).toEqual(['one\n', 'zero\none\n'])
    expect(disk.files.get(PATH)).toBe('zero\none\ntwo\n')
    expect(session.text()).toBe('zero\none\ntwo\n')
  })

  it('gives up after three conflicting writes and retries with backoff', async () => {
    const session = await open('one\n')
    const a = editor(session)
    let counter = 0
    disk.beforeWrite = () => {
      counter += 1
      disk.files.set(PATH, `one\nother ${counter}\n`)
    }
    a.type({ from: 0, insert: 'x' })
    await settle(SAVE_DELAY_MS)
    expect(disk.writes).toHaveLength(3)
    expect(session.getState().status).toBe('error')
    disk.beforeWrite = null
    await settle(1000)
    expect(session.getState().status).toBe('ready')
    expect(disk.files.get(PATH)).toBe(session.read())
    expect(session.text()).toContain('xone\n')
  })

  it('keeps the file’s line endings and byte order mark', async () => {
    const bom = String.fromCodePoint(0xfeff)
    const session = await open(`${bom}a\r\nb\r\n`)
    const a = editor(session)
    expect(a.text()).toBe('a\nb\n')
    a.type({ from: 4, insert: 'c\n' })
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe(`${bom}a\r\nb\r\nc\r\n`)
  })

  it('does not rewrite a file with mixed line endings just because it was opened', async () => {
    const session = await open('a\r\nb\nc\n')
    expect(session.isDirty()).toBe(false)
    await settle(SAVE_DELAY_MS * 2)
    expect(disk.writes).toEqual([])
    // A real edit writes the text in the normalised style.
    session.replaceText('a\nb\nc\nd\n', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe('a\nb\nc\nd\n')
  })

  it('does not rewrite a file with lone CR line endings after merging a change', async () => {
    const session = await open('a\rb\r')
    await settle(SAVE_DELAY_MS * 2)
    expect(disk.writes).toEqual([])
    externalWrite('a\rb\rc\r')
    await settle(SAVE_DELAY_MS * 2)
    expect(session.text()).toBe('a\nb\nc\n')
    expect(session.isDirty()).toBe(false)
    expect(disk.writes).toEqual([])
  })

  it('applies an agent’s text as one undo step and answers the saved file', async () => {
    const session = await open('a\nb\n')
    const result = session.applyAgentContent('a\nB\nc\n', { tool: 'document_write' })
    await settle()
    await expect(result).resolves.toEqual({ applied: true, content: 'a\nB\nc\n' })
    expect(disk.files.get(PATH)).toBe('a\nB\nc\n')
    expect(session.replica!.canUndo()).toBe(true)
    session.undo()
    expect(session.text()).toBe('a\nb\n')
  })
})

describe('DocumentSession: live agent edits', () => {
  const agentEdit = (session: DocumentSession, content: string) => session.applyAgentContent(content, { tool: 'document_write', turnId: 't1' })

  it('shows the agent’s edit at once, saved, under review', async () => {
    const session = await open('# Plan\n\nThe pilot starts in October.\n')
    const a = editor(session)
    const result = agentEdit(session, '# Plan\n\nThe pilot starts in November.\n')
    // Live: the editor has it before the save finishes.
    expect(a.text()).toBe('# Plan\n\nThe pilot starts in November.\n')
    await settle()
    await expect(result).resolves.toEqual({ applied: true, content: '# Plan\n\nThe pilot starts in November.\n' })
    expect(disk.files.get(PATH)).toBe('# Plan\n\nThe pilot starts in November.\n')
    const review = session.agentReview()
    expect(review).toMatchObject({ before: '# Plan\n\nThe pilot starts in October.\n', after: '# Plan\n\nThe pilot starts in November.\n', tool: 'document_write' })
    expect(review!.marks.added.map((range) => session.text().slice(range.from, range.to))).toEqual(['November'])
    expect(review!.marks.removed.map((point) => point.text)).toEqual(['October'])
    expect(a.view.dom.querySelector('.cm-agent-review-added')?.textContent).toBe('November')
  })

  it('keeps an accepted edit and ends the review', async () => {
    const session = await open('a\n')
    const listener = vi.fn()
    session.subscribeAgentReview(listener)
    await agentEdit(session, 'a\nb\n')
    expect(listener).toHaveBeenCalledTimes(1)
    const writes = disk.writes.length
    session.acceptAgentReview()
    expect(session.agentReview()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    await settle(SAVE_DELAY_MS)
    expect(session.text()).toBe('a\nb\n')
    expect(disk.writes).toHaveLength(writes)
  })

  it('undoes a rejected edit as the agent’s undo step and saves', async () => {
    const session = await open('a\nb\n')
    const a = editor(session)
    a.type({ from: 0, insert: 'x' })
    await settle(TYPING_GROUP_MS + SAVE_DELAY_MS)
    await agentEdit(session, 'xa\nB\nc\n')
    await session.rejectAgentReview()
    expect(session.text()).toBe('xa\nb\n')
    expect(a.text()).toBe('xa\nb\n')
    expect(disk.files.get(PATH)).toBe('xa\nb\n')
    expect(session.agentReview()).toBeNull()
    // The agent's step is gone from the history: the next undo is the person's typing.
    session.undo()
    expect(session.text()).toBe('a\nb\n')
  })

  it('rejects the edit after the person typed elsewhere, keeping the typing', async () => {
    const session = await open('one\ntwo\nthree\n')
    const a = editor(session)
    await agentEdit(session, 'one\nTWO\nthree\n')
    a.type({ from: 14, insert: 'four\n' })
    a.type({ from: 0, insert: '> ' })
    expect(session.text()).toBe('> one\nTWO\nthree\nfour\n')
    // The marks followed the typing.
    const review = session.agentReview()!
    expect(review.marks.added.map((range) => session.text().slice(range.from, range.to))).toEqual(['TWO'])
    await session.rejectAgentReview()
    expect(session.text()).toBe('> one\ntwo\nthree\nfour\n')
    expect(disk.files.get(PATH)).toBe('> one\ntwo\nthree\nfour\n')
    expect(session.agentReview()).toBeNull()
  })

  it('ends the review when undo takes the edit back', async () => {
    const session = await open('a\n')
    const a = editor(session)
    await agentEdit(session, 'a\nagent\n')
    a.type({ from: 0, insert: 'mine ' })
    await settle(TYPING_GROUP_MS + 10)
    expect(undoDocument(a.view)).toBe(true)
    expect(session.text()).toBe('a\nagent\n')
    expect(session.agentReview()).not.toBeNull()
    expect(undoDocument(a.view)).toBe(true)
    expect(session.text()).toBe('a\n')
    expect(session.agentReview()).toBeNull()
  })

  it('reviews several edits of one turn together', async () => {
    const session = await open('a\nb\nc\n')
    await agentEdit(session, 'A\nb\nc\n')
    await agentEdit(session, 'A\nb\nC\n')
    const review = session.agentReview()!
    expect(review.before).toBe('a\nb\nc\n')
    expect(review.after).toBe('A\nb\nC\n')
    expect(review.marks.added.map((range) => session.text().slice(range.from, range.to))).toEqual(['A', 'C'])
    // One undo takes back the newest edit; the first stays under review.
    session.undo()
    expect(session.text()).toBe('A\nb\nc\n')
    expect(session.agentReview()!.after).toBe('A\nb\nc\n')
    await agentEdit(session, 'A\nb\nC\n')
    await session.rejectAgentReview()
    expect(session.text()).toBe('a\nb\nc\n')
  })

  it('keeps the reviewer’s choice of single changes', async () => {
    const session = await open('a\nb\nc\n')
    await agentEdit(session, 'A\nb\nC\n')
    await session.settleAgentReview('A\nb\nc\n')
    expect(session.text()).toBe('A\nb\nc\n')
    expect(disk.files.get(PATH)).toBe('A\nb\nc\n')
    expect(session.agentReview()).toBeNull()
  })

  it('keeps a merged file change and another writer’s edit made during the review, on reject and on a partial accept', async () => {
    for (const keep of ['none', 'first'] as const) {
      const session = await open('#old a\nb\nc\n')
      registerDocumentSession(session)
      await agentEdit(session, '#old A\nb\nC\n')
      externalWrite('#old A\nb\nC\nfrom disk\n')
      await settle()
      expect(await updateWorkspaceMarkdown(PATH, (text) => text.replace('#old', '#new'))).toBe(true)
      expect(session.text()).toBe('#new A\nb\nC\nfrom disk\n')
      if (keep === 'none') await session.rejectAgentReview()
      else await session.settleAgentReview('#old A\nb\nc\n')
      expect(session.text()).toBe(keep === 'none' ? '#new a\nb\nc\nfrom disk\n' : '#new A\nb\nc\nfrom disk\n')
      expect(disk.files.get(PATH)).toBe(session.text())
      unregisterDocumentSession(session)
    }
  })

  it('treats the watcher’s report of its own save as nothing new', async () => {
    const session = await open('a\n')
    const a = editor(session)
    await agentEdit(session, 'a\nb\n')
    const writes = disk.writes.length
    const review = session.agentReview()
    // The watcher reports the session's own write after it finished.
    externalWrite(disk.files.get(PATH)!)
    await settle(SAVE_DELAY_MS)
    expect(session.text()).toBe('a\nb\n')
    expect(a.text()).toBe('a\nb\n')
    expect(disk.writes).toHaveLength(writes)
    expect(session.agentReview()).toBe(review)
    expect(session.agentReview()!.marks.added).toHaveLength(1)
  })

  it('applies nothing for an unchanged text and starts no review', async () => {
    const session = await open('same\n')
    await expect(agentEdit(session, 'same\n')).resolves.toEqual({ applied: true, content: 'same\n' })
    expect(session.agentReview()).toBeNull()
  })

  it('reviews what a file change merged on open brought, and rejects it as the person’s edit', async () => {
    disk.stored.set(PATH, 'a\nb\n')
    const session = await open('a\nB\nc\n')
    expect(session.text()).toBe('a\nB\nc\n')
    expect(session.reviewOpenMerge()).toBe(true)
    expect(session.agentReview()).toMatchObject({ before: 'a\nb\n', after: 'a\nB\nc\n' })
    await session.rejectAgentReview()
    expect(session.text()).toBe('a\nb\n')
    expect(disk.files.get(PATH)).toBe('a\nb\n')
    // The rejection is an undoable edit of the person.
    session.undo()
    expect(session.text()).toBe('a\nB\nc\n')
  })

  it('has nothing to review when the file did not change since the last save', async () => {
    const session = await open('a\n')
    expect(session.reviewOpenMerge()).toBe(false)
    expect(session.agentReview()).toBeNull()
  })
})

describe('DocumentSession: the agent’s way in', () => {
  it('offers the open document to the agent until it closes, under its current path', async () => {
    const session = await open('live\n', 'old.md')
    expect(bridge.log).toEqual(['+old.md'])
    const handlers = bridge.open.get('old.md')!
    session.replaceText('live, unsaved\n', { kind: 'person', principal: 'user:local' })
    expect(handlers.read()).toBe('live, unsaved\n')
    await expect(handlers.apply('agent\n', { tool: 'apply_patch' })).resolves.toEqual({ applied: true, content: 'agent\n' })
    expect(session.text()).toBe('agent\n')
    expect(session.agentReview()?.tool).toBe('apply_patch')
    disk.files.set('new.md', disk.files.get('old.md')!)
    session.setPath('new.md')
    expect(bridge.log).toEqual(['+old.md', '-old.md', '+new.md'])
    expect([...bridge.open.keys()]).toEqual(['new.md'])
    session.dispose()
    expect(bridge.log.at(-1)).toBe('-new.md')
    expect(bridge.open.size).toBe(0)
  })

  it('offers nothing before the document is open', () => {
    const session = new DocumentSession(PATH, { root: '/vault' })
    sessions.push(session)
    expect(bridge.open.size).toBe(0)
  })
})

describe('DocumentSession: before a save', () => {
  it('lets the host rewrite temporary image links as one edit', async () => {
    disk.files.set(PATH, 'x')
    const session = new DocumentSession(PATH, { root: '/vault' }, {
      prepareSave: async (text) => text.replace('blob:temp', 'assets/a.png'),
    })
    sessions.push(session)
    await session.start('x')
    session.replaceText('x ![a](blob:temp)', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe('x ![a](assets/a.png)')
    expect(session.text()).toBe('x ![a](assets/a.png)')
  })

  /** A session whose host saves temporary image links as assets (asynchronously, like the real one). */
  async function openWithAssets(text: string) {
    disk.files.set(PATH, text)
    const session = new DocumentSession(PATH, { root: '/vault' }, {
      prepareSave: async (current) => {
        await Promise.resolve()
        return current.replace(/blob:(\w+)/g, 'assets/$1.png')
      },
    })
    sessions.push(session)
    await session.start(text)
    return session
  }

  it('does not make the rewrite an undo step', async () => {
    const session = await openWithAssets('x')
    session.replaceText('x ![a](blob:temp)', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    expect(session.text()).toBe('x ![a](assets/temp.png)')
    // Undo reverts the person's edit, never back to the temporary link.
    expect(session.undo()).toBe(true)
    expect(session.text()).not.toContain('blob:')
    expect(session.text()).not.toBe('x ![a](assets/temp.png)')
    expect(session.replica!.canUndo()).toBe(false)
  })

  it('rewrites the links when the session closes before its save', async () => {
    const session = await openWithAssets('x')
    session.replaceText('x ![a](blob:temp)', { kind: 'person', principal: 'user:local' })
    session.dispose()
    await settle()
    expect(disk.files.get(PATH)).toBe('x ![a](assets/temp.png)')
    expect(disk.writes.every((write) => !write.content.includes('blob:'))).toBe(true)
  })

  it('rewrites links added while a save was writing before a flush writes them', async () => {
    const session = await openWithAssets('x')
    let typed = false
    disk.beforeWrite = () => {
      if (typed) return
      typed = true
      session.replaceText(`${session.text()} ![b](blob:late)`, { kind: 'person', principal: 'user:local' })
      void session.flush().catch(() => undefined)
    }
    session.replaceText('x ![a](blob:temp)', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    await settle()
    expect(disk.files.get(PATH)).toBe('x ![a](assets/temp.png) ![b](assets/late.png)')
    expect(disk.writes.every((write) => !write.content.includes('blob:'))).toBe(true)
  })
})

describe('DocumentSession: closing and failures', () => {
  it('refuses to open for a workspace that is no longer the open one', async () => {
    vi.mocked(openDocument).mockRejectedValueOnce(new Error('DESIGN_WORKSPACE_CHANGED'))
    disk.files.set(PATH, 'kept\n')
    const session = new DocumentSession(PATH, { root: '/vault' })
    sessions.push(session)
    await expect(session.start('kept\n')).rejects.toThrow('DESIGN_WORKSPACE_CHANGED')
    expect(session.isReady()).toBe(false)
  })

  it('refuses to open without a workspace root', async () => {
    disk.files.set(PATH, 'kept\n')
    const session = new DocumentSession(PATH, { root: '' })
    sessions.push(session)
    await expect(session.start('kept\n')).rejects.toThrow()
    expect(session.isReady()).toBe(false)
  })

  it('edits the file without history when the store cannot open it', async () => {
    vi.mocked(openDocument).mockRejectedValueOnce(new Error('store entry unreadable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const session = await open('kept\n')
    expect(session.text()).toBe('kept\n')
    session.replaceText('kept\nedited\n', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe('kept\nedited\n')
  })

  it('writes the pending edit when the workspace flushes and when it closes', async () => {
    const session = await open('a')
    const a = editor(session)
    a.type({ from: 1, insert: 'b' })
    const flushed = flushWorkspaceEditSessions(PATH)
    await settle()
    await flushed
    expect(disk.files.get(PATH)).toBe('ab')
    a.type({ from: 2, insert: 'c' })
    session.dispose()
    await settle()
    expect(disk.files.get(PATH)).toBe('abc')
  })

  it('rejects a flush of a read-only file, retries, and discards on request', async () => {
    const session = await open('a')
    const a = editor(session)
    disk.failWrites = new Error('permission denied')
    a.type({ from: 1, insert: 'b' })
    const flushed = session.flush()
    const outcome = expect(flushed).rejects.toThrow('permission denied')
    await settle()
    await outcome
    expect(session.getState()).toMatchObject({ status: 'error', error: 'permission denied', dirty: true })
    expect(session.hasUnsavedChanges()).toBe(true)
    discardWorkspaceEditSessions(PATH)
    expect(session.hasUnsavedChanges()).toBe(false)
    disk.failWrites = null
    const writes = disk.writes.length
    await settle(10_000)
    expect(disk.writes).toHaveLength(writes)
    expect(disk.files.get(PATH)).toBe('a')
  })

  it('asks the window to stay open while an edit is unsaved', async () => {
    const session = await open('a')
    const a = editor(session)
    a.type({ from: 1, insert: 'b' })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    expect(disk.files.get(PATH)).toBe('ab')
  })

  it('saves to the new path after a rename', async () => {
    const session = await open('a', 'old.md')
    registerDocumentSession(session)
    remapDocumentSessions((path) => (path === 'old.md' ? 'new.md' : path))
    disk.files.set('new.md', 'a')
    disk.files.delete('old.md')
    expect(session.path).toBe('new.md')
    expect(getDocumentSession('new.md')).toBe(session)
    session.replaceText('ab', { kind: 'person', principal: 'user:local' })
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get('new.md')).toBe('ab')
  })
})

describe('Kition’s writers of other documents', () => {
  it('edit an open document through its session and write any other file', async () => {
    const session = await open('#old tag\n')
    registerDocumentSession(session)
    disk.files.set('closed.md', '#old elsewhere\n')
    const rename = (text: string) => text.replace('#old', '#new')
    expect(await updateWorkspaceMarkdown(PATH, rename)).toBe(true)
    expect(await updateWorkspaceMarkdown('closed.md', rename)).toBe(true)
    expect(session.text()).toBe('#new tag\n')
    expect(disk.files.get('closed.md')).toBe('#new elsewhere\n')
    expect(await readWorkspaceMarkdown(PATH)).toBe('#new tag\n')
    await writeWorkspaceMarkdown(PATH, '# Replaced\n')
    expect(session.text()).toBe('# Replaced\n')
    await settle(SAVE_DELAY_MS)
    expect(disk.files.get(PATH)).toBe('# Replaced\n')
  })
})
