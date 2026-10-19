import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Replica, randomActor, system } from '@/lib/kdm'
import {
  listWorkspaceDocuments,
  readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges,
  writeWorkspaceDocument,
  type WorkspaceDocumentExternalChange,
} from '@/services/desktop'
import { notify } from '@/lib/notify'
import { discardWorkspaceEditSessions, flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import type { WhiteboardElement } from '@kition/board-editor'
import { useWhiteboardEditor } from '@kition/board-editor/editor'
import {
  boardRootId,
  boardSchema,
  createBoardElementRecord,
  createBoardFromRecords,
  createBoardRecordsFromElements,
  decodeBoardFile,
  encodeBoardFile,
  readBoardRecords,
  writeBoardDiff,
} from '@kition/board-editor/model'
import { useBoardDocument } from './useBoardDocument'

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/services/desktop', () => ({
  listWorkspaceDocuments: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  subscribeWorkspaceDocumentExternalChanges: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const PATH = 'Planning/Product.kiboard'
const ROOT = '/workspace'
const CONFLICT = new Error('DESIGN_SAVE_CONFLICT')

let container: HTMLDivElement
let root: Root | null = null
/** The file on disk, as the mocked workspace reads it. */
let disk = ''
let externalListeners: Array<(change: WorkspaceDocumentExternalChange) => void> = []

const initialBoard = () => createBoardFromRecords('Product', 1n, createBoardRecordsFromElements([{
  id: 'rect-1',
  kind: 'rectangle',
  x: 1,
  y: 2,
  width: 30,
  height: 40,
}], 'Product'))

/** A copy of the board in `text`, edited by another writer (actor 2) that adds `id`. */
function editedElsewhere(text: string, id: string) {
  const decoded = decodeBoardFile(text, 2n)
  if (decoded.kind !== 'board') throw new Error('expected a board')
  const theirs = decoded.replica
  const pageId = readBoardRecords(theirs).find((record) => record.record_type === 'page')!.id
  theirs.transact(system('test'), (tx) => writeBoardDiff(tx, boardRootId(theirs), {
    added: [createBoardElementRecord({
      element: { id, kind: 'rectangle', x: 400, y: 400, width: 20, height: 20 },
      index: 5,
      pageId,
    })],
    updated: [],
    removed: [],
  }))
  return encodeBoardFile(theirs)
}

function elementIdsIn(text: string) {
  const decoded = decodeBoardFile(text, 3n)
  if (decoded.kind !== 'board') throw new Error(`expected a board, got ${decoded.reason}`)
  return readBoardRecords(decoded.replica)
    .filter((record) => record.record_type === 'element')
    .map((record) => record.id)
    .sort()
}

/** The workspace's compare-and-write: refuses a write whose expected content is not on disk. */
const guardedWrite: typeof writeWorkspaceDocument = async (path, content, guard) => {
  if (guard && guard.expected_content !== disk) throw CONFLICT
  disk = content
  return { path, name: path, content, format: 'board' }
}

const writes = () => vi.mocked(writeWorkspaceDocument).mock.calls
const lastWrite = () => writes().at(-1)!

type Harness = {
  editor: ReturnType<typeof useWhiteboardEditor>
  document: ReturnType<typeof useBoardDocument>
}

async function mount(props: { path?: string; title?: string } = {}) {
  const harness: { current: Harness | null } = { current: null }
  function View({ path, title }: { path: string; title: string }) {
    const editor = useWhiteboardEditor()
    const document = useBoardDocument({
      path,
      title,
      store: editor.store,
      replaceDocument: editor.replaceDocument,
    })
    harness.current = { editor, document }
    return null
  }
  const render = async (next: { path?: string; title?: string } = {}) => {
    await act(async () => {
      root ??= createRoot(container)
      root.render(createElement(View, { path: next.path ?? props.path ?? PATH, title: next.title ?? props.title ?? 'Product' }))
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  await render()
  return { harness, render }
}

async function addElement(harness: { current: Harness | null }, id: string, x = 100) {
  await act(async () => {
    harness.current!.editor.commands.execute({
      type: 'element.create',
      elements: [{ id, kind: 'rectangle', x, y: 100, width: 50, height: 50 } as WhiteboardElement],
    })
  })
}

/** A write that waits until the test settles it. */
function heldWrite() {
  let settle!: (outcome: Error | null) => void
  vi.mocked(writeWorkspaceDocument).mockImplementationOnce(async (path, content, guard) => {
    const outcome = await new Promise<Error | null>((resolve) => {
      settle = resolve
    })
    if (outcome) throw outcome
    return guardedWrite(path, content, guard)
  })
  return (outcome: Error | null = null) => settle(outcome)
}

function dispatchBeforeUnload() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

/** Settles `promise` and answers its rejection, or `null` when it resolved. */
async function outcomeOf(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (error) {
    return error as Error
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  disk = encodeBoardFile(initialBoard())
  externalListeners = []
  vi.mocked(readWorkspaceDocument).mockImplementation(async (path) => ({
    path,
    name: path.split('/').pop() || path,
    content: disk,
    format: 'board',
  }))
  vi.mocked(listWorkspaceDocuments).mockResolvedValue({ root_path: ROOT, items: [] })
  vi.mocked(writeWorkspaceDocument).mockImplementation(guardedWrite)
  vi.mocked(subscribeWorkspaceDocumentExternalChanges).mockImplementation((listener) => {
    externalListeners.push(listener)
    return () => {
      externalListeners = externalListeners.filter((entry) => entry !== listener)
    }
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useBoardDocument', () => {
  it('loads a .kiboard file and autosaves later SVG edits with a guarded write', async () => {
    const opened = disk
    const { harness } = await mount()
    expect(harness.current?.editor.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', kind: 'rectangle' }),
    ])
    expect(harness.current?.document.status).toBe('ready')
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => harness.current?.editor.setTool('rectangle'))
    await act(async () => {
      harness.current?.editor.beginCanvasPointer({
        world: { x: 100, y: 100 },
        screen: { x: 100, y: 100 },
      })
      harness.current?.editor.endPointer({ x: 180, y: 160 })
    })
    await advance(650)

    expect(writes()).toHaveLength(1)
    expect(lastWrite()[0]).toBe(PATH)
    expect(lastWrite()[1]).toMatch(/^\{"format":"kition-board","version":2,"kdm":"[A-Za-z0-9+/=]+"\}\n$/)
    expect(lastWrite()[2]).toEqual({ expected_root: ROOT, expected_content: opened })
    expect(elementIdsIn(lastWrite()[1])).toHaveLength(2)
  })

  it('passes the previous write as the expected content of the next one', async () => {
    const { harness } = await mount()
    await addElement(harness, 'first')
    await advance(650)
    const first = lastWrite()[1]
    await addElement(harness, 'second', 200)
    await advance(650)
    expect(writes()).toHaveLength(2)
    expect(lastWrite()[2]).toEqual({ expected_root: ROOT, expected_content: first })
    expect(elementIdsIn(lastWrite()[1])).toEqual(['first', 'rect-1', 'second'])
  })

  it('does not autosave a live drag until its record transaction commits', async () => {
    const { harness } = await mount()

    await act(async () => {
      harness.current?.editor.beginElementPointer('rect-1', { x: 1, y: 2 })
      harness.current?.editor.movePointer({
        world: { x: 31, y: 42 },
        screen: { x: 31, y: 42 },
      })
    })
    await advance(650)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => harness.current?.editor.endPointer({ x: 31, y: 42 }))
    await advance(650)
    expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
  })

  it('merges the file after a guard conflict and saves both edits', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    // Another writer saves first.
    disk = editedElsewhere(disk, 'theirs')
    const theirs = disk
    await advance(650)

    expect(writes()).toHaveLength(2)
    expect(writes()[1][2]).toEqual({ expected_root: ROOT, expected_content: theirs })
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1', 'theirs'])
    expect(harness.current?.editor.elements.map((element) => element.id).sort()).toEqual(['mine', 'rect-1', 'theirs'])
    expect(harness.current?.document.status).toBe('ready')
  })

  it('gives up after three conflicting attempts, then retries with backoff', async () => {
    const { harness } = await mount()
    let writer = 10
    vi.mocked(writeWorkspaceDocument).mockImplementation(async () => {
      // Someone else always saves just before us.
      disk = editedElsewhere(disk, `theirs-${writer++}`)
      throw CONFLICT
    })
    await addElement(harness, 'mine')
    await advance(600)
    expect(writes()).toHaveLength(3)
    expect(harness.current?.document.status).toBe('error')

    vi.mocked(writeWorkspaceDocument).mockImplementation(guardedWrite)
    await advance(999)
    expect(writes()).toHaveLength(3)
    // The retry conflicts with the last writer's save, merges it, and saves.
    await advance(1)
    expect(writes()).toHaveLength(5)
    expect(harness.current?.document.status).toBe('ready')
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1', 'theirs-10', 'theirs-11', 'theirs-12'])
  })

  it('retries a failed save after 1 s, 2 s, and 4 s', async () => {
    const { harness } = await mount()
    vi.mocked(writeWorkspaceDocument).mockRejectedValue(new Error('disk full'))
    await addElement(harness, 'mine')
    await advance(600)
    expect(writes()).toHaveLength(1)
    expect(harness.current?.document).toMatchObject({ status: 'error', error: 'disk full' })

    await advance(1000)
    expect(writes()).toHaveLength(2)
    await advance(1999)
    expect(writes()).toHaveLength(2)
    await advance(1)
    expect(writes()).toHaveLength(3)

    vi.mocked(writeWorkspaceDocument).mockImplementation(guardedWrite)
    await advance(4000)
    expect(writes()).toHaveLength(4)
    expect(harness.current?.document.status).toBe('ready')
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1'])
  })

  it('flushes a pending save once, with the latest state, when unmounted within 600 ms', async () => {
    const { harness } = await mount()
    await addElement(harness, 'first')
    await advance(100)
    await addElement(harness, 'second', 200)
    await advance(100)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => root?.unmount())
    root = null
    await advance(0)
    expect(writes()).toHaveLength(1)
    expect(elementIdsIn(lastWrite()[1])).toEqual(['first', 'rect-1', 'second'])
    await advance(2000)
    expect(writes()).toHaveLength(1)
  })

  it('flushes a pending save on beforeunload', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(writes()).toHaveLength(1)
    expect(elementIdsIn(lastWrite()[1])).toEqual(['mine', 'rect-1'])
    await advance(650)
    expect(writes()).toHaveLength(1)
  })

  it('flushes for workspace operations that wait for open editors', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    await act(async () => {
      await flushWorkspaceEditSessions(PATH)
    })
    expect(writes()).toHaveLength(1)
  })

  it('flushes the old file when the path changes, and a title change does not reload', async () => {
    const { harness, render } = await mount()
    await render({ title: 'Renamed' })
    expect(readWorkspaceDocument).toHaveBeenCalledTimes(1)

    await addElement(harness, 'mine')
    await render({ path: 'Planning/Other.kiboard' })
    expect(writes()[0][0]).toBe(PATH)
    expect(elementIdsIn(writes()[0][1])).toEqual(['mine', 'rect-1'])
    expect(readWorkspaceDocument).toHaveBeenLastCalledWith('Planning/Other.kiboard')
  })

  it('merges an external change without losing a pending local edit', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    disk = editedElsewhere(disk, 'theirs')
    const theirs = disk
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.current?.editor.elements.map((element) => element.id).sort()).toEqual(['mine', 'rect-1', 'theirs'])
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await advance(650)
    expect(writes()).toHaveLength(1)
    expect(lastWrite()[2]).toEqual({ expected_root: ROOT, expected_content: theirs })
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1', 'theirs'])
  })

  it('does not write after merging an external change it has nothing to add to', async () => {
    const { harness } = await mount()
    disk = editedElsewhere(disk, 'theirs')
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    await advance(2000)
    expect(harness.current?.editor.elements.map((element) => element.id).sort()).toEqual(['rect-1', 'theirs'])
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('opens a version-1 file read-only and never writes it', async () => {
    disk = `${JSON.stringify({ format: 'kition-board', version: 1, title: 'Old', viewport: { x: 0, y: 0, zoom: 1 }, records: [] }, null, 2)}\n`
    const { harness } = await mount()
    expect(harness.current?.document).toMatchObject({ status: 'ready', problem: 'version-1' })

    await addElement(harness, 'mine')
    await advance(2000)
    window.dispatchEvent(new Event('beforeunload'))
    await act(async () => root?.unmount())
    root = null
    await advance(2000)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('opens a board of a newer schema read-only and never writes it', async () => {
    const newer = Replica.createWith({ ...boardSchema, schemaVersion: boardSchema.schemaVersion + 1 }, initialBoard().docId, 9n, system('create'), (tx) => {
      tx.create('Board', { title: 'Future' })
    }).replica
    disk = encodeBoardFile(newer)
    const { harness } = await mount()
    expect(harness.current?.document.problem).toBe('newer-version')

    await addElement(harness, 'mine')
    await act(async () => harness.current?.document.startNewBoard())
    await advance(2000)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('replaces an unreadable file with a new board only when asked', async () => {
    disk = 'not a board'
    const { harness } = await mount()
    expect(harness.current?.document.problem).toBe('not-a-board')
    await advance(2000)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => {
      harness.current?.document.startNewBoard()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(writes()).toHaveLength(1)
    expect(lastWrite()[2]).toEqual({ expected_root: ROOT, expected_content: 'not a board' })
    expect(harness.current?.document).toMatchObject({ status: 'ready', problem: null })
    expect(elementIdsIn(disk)).toEqual([])

    await addElement(harness, 'mine')
    await advance(650)
    expect(writes()).toHaveLength(2)
    expect(elementIdsIn(disk)).toEqual(['mine'])
  })

  it('never overwrites a file another program replaced with something that is not this board', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    disk = 'replaced by another program'
    await advance(650)
    expect(writes()).toHaveLength(1)
    expect(disk).toBe('replaced by another program')
    expect(harness.current?.document).toMatchObject({ status: 'error', saveRefused: 'not-a-board' })
  })

  it('asks the window to stay open on beforeunload while the board is dirty or saving, and flushes', async () => {
    const { harness } = await mount()
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)

    await addElement(harness, 'mine')
    const release = heldWrite()
    let event!: Event
    await act(async () => {
      event = dispatchBeforeUnload()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(writes()).toHaveLength(1)
    // The write is in flight: leaving would still lose it.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true)

    await act(async () => {
      release()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)
  })

  it('writes the newest edit right after an in-flight save when flushed, without waiting for the debounce', async () => {
    const { harness } = await mount()
    await addElement(harness, 'first')
    const release = heldWrite()
    await advance(600)
    expect(writes()).toHaveLength(1)
    const first = lastWrite()[1]

    await addElement(harness, 'second', 200)
    // A file notification arrives meanwhile; its read is slow. The flush must not wait behind it.
    let finishRead!: () => void
    vi.mocked(readWorkspaceDocument).mockImplementationOnce(async (path) => {
      await new Promise<void>((resolve) => {
        finishRead = resolve
      })
      return { path, name: path, content: disk, format: 'board' }
    })
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    let flushed = false
    let flush!: Promise<void>
    await act(async () => {
      flush = flushWorkspaceEditSessions(PATH).then(() => {
        flushed = true
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(writes()).toHaveLength(1)

    await act(async () => {
      release()
      // No timers advance: the flushed edit goes out as soon as the first write lands.
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    })
    expect(writes()).toHaveLength(2)
    expect(lastWrite()[2]).toEqual({ expected_root: ROOT, expected_content: first })
    expect(elementIdsIn(lastWrite()[1])).toEqual(['first', 'rect-1', 'second'])
    await act(async () => {
      await flush
    })
    expect(flushed).toBe(true)
    await act(async () => {
      finishRead()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(writes()).toHaveLength(2)
  })

  it('rejects a flush whose write fails, and the retry still saves', async () => {
    const { harness } = await mount()
    vi.mocked(writeWorkspaceDocument).mockRejectedValueOnce(new Error('disk full'))
    await addElement(harness, 'mine')
    let failure: Error | null = null
    await act(async () => {
      failure = await outcomeOf(flushWorkspaceEditSessions(PATH))
    })
    expect(failure).toEqual(new Error('disk full'))
    expect(harness.current?.document).toMatchObject({ status: 'error', error: 'disk full' })

    await advance(1000)
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1'])
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toBeNull()
    })
  })

  it('reports a flush during a gesture that holds back the file’s changes as not flushed', async () => {
    const { harness } = await mount()
    const store = harness.current!.editor.store
    let mark!: ReturnType<typeof store.markHistory>
    await act(async () => {
      mark = store.markHistory()
    })
    await addElement(harness, 'mine')
    disk = editedElsewhere(disk, 'theirs')
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    let failure: Error | null = null
    await act(async () => {
      failure = await outcomeOf(flushWorkspaceEditSessions(PATH))
    })
    expect(failure).toBeInstanceOf(Error)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true)

    await act(async () => {
      store.squashToMark(mark, 'gesture')
    })
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toBeNull()
    })
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1', 'theirs'])
  })

  it('reschedules an edit made during the last failing retry', async () => {
    const { harness } = await mount()
    vi.mocked(writeWorkspaceDocument).mockRejectedValue(new Error('disk full'))
    await addElement(harness, 'first')
    await advance(600)
    await advance(1000)
    await advance(2000)
    expect(writes()).toHaveLength(3)
    const release = heldWrite()
    await advance(4000)
    expect(writes()).toHaveLength(4)

    await addElement(harness, 'late', 300)
    vi.mocked(writeWorkspaceDocument).mockImplementation(guardedWrite)
    await act(async () => {
      release(new Error('disk full'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.current?.document.status).toBe('error')
    await advance(1000)
    expect(writes()).toHaveLength(5)
    expect(elementIdsIn(disk)).toEqual(['first', 'late', 'rect-1'])
    expect(harness.current?.document.status).toBe('ready')
  })

  it('turns an unexpected failure while saving into an error status with a retry', async () => {
    const { harness } = await mount()
    const snapshot = vi.spyOn(Replica.prototype, 'snapshot').mockImplementationOnce(() => {
      throw new Error('engine fault')
    })
    await addElement(harness, 'mine')
    await advance(600)
    expect(harness.current?.document).toMatchObject({ status: 'error', error: 'engine fault' })
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await advance(1000)
    expect(writes()).toHaveLength(1)
    expect(harness.current?.document.status).toBe('ready')
    snapshot.mockRestore()
  })

  it('keeps a board whose file could not be read read-only, and reads it again on request', async () => {
    vi.mocked(readWorkspaceDocument).mockRejectedValueOnce(new Error('permission denied'))
    const { harness } = await mount()
    expect(harness.current?.document).toMatchObject({ status: 'error', error: 'permission denied', problem: 'read-failed' })
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toBeNull()
    })

    await act(async () => {
      harness.current?.document.reload()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.current?.document).toMatchObject({ status: 'ready', error: '', problem: null })
    expect(harness.current?.editor.elements.map((element) => element.id)).toEqual(['rect-1'])
    await addElement(harness, 'mine')
    await advance(650)
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1'])
  })

  it('stops saving when the file becomes a different board, keeping local edits in memory', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    disk = encodeBoardFile(createBoardFromRecords('Other', randomActor(), []))
    const other = disk
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.current?.document).toMatchObject({ status: 'error', saveRefused: 'different-board' })

    await addElement(harness, 'more', 300)
    await advance(5000)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
    expect(disk).toBe(other)
    expect(harness.current?.editor.elements.map((element) => element.id).sort()).toEqual(['mine', 'more', 'rect-1'])
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toBeInstanceOf(Error)
    })
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true)
  })

  it('reports a final write that fails after the editor closed, and keeps retrying it', async () => {
    const { harness } = await mount()
    vi.mocked(writeWorkspaceDocument).mockRejectedValueOnce(new Error('disk full'))
    await addElement(harness, 'mine')
    await act(async () => root?.unmount())
    root = null
    await advance(0)
    expect(writes()).toHaveLength(1)
    expect(notify.error).toHaveBeenCalledTimes(1)

    await advance(1000)
    expect(writes()).toHaveLength(2)
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1'])
  })

  it('discards unsaved edits on request: no write, no retry, the file left as it is', async () => {
    const { harness } = await mount()
    const opened = disk
    vi.mocked(writeWorkspaceDocument).mockRejectedValue(new Error('disk full'))
    await addElement(harness, 'mine')
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toEqual(new Error('disk full'))
    })
    expect(writes()).toHaveLength(1)

    await act(async () => discardWorkspaceEditSessions(PATH))
    // Nothing is left to save: the window may close and file operations need not wait.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)
    await act(async () => {
      expect(await outcomeOf(flushWorkspaceEditSessions(PATH))).toBeNull()
    })
    await addElement(harness, 'after', 300)
    await act(async () => root?.unmount())
    root = null
    await advance(10_000)
    expect(writes()).toHaveLength(1)
    expect(disk).toBe(opened)
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('does not retry a write that was running when its edits were discarded', async () => {
    const { harness } = await mount()
    const opened = disk
    await addElement(harness, 'mine')
    const settle = heldWrite()
    await advance(600)
    expect(writes()).toHaveLength(1)

    await act(async () => discardWorkspaceEditSessions(PATH))
    await act(async () => {
      settle(new Error('disk full'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => root?.unmount())
    root = null
    await advance(10_000)
    expect(writes()).toHaveLength(1)
    expect(disk).toBe(opened)
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('discards edits that can no longer be saved because the file became a different board', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    disk = encodeBoardFile(createBoardFromRecords('Other', randomActor(), []))
    const other = disk
    await act(async () => {
      for (const listener of externalListeners) listener({ path: PATH, eventType: 'change' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(harness.current?.document).toMatchObject({ saveRefused: 'different-board' })

    await act(async () => discardWorkspaceEditSessions(PATH))
    await act(async () => root?.unmount())
    root = null
    await advance(10_000)
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
    expect(disk).toBe(other)
    expect(notify.error).not.toHaveBeenCalled()
  })

  it('discards only the edits of the board at the given path', async () => {
    const { harness } = await mount()
    await addElement(harness, 'mine')
    await act(async () => discardWorkspaceEditSessions('Planning/Other.kiboard'))
    await advance(600)
    expect(writes()).toHaveLength(1)
    expect(elementIdsIn(disk)).toEqual(['mine', 'rect-1'])
  })
})
