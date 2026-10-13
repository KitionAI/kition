import { isolateHistory } from '@codemirror/commands'
import { EditorState, type ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentExternalChange } from '@/services/desktop'
import { flushWorkspaceEditSessions, discardWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import { redoDocument, undoDocument } from './documentHistory'
import { DocumentSession, SAVE_DELAY_MS, TYPING_GROUP_MS } from './documentSession'
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

const PATH = 'notes/plan.md'
const views: EditorView[] = []
const sessions: DocumentSession[] = []

beforeEach(() => {
  vi.useFakeTimers()
  disk.files.clear()
  disk.writes.length = 0
  disk.handlers.clear()
  disk.failWrites = null
  disk.failReads = null
  disk.beforeWrite = null
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
    state: EditorState.create({ doc: session.text(), extensions: [binding.extension, session.historyExtension()] }),
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

  it('leaves a held-back change to the review and applies the reviewed text as one agent step', async () => {
    const held = { value: true }
    disk.files.set(PATH, 'draft\n')
    const session = new DocumentSession(PATH, { root: '/vault' }, { holdsExternalChange: () => held.value })
    sessions.push(session)
    await session.start('draft\n')
    externalWrite('draft\nproposal\n')
    await settle()
    expect(session.text()).toBe('draft\n')
    await session.acceptReviewedText('draft\nproposal\n', 'draft\nkept\n')
    await settle()
    expect(disk.files.get(PATH)).toBe('draft\nkept\n')
    session.undo()
    expect(session.text()).toBe('draft\n')
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
})

describe('DocumentSession: closing and failures', () => {
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
