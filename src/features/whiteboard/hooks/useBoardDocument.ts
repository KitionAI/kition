import { useCallback, useEffect, useRef, useState } from 'react'

import { randomActor, type Replica, type Version } from '@/lib/kdm'
import {
  createEmptyBoard,
  decodeBoardFile,
  encodeBoardFile,
  mergeBoardFile,
  readBoardFileCopy,
  replicaIncludes,
  type BoardFileCopy,
  type BoardFileProblem,
} from '@/features/whiteboard/kdm/boardKdmFile'
import type { BoardStore } from '@/features/whiteboard/lib/boardStore'
import {
  listWorkspaceDocuments,
  readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges,
  writeWorkspaceDocument,
  type WorkspaceDocumentExternalChange,
} from '@/services/desktop'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'

type BoardDocumentStatus = 'loading' | 'ready' | 'saving' | 'error'

type BoardDocumentState = {
  status: BoardDocumentStatus
  /** The last load or save failure, as reported. */
  error: string
  /** Why the file cannot be opened; the board is then read-only and never written. */
  problem: BoardFileProblem | null
  /** Why the file on disk can no longer be merged (it was replaced by something else); saving stops. */
  saveRefused: BoardFileProblem | null
}

/** Debounce of saves after an edit. */
const SAVE_DELAY_MS = 600
/** Retries after a failed save; edits start new attempts as well. */
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const
/** Writes per save, each after merging the file a conflict showed changed. */
const MAX_SAVE_ATTEMPTS = 3
/** The guarded write's refusal (the file is not what this session last read or wrote). */
const SAVE_CONFLICT = 'DESIGN_SAVE_CONFLICT'

const INITIAL_STATE: BoardDocumentState = { status: 'loading', error: '', problem: null, saveRefused: null }

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

type SessionHost = {
  /** Shows `replica` in the editor (it becomes the store's document). */
  load: (replica: Replica) => void
  title: () => string
  onState: (state: BoardDocumentState) => void
}

/**
 * One open `.kiboard` file: loads it into the store, saves the store's replica with guarded
 * writes, and merges what other writers put in the file. File operations (saves, merges, a new
 * board) run one at a time.
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
  private problem: BoardFileProblem | null = null
  private state = INITIAL_STATE
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  /** Set while `save` runs: it saves edits made meanwhile itself, or its retry does. */
  private saving = false
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly cleanups: Array<() => void> = []

  constructor(
    private readonly path: string,
    private readonly store: BoardStore,
    private readonly host: SessionHost,
  ) {}

  start() {
    this.cleanups.push(this.store.subscribe(this.onStoreChange))
    this.cleanups.push(subscribeWorkspaceDocumentExternalChanges(this.onExternalChange))
    this.cleanups.push(registerWorkspaceEditSession(this.flush, this.path))
    const beforeUnload = () => {
      void this.flush()
    }
    window.addEventListener('beforeunload', beforeUnload)
    this.cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload))
    void this.enqueue(() => this.load())
  }

  /** Saves a pending change now, then stops: no more saves, merges, or state updates. */
  dispose() {
    if (this.disposed) return
    void this.flush()
    this.disposed = true
    clearTimeout(this.retryTimer)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  /** Saves a pending change now; resolves when the file operations queued so far are done. */
  readonly flush = (): Promise<void> => {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    return this.enqueue(() => this.save())
  }

  /** Replaces a file that cannot be opened (except a newer Kition's board) with a new empty board. */
  startNewBoard() {
    return this.enqueue(async () => {
      const expected = this.fileText
      if (this.disposed || this.problem === null || this.problem === 'newer-version' || expected === null) return
      const text = encodeBoardFile(createEmptyBoard(this.host.title(), randomActor()))
      this.setState({ status: 'saving', error: '' })
      try {
        await writeWorkspaceDocument(this.path, text, { expected_root: this.root, expected_content: expected })
      } catch (reason) {
        if (this.disposed) return
        if (!isConflict(reason)) {
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
      if (!this.disposed) this.setState({ status: 'error', error: message(reason) })
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
    // A repair while the store adopts the replica changes it; the store's notification saves that.
    this.host.load(decoded.replica)
  }

  private readonly onStoreChange = () => {
    if (this.disposed || this.saving || !this.isLive()) return
    if (this.store.getSnapshot().isTransacting) {
      // A live gesture: save once it commits.
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      return
    }
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
    const refused = this.merge(replica, text)
    if (refused) {
      this.setState({ status: 'error', error: '', saveRefused: refused })
      return
    }
    if (this.state.saveRefused) this.setState({ status: 'ready', saveRefused: null })
    if (this.isDirty() && this.saveTimer === undefined) this.schedule(SAVE_DELAY_MS)
  }

  private async save() {
    this.saving = true
    try {
      await this.saveAttempts()
    } finally {
      this.saving = false
    }
  }

  private async saveAttempts() {
    const replica = this.replica
    if (!replica || this.problem || this.fileText === null) return
    for (let attempt = 1; ; attempt += 1) {
      if (!this.settleDeferred(replica)) {
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
        if (!isConflict(reason) || attempt >= MAX_SAVE_ATTEMPTS) {
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
          this.setState({ status: 'error', error: '', saveRefused: refused })
          return
        }
        continue
      }
      this.fileText = text
      this.fileVersion = version
      this.retries = 0
      clearTimeout(this.retryTimer)
      this.setState({ status: 'ready', error: '', saveRefused: null })
      if (this.isDirty() && this.saveTimer === undefined && !this.disposed) this.schedule(SAVE_DELAY_MS)
      return
    }
  }

  /**
   * Imports another copy of the board (file text) and makes it the file this session expects.
   * Answers why the text cannot be merged, or `null` when it was.
   */
  private merge(replica: Replica, text: string): BoardFileProblem | null {
    const copy = readBoardFileCopy(replica, text)
    if (!copy) {
      const decoded = decodeBoardFile(text, randomActor())
      return decoded.kind === 'unsupported' ? decoded.reason : 'not-a-board'
    }
    if (this.isLive()) {
      // Through the store, so the view is rebuilt; during a gesture it imports when the gesture ends.
      this.store.importChanges(copy.changes)
      if (!replicaIncludes(replica, copy.version)) this.deferred.push(copy)
    } else {
      mergeBoardFile(replica, text)
    }
    this.fileText = text
    this.fileVersion = copy.version
    return null
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

  private failed(reason: unknown) {
    this.setState({ status: 'error', error: message(reason) })
    if (this.disposed || this.retries >= RETRY_DELAYS_MS.length) return
    const delay = RETRY_DELAYS_MS[this.retries]
    this.retries += 1
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.flush()
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
    if (this.disposed) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
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

function isConflict(reason: unknown) {
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
  const [state, setState] = useState<BoardDocumentState>(INITIAL_STATE)
  const sessionRef = useRef<BoardDocumentSession | null>(null)
  const titleRef = useRef(options.title)
  const replaceDocumentRef = useRef(options.replaceDocument)
  const { path, store } = options

  useEffect(() => {
    titleRef.current = options.title
    replaceDocumentRef.current = options.replaceDocument
  }, [options.replaceDocument, options.title])

  useEffect(() => {
    setState(INITIAL_STATE)
    const session = new BoardDocumentSession(path, store, {
      load: (replica) => replaceDocumentRef.current({ replica }),
      title: () => titleRef.current,
      onState: setState,
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

  return { ...state, startNewBoard }
}
