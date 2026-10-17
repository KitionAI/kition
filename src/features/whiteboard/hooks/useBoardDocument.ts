import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { randomActor, type Replica, type Version } from '@/lib/kdm'
import { notify } from '@/lib/notify'
import {
  createEmptyBoard,
  decodeBoardFile,
  encodeBoardFile,
  mergeBoardFile,
  readBoardFileCopy,
  replicaIncludes,
  versionIncludes,
  type BoardFileCopy,
  type BoardFileProblem,
} from '@/features/whiteboard/kdm/boardKdmFile'
import type { BoardStore } from '@/features/whiteboard/lib/boardStore'
import { registerOpenBoard } from '@/features/whiteboard/lib/openBoards'
import {
  listWorkspaceDocuments,
  readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges,
  writeWorkspaceDocument,
  type WorkspaceDocumentExternalChange,
} from '@/services/desktop'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'

type BoardDocumentStatus = 'loading' | 'ready' | 'saving' | 'error'

/** Why the board is not shown for editing: the file cannot be opened, or could not be read. */
export type BoardDocumentProblem = BoardFileProblem | 'read-failed'

/** Why saving stopped: the file on disk can no longer be merged with the open board. */
export type BoardSaveRefusal = BoardFileProblem | 'different-board'

type BoardDocumentState = {
  status: BoardDocumentStatus
  /** The last load or save failure, as reported. */
  error: string
  /** Why the file is not open for editing; the board is then read-only and never written. */
  problem: BoardDocumentProblem | null
  /** Why the file on disk can no longer be merged (it was replaced by something else); saving stops. */
  saveRefused: BoardSaveRefusal | null
}

/** Debounce of saves after an edit. */
const SAVE_DELAY_MS = 600
/** Retries after a failed save; edits start new attempts as well. */
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const
/** Writes per save, each after merging the file a conflict showed changed. */
const MAX_SAVE_ATTEMPTS = 3
/** The guarded write's refusal (the file is not what this session last read or wrote). */
const SAVE_CONFLICT = 'DESIGN_SAVE_CONFLICT'
/** A flush that could not write the board yet: a gesture holds back changes merged from the file. */
const SAVE_HELD_BACK = 'BOARD_SAVE_HELD_BACK'
/** A flush refused because the file on disk is no longer this board. */
const SAVE_REFUSED = 'BOARD_SAVE_REFUSED'

const INITIAL_STATE: BoardDocumentState = { status: 'loading', error: '', problem: null, saveRefused: null }

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
const asError = (reason: unknown) => (reason instanceof Error ? reason : new Error(message(reason)))

type SessionHost = {
  /** Shows `replica` in the editor (it becomes the store's document). */
  load: (replica: Replica) => void
  title: () => string
  onState: (state: BoardDocumentState) => void
  /** The save made when the editor closed failed; the session keeps retrying it. */
  closedSaveFailed: (reason: unknown) => void
}

/**
 * One open `.kiboard` file: loads it into the store, saves the store's replica with guarded
 * writes, and merges what other writers put in the file. File operations (saves, merges, a new
 * board) run one at a time; a flush during a save has the newest edit written right after it.
 */
class BoardDocumentSession {
  private root = ''
  /** The replica this session loaded and saves; the store's document while the session is live. */
  private replica: Replica | null = null
  /** The file text as last read or written: what the next guarded write expects on disk. */
  private fileText: string | null = null
  /** The board version the file holds, as far as this session knows. */
  private fileVersion: Version | null = null
  /** File copies whose import the store holds back until a gesture ends; saving waits for them. */
  private deferred: BoardFileCopy[] = []
  private problem: BoardDocumentProblem | null = null
  private state = INITIAL_STATE
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  /** The running save; it saves edits made meanwhile itself, or its retry does. */
  private saveRun: Promise<void> | null = null
  /** A flush arrived while `saveRun` was writing: write the newest edit right after. */
  private flushRequested = false
  /** Why the last save left the board unsaved, or `null` when it did not. */
  private saveFailure: Error | null = null
  /** Above zero while this session changes the store itself (loads, merges): not an edit. */
  private importing = 0
  /** The replica version the last store notification showed, to tell edits from other notifications. */
  private seenVersion: Version | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  /** The unsaved edits were discarded: nothing is saved or retried any more. */
  private discarded = false
  private readonly cleanups: Array<() => void> = []
  /** Withdraws the board from the open boards (`openBoards.ts`), while it is announced there. */
  private withdrawOpen: (() => void) | null = null
  /** The document id of the board announced there. */
  private openDocId: string | null = null

  constructor(
    private readonly path: string,
    private readonly store: BoardStore,
    private readonly host: SessionHost,
  ) {}

  start() {
    this.cleanups.push(this.store.subscribe(this.onStoreChange))
    this.cleanups.push(subscribeWorkspaceDocumentExternalChanges(this.onExternalChange))
    this.cleanups.push(registerWorkspaceEditSession(this.flush, this.path, { discard: this.discard }))
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!this.hasUnsavedChanges()) return
      // Like the Document and Design editors: ask the window to stay open while the save runs.
      event.preventDefault()
      event.returnValue = ''
      void this.flush().catch(() => undefined)
    }
    window.addEventListener('beforeunload', beforeUnload)
    this.cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload))
    void this.enqueue(() => this.load())
  }

  /**
   * Saves a pending change now, then stops: no more merges or state updates. A final write that
   * fails is reported to the host and retried with the usual backoff.
   */
  dispose() {
    if (this.disposed) return
    const final = this.flush()
    this.disposed = true
    this.setOpen(false)
    clearTimeout(this.retryTimer)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    final.catch((reason: unknown) => this.host.closedSaveFailed(reason))
  }

  /** Announces the board as open for editing (or withdraws it): co-editing follows it then. */
  private setOpen(open: boolean) {
    const docId = open && !this.disposed ? this.store.getReplica().docId : null
    // Another board (a file replaced by a different one) is announced anew, under its own identity.
    if (this.withdrawOpen && docId === this.openDocId) return
    this.withdrawOpen?.()
    this.withdrawOpen = null
    this.openDocId = docId
    if (!docId) return
    this.withdrawOpen = registerOpenBoard({
      path: this.path,
      replica: () => this.store.getReplica(),
      importChanges: (changes) => this.store.importChanges(changes),
      subscribe: (listener) => this.store.subscribe(listener),
      save: () => this.flush(),
    })
  }

  /**
   * Drops the edits not saved yet, ahead of the editor closing without them: stops saving and
   * retrying, and never writes again. The file is left as it is; a write already running ends
   * on its own but is not retried.
   */
  readonly discard = () => {
    this.discarded = true
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.flushRequested = false
  }

  /**
   * Saves a pending change now. Resolves once every edit made before the call is in the file;
   * rejects when it is not (the write failed, the file is no longer this board, or a gesture
   * holds back changes merged from the file).
   */
  readonly flush = async (): Promise<void> => {
    // Discarded edits are not this session's to save any more.
    if (this.discarded) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const target = this.replica?.version() ?? null
    if (this.saveRun) {
      this.flushRequested = true
      await this.saveRun
    } else {
      await this.enqueue(() => this.save())
    }
    if (this.discarded) return
    this.checkFlushed(target)
  }

  /** Reads a file that could not be read again. */
  reload() {
    return this.enqueue(async () => {
      if (this.disposed || this.problem !== 'read-failed') return
      this.setState({ status: 'loading', error: '' })
      await this.load()
    })
  }

  /** Replaces a file that cannot be opened (an old or damaged one, never a newer Kition's Board) with a new empty board. */
  startNewBoard() {
    return this.enqueue(async () => {
      const expected = this.fileText
      if (this.disposed || (this.problem !== 'version-1' && this.problem !== 'not-a-board') || expected === null) return
      this.setState({ status: 'saving', error: '' })
      let text: string
      try {
        text = encodeBoardFile(createEmptyBoard(this.host.title(), randomActor()))
        await writeWorkspaceDocument(this.path, text, { expected_root: this.root, expected_content: expected })
      } catch (reason) {
        if (this.disposed) return
        if (!isBoardSaveConflict(reason)) {
          this.setState({ status: 'error', error: message(reason) })
          return
        }
        // Someone else changed the file meanwhile: show what it holds now.
        await this.reopen()
        return
      }
      if (!this.disposed) this.open(text)
    })
  }

  private async load() {
    try {
      const [document, workspace] = await Promise.all([
        readWorkspaceDocument(this.path),
        listWorkspaceDocuments(),
      ])
      if (this.disposed) return
      this.root = workspace.root_path
      this.open(document.content)
    } catch (reason) {
      if (this.disposed) return
      // Nothing to edit: an empty editable board here would never be saved.
      this.setOpen(false)
      this.problem = 'read-failed'
      this.replica = null
      this.fileText = null
      this.fileVersion = null
      this.setState({ status: 'error', error: message(reason), problem: 'read-failed', saveRefused: null })
    }
  }

  private async reopen() {
    try {
      const document = await readWorkspaceDocument(this.path)
      if (!this.disposed) this.open(document.content)
    } catch (reason) {
      if (!this.disposed) this.setState({ status: 'error', error: message(reason) })
    }
  }

  /** Opens file text read from disk: a board goes to the editor; anything else is read-only. */
  private open(text: string) {
    const decoded = decodeBoardFile(text, randomActor())
    this.fileText = text
    this.deferred = []
    if (decoded.kind === 'unsupported') {
      this.setOpen(false)
      this.problem = decoded.reason
      this.replica = null
      this.fileVersion = null
      this.setState({ status: 'ready', error: '', problem: decoded.reason, saveRefused: null })
      return
    }
    this.problem = null
    this.replica = decoded.replica
    this.fileVersion = decoded.replica.version()
    this.setState({ status: 'ready', error: '', problem: null, saveRefused: null })
    this.changeStore(() => this.host.load(decoded.replica))
    this.setOpen(true)
    // A repair while the store adopted the replica changed it: save that.
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  /** Runs a change this session makes to the store (a load, a merge): it is not an edit to save. */
  private changeStore(change: () => void) {
    this.importing += 1
    try {
      change()
    } finally {
      this.importing -= 1
      this.seenVersion = this.replica?.version() ?? null
    }
  }

  private readonly onStoreChange = () => {
    if (this.disposed || this.importing > 0 || !this.isLive()) return
    if (this.store.getSnapshot().isTransacting) {
      // A live gesture: save once it commits.
      if (!this.saveRun) {
        clearTimeout(this.saveTimer)
        this.saveTimer = undefined
      }
      return
    }
    const version = this.replica!.version()
    if (this.seenVersion?.equals(version)) return
    this.seenVersion = version
    // A new edit starts new save attempts.
    this.retries = 0
    // A running save writes the edit itself, or schedules a retry that does.
    if (this.saveRun || this.state.saveRefused) return
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  private readonly onExternalChange = (change: WorkspaceDocumentExternalChange) => {
    if (this.disposed || change.path !== this.path || change.eventType === 'unlink') return
    void this.enqueue(() => this.reconcile())
  }

  /** Merges what the file holds now after another writer changed it; local edits are kept. */
  private async reconcile() {
    if (this.disposed || this.fileText === null) return
    let text: string
    try {
      text = (await readWorkspaceDocument(this.path)).content
    } catch {
      return
    }
    if (this.disposed || text === this.fileText) return
    const replica = this.replica
    if (!replica) {
      // A file that could not be opened changed: it may be a board now.
      this.open(text)
      return
    }
    let refused: BoardSaveRefusal | null
    try {
      refused = this.merge(replica, text)
    } catch (reason) {
      this.failed(reason)
      return
    }
    if (refused) {
      this.refuse(refused)
      return
    }
    if (this.state.saveRefused) this.setState({ status: 'ready', saveRefused: null })
    if (this.isDirty() && this.saveTimer === undefined) this.schedule(SAVE_DELAY_MS)
  }

  private save(): Promise<void> {
    const run: Promise<void> = Promise.resolve().then(async () => {
      this.saveFailure = null
      try {
        await this.saveAttempts()
      } catch (reason) {
        // An unexpected failure (encoding, a repair while merging): report it and retry.
        this.failed(reason)
      } finally {
        if (this.saveRun === run) {
          this.saveRun = null
          this.flushRequested = false
        }
      }
    })
    this.saveRun = run
    return run
  }

  private async saveAttempts() {
    const replica = this.replica
    if (!replica || this.problem || this.fileText === null) return
    if (this.state.saveRefused) {
      this.saveFailure = new Error(SAVE_REFUSED)
      return
    }
    for (let attempt = 1; ; attempt += 1) {
      if (this.discarded) return
      if (!this.settleDeferred(replica)) {
        // Writing now would drop the file's changes the gesture holds back: save after it ends.
        this.saveFailure = new Error(SAVE_HELD_BACK)
        this.schedule(SAVE_DELAY_MS)
        return
      }
      if (!this.isDirty()) {
        if (this.state.status === 'saving') this.setState({ status: 'ready' })
        return
      }
      const version = replica.version()
      const text = encodeBoardFile(replica)
      this.setState({ status: 'saving', error: '' })
      try {
        await writeWorkspaceDocument(this.path, text, {
          expected_root: this.root,
          expected_content: this.fileText,
        })
      } catch (reason) {
        if (!isBoardSaveConflict(reason) || attempt >= MAX_SAVE_ATTEMPTS) {
          this.failed(reason)
          return
        }
        let current: string
        try {
          current = (await readWorkspaceDocument(this.path)).content
        } catch (readFailure) {
          this.failed(readFailure)
          return
        }
        const refused = this.merge(replica, current)
        if (refused) {
          // The file is no longer this board: never overwrite it.
          this.refuse(refused)
          return
        }
        continue
      }
      this.fileText = text
      this.fileVersion = version
      this.retries = 0
      clearTimeout(this.retryTimer)
      this.setState({ status: 'ready', error: '', saveRefused: null })
      if (!this.isDirty()) return
      if (this.flushRequested) {
        // A flush is waiting for the edits made during this write: write them now.
        this.flushRequested = false
        attempt = 0
        continue
      }
      if (this.saveTimer === undefined) this.schedule(SAVE_DELAY_MS)
      return
    }
  }

  /** Answers whether the edits up to `target` are in the file; throws why not. */
  private checkFlushed(target: Version | null) {
    // A file that is not open for editing has nothing of this session's to save.
    if (!this.replica || this.problem) return
    if (this.state.saveRefused) throw new Error(SAVE_REFUSED)
    if (target && this.fileVersion && versionIncludes(this.fileVersion, target)) return
    if (!this.isDirty()) return
    throw this.saveFailure ?? new Error(SAVE_HELD_BACK)
  }

  /** Whether leaving now could lose an edit: a save is running, or the board is not saved. */
  private hasUnsavedChanges() {
    if (this.discarded) return false
    if (this.saveRun) return true
    return this.replica !== null && this.problem === null && this.isDirty()
  }

  /**
   * Imports another copy of the board (file text) and makes it the file this session expects.
   * Answers why the text cannot be merged, or `null` when it was.
   */
  private merge(replica: Replica, text: string): BoardSaveRefusal | null {
    const copy = readBoardFileCopy(replica, text)
    if (!copy) {
      const decoded = decodeBoardFile(text, randomActor())
      return decoded.kind === 'unsupported' ? decoded.reason : 'different-board'
    }
    if (this.isLive()) {
      // Through the store, so the view is rebuilt; during a gesture it imports when the gesture ends.
      this.changeStore(() => this.store.importChanges(copy.changes))
      if (!replicaIncludes(replica, copy.version)) this.deferred.push(copy)
    } else {
      mergeBoardFile(replica, text)
    }
    this.fileText = text
    this.fileVersion = copy.version
    return null
  }

  /** Stops saving: the file is no longer this board. Local edits stay in the editor, unsaved. */
  private refuse(refused: BoardSaveRefusal) {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    clearTimeout(this.retryTimer)
    this.saveFailure = new Error(SAVE_REFUSED)
    this.setState({ status: 'error', error: '', saveRefused: refused })
  }

  /**
   * Whether every merged file copy is in the replica, so a write cannot drop the file's changes.
   * After the session ends nothing else imports them, so they are imported here.
   */
  private settleDeferred(replica: Replica) {
    this.deferred = this.deferred.filter((copy) => !replicaIncludes(replica, copy.version))
    if (this.deferred.length === 0) return true
    if (this.isLive()) return false
    for (const copy of this.deferred.splice(0)) replica.importChanges(copy.changes)
    return true
  }

  /** A save failed: show it and retry with backoff (also after the editor closed, for the final write). */
  private failed(reason: unknown) {
    if (this.discarded) return
    this.saveFailure = asError(reason)
    this.setState({ status: 'error', error: message(reason) })
    if (this.retries >= RETRY_DELAYS_MS.length) return
    const delay = RETRY_DELAYS_MS[this.retries]
    this.retries += 1
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.flush().catch(() => undefined)
    }, delay)
  }

  /** Whether the session's replica is the store's document (the editor shows and edits it). */
  private isLive() {
    return !this.disposed && this.replica !== null && this.problem === null && this.store.getReplica() === this.replica
  }

  private isDirty() {
    return this.replica !== null && this.fileVersion !== null && !this.replica.version().equals(this.fileVersion)
  }

  private schedule(delay: number) {
    if (this.disposed || this.discarded) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush().catch(() => undefined)
    }, delay)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation).catch(() => undefined)
    this.queue = next
    return next
  }

  private setState(patch: Partial<BoardDocumentState>) {
    if (this.disposed) return
    const next = { ...this.state, ...patch }
    if (
      next.status === this.state.status
      && next.error === this.state.error
      && next.problem === this.state.problem
      && next.saveRefused === this.state.saveRefused
    ) return
    this.state = next
    this.host.onState(next)
  }
}

/** Whether a save failure (an error or its message) is the guarded write's conflict refusal. */
export function isBoardSaveConflict(reason: unknown) {
  return message(reason).includes(SAVE_CONFLICT)
}

/**
 * The `.kiboard` file behind a board editor: opens it into `store` (through `replaceDocument`), saves
 * edits 600 ms after they commit with guarded writes, merges changes other writers make to the
 * file, and saves a pending change when the editor closes, the path changes, or the window
 * unloads. A file that is not a board this build can read opens read-only and is never written.
 * The title is only used for a new board; changing it does not reload the file.
 */
export function useBoardDocument(options: {
  path: string
  title: string
  store: BoardStore
  replaceDocument: (input: { replica: Replica }) => void
}) {
  const { t } = useTranslation('workspace')
  const [state, setState] = useState<BoardDocumentState>(INITIAL_STATE)
  const sessionRef = useRef<BoardDocumentSession | null>(null)
  const titleRef = useRef(options.title)
  const replaceDocumentRef = useRef(options.replaceDocument)
  const translateRef = useRef(t)
  const { path, store } = options

  useEffect(() => {
    titleRef.current = options.title
    replaceDocumentRef.current = options.replaceDocument
    translateRef.current = t
  }, [options.replaceDocument, options.title, t])

  useEffect(() => {
    setState(INITIAL_STATE)
    const session = new BoardDocumentSession(path, store, {
      load: (replica) => replaceDocumentRef.current({ replica }),
      title: () => titleRef.current,
      onState: setState,
      closedSaveFailed: (reason) => notify.error(
        translateRef.current('whiteboard.file.closeSaveFailed', { title: titleRef.current }),
        {
          description: isBoardSaveConflict(reason)
            ? translateRef.current('whiteboard.file.saveConflict')
            : message(reason),
        },
      ),
    })
    sessionRef.current = session
    session.start()
    return () => {
      session.dispose()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [path, store])

  const startNewBoard = useCallback(() => {
    void sessionRef.current?.startNewBoard()
  }, [])

  const reload = useCallback(() => {
    void sessionRef.current?.reload()
  }, [])

  return { ...state, reload, startNewBoard }
}
