/**
 * One open Markdown document: its KDM replica (through the document store), guarded saves of the
 * `.md` file, merges of what other writers put in the file, and the editors bound to it. Mirrors
 * the Board session (`useBoardDocument`): file operations run one at a time, a save conflict
 * merges the file and writes again (at most three writes), failures retry with backoff, and a
 * flush on close, path change, workspace flush, or unload writes the newest edit.
 */
import { isolateHistory } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'
import { VersionVector } from 'loro-crdt'
import { agent, person, randomActor, type Origin, type Replica, type Version } from '@/lib/kdm'
import { readWorkspaceDocument, subscribeWorkspaceDocumentExternalChanges, type WorkspaceDocumentExternalChange } from '@/services/desktop'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'
import { TextBinding } from './codeMirrorBinding'
import { documentHistoryExtension, type DocumentHistory } from './documentHistory'
import { applyTextEdits, diffText } from './documentMerge'
import { DOCUMENT_BODY } from './documentSchema'
import { mergeFileIntoReplica, openDocument, saveDocument, type OpenedDocument } from './documentStore'
import { analyzeText, documentBody, renderText } from './documentText'

/** The principal of edits made in this window. */
export const LOCAL_PERSON = 'user:local'
/** The principal of agent edits applied to an open document. */
const LOCAL_AGENT = 'agent:kition'

/** Origin of typing and commands in an editor. */
const typingOrigin: Origin = person(LOCAL_PERSON, 'typing')

type DocumentSessionStatus = 'loading' | 'ready' | 'saving' | 'error'

export type DocumentSessionState = {
  status: DocumentSessionStatus
  /** The last open or save failure, as reported. */
  error: string
  /** The replica holds edits the file does not have yet. */
  dirty: boolean
}

export type DocumentSessionHost = {
  /**
   * Whether a change of the file on disk is left to the review flow (an agent proposal) instead
   * of being merged now. The session then expects the review to settle it (`acceptFileText`).
   */
  holdsExternalChange?: (path: string) => boolean
  /** The file now holds `fileText` (a save of this session). */
  onSaved?: (path: string, fileText: string) => void
  /** The save made when the session closed failed; it keeps retrying. */
  closedSaveFailed?: (path: string, reason: unknown) => void
  /**
   * Rewrites the text before a save (temporary `blob:` image links become workspace assets).
   * Answers the text unchanged when there is nothing to rewrite; a failure leaves it for the next save.
   */
  prepareSave?: (text: string, path: string) => Promise<string>
}

/** Debounce of saves after an edit. */
export const SAVE_DELAY_MS = 300
/** Typing within this delay of the previous keystroke stays in one undo step (CodeMirror's `newGroupDelay`). */
export const TYPING_GROUP_MS = 500
/** Retries after a failed save; edits start new attempts as well. */
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const
/** Writes per save, each after merging the file a conflict showed changed. */
const MAX_SAVE_ATTEMPTS = 3
/** The guarded write's refusal (the file is not what this session last read or wrote). */
const SAVE_CONFLICT = 'DESIGN_SAVE_CONFLICT'
const NOT_SAVED = 'DOCUMENT_NOT_SAVED'

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
const asError = (reason: unknown) => (reason instanceof Error ? reason : new Error(message(reason)))

/** Whether a save failure is the guarded write's conflict refusal. */
export function isDocumentSaveConflict(reason: unknown) {
  return message(reason).includes(SAVE_CONFLICT)
}

type TypingKind = 'type' | 'delete'

function typingKind(transaction: Transaction): TypingKind | null {
  const event = transaction.annotation(Transaction.userEvent)
  if (!event) return null
  if (event.startsWith('input.type')) return 'type'
  if (event === 'delete.backward' || event === 'delete.forward' || event === 'delete') return 'delete'
  return null
}

export class DocumentSession {
  private pathValue: string
  private readonly root: string
  private opened: OpenedDocument | null = null
  /** The file text as last read or written: what the next guarded write expects on disk. */
  private fileText: string | null = null
  /** The replica version the file holds, or `null` when it holds an older text. */
  private savedVersion: Version | null = null
  private state: DocumentSessionState = { status: 'loading', error: '', dirty: false }
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  private saveRun: Promise<void> | null = null
  private flushRequested = false
  private saveFailure: Error | null = null
  /** Above zero while this session changes the replica itself (merges): not an edit to save. */
  private importing = 0
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private discarded = false
  private readonly cleanups: Array<() => void> = []
  private unregisterFlush: (() => void) | null = null
  private readonly textListeners = new Set<(text: string) => void>()
  private readonly stateListeners = new Set<(state: DocumentSessionState) => void>()
  private readonly bindings = new Set<TextBinding>()
  /** The open typing undo group, if any. */
  private typing: { kind: TypingKind; at: number; timer: ReturnType<typeof setTimeout> } | null = null
  readonly history: DocumentHistory = {
    undo: () => this.undo(),
    redo: () => this.redo(),
  }

  constructor(
    path: string,
    options: { root: string },
    private readonly host: DocumentSessionHost = {},
  ) {
    this.pathValue = path
    this.root = options.root
  }

  get path() {
    return this.pathValue
  }

  get replica(): Replica | null {
    return this.opened?.replica ?? null
  }

  getState() {
    return this.state
  }

  /** Whether the replica is open for editing. */
  isReady() {
    return this.opened !== null
  }

  /**
   * Opens the replica for the file text `fileText` (just read from disk) and starts following
   * the file. Rejects when the store cannot open it; the session is then unusable.
   */
  async start(fileText: string): Promise<void> {
    const opened = await openDocument(this.pathValue, fileText, randomActor(), { expectedRoot: this.root })
    if (this.disposed) return
    this.opened = opened
    this.fileText = opened.fileText
    this.savedVersion = this.rendered() === opened.fileText ? opened.replica.version() : null
    this.cleanups.push(opened.replica.subscribeText(opened.rootId, DOCUMENT_BODY, () => this.onReplicaChange()))
    this.cleanups.push(subscribeWorkspaceDocumentExternalChanges(this.onExternalChange))
    this.registerFlush()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!this.hasUnsavedChanges()) return
      event.preventDefault()
      event.returnValue = ''
      void this.flush().catch(() => undefined)
    }
    window.addEventListener('beforeunload', beforeUnload)
    this.cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload))
    this.setState({ status: 'ready', error: '', dirty: this.isDirty() })
    // The store held edits the file does not have (or the open merged a file change): save them.
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  /** The document text the editors show (`\n` line endings, no byte order mark). */
  text(): string {
    return this.opened ? documentBody(this.opened.replica, this.opened.rootId) : ''
  }

  /** The text the file would hold if saved now: the live text, unsaved edits included. */
  read(): string {
    return this.opened ? this.rendered() : (this.fileText ?? '')
  }

  /** The file text as this session last read or wrote it. */
  savedText(): string | null {
    return this.fileText
  }

  subscribeText(listener: (text: string) => void) {
    this.textListeners.add(listener)
    return () => {
      this.textListeners.delete(listener)
    }
  }

  subscribeState(listener: (state: DocumentSessionState) => void) {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /**
   * A binding for one editor view: add `binding.extension` and `historyExtension()` to the
   * editor, created with `text()` as its document. Dispose it when the editor goes away.
   */
  createBinding(): TextBinding {
    const opened = this.requireOpened()
    const binding = new TextBinding(opened.replica, opened.rootId, DOCUMENT_BODY, typingOrigin, {
      beforeLocal: (transaction) => this.beforeLocal(transaction),
    })
    this.bindings.add(binding)
    return binding
  }

  releaseBinding(binding: TextBinding) {
    if (!this.bindings.delete(binding)) return
    binding.dispose()
  }

  historyExtension() {
    return documentHistoryExtension(this.history)
  }

  /**
   * Replaces the document text by `next` as the smallest text edits, in one transaction with
   * `origin` (one undo step). Every whole-text setter (a dialog's result, an import, a restore, an
   * agent's text) goes through here, never through the editor's value. Answers whether it changed.
   */
  replaceText(next: string, origin: Origin): boolean {
    const opened = this.requireOpened()
    const target = analyzeText(next).text
    const current = this.text()
    if (current === target) return false
    this.endTyping()
    const edits = diffText(current, target)
    opened.replica.transact(origin, (tx) => applyTextEdits(tx, opened.rootId, DOCUMENT_BODY, edits))
    return true
  }

  /** Applies an agent's whole new file text as one agent-origin undo step, saves, and answers the saved file text. */
  async applyAgentContent(content: string, meta: { tool: string; turnId?: string }): Promise<{ applied: boolean; content?: string; reason?: string }> {
    if (!this.opened) return { applied: false, reason: 'not-open' }
    this.replaceText(content, agent(LOCAL_AGENT, meta.tool || 'agent'))
    await this.flush()
    return { applied: true, content: this.fileText ?? this.read() }
  }

  undo(): boolean {
    if (!this.opened) return false
    this.endTyping()
    return this.opened.replica.undo()
  }

  redo(): boolean {
    if (!this.opened) return false
    this.endTyping()
    return this.opened.replica.redo()
  }

  /** The file was renamed or moved to `path` (already on disk): saves go there now. */
  setPath(path: string) {
    if (path === this.pathValue) return
    this.pathValue = path
    if (this.unregisterFlush) this.registerFlush()
  }

  /**
   * Settles a file change the review flow held back (`holdsExternalChange`): the file now holds
   * `fileText` (the proposal); the document text becomes `text` (what the reviewer kept) as one
   * agent-origin undo step, so undo returns to the text before the proposal. Saves the result
   * unless the file already holds it.
   */
  acceptReviewedText(fileText: string, text: string, label = 'review'): Promise<void> {
    return this.enqueue(async () => {
      const opened = this.opened
      if (!opened || this.disposed) return
      this.fileText = fileText
      opened.style = analyzeText(fileText).style
      this.savedVersion = null
      this.replaceText(text, agent(LOCAL_AGENT, label))
      if (this.rendered() === fileText) this.savedVersion = opened.replica.version()
      this.setState({ dirty: this.isDirty() })
    }).then(() => this.flush())
  }

  /** Merges what the file holds now (after another writer changed it); local edits are kept. */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow())
  }

  /** Whether leaving now could lose an edit: a save is running, or the replica is not saved. */
  hasUnsavedChanges() {
    if (this.discarded) return false
    if (this.saveRun) return true
    return this.isDirty()
  }

  isDirty() {
    if (!this.opened || this.discarded) return false
    return this.savedVersion === null || !this.opened.replica.version().equals(this.savedVersion)
  }

  /**
   * Saves a pending change now. Resolves once every edit made before the call is in the file;
   * rejects when it is not (the write failed).
   */
  readonly flush = async (): Promise<void> => {
    if (this.discarded || !this.opened) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const target = this.opened.replica.version()
    if (this.saveRun) {
      this.flushRequested = true
      await this.saveRun
    } else {
      await this.enqueue(() => this.save())
    }
    if (this.discarded) return
    if (this.savedVersion && this.includes(this.savedVersion, target)) return
    if (!this.isDirty()) return
    throw this.saveFailure ?? new Error(NOT_SAVED)
  }

  /** Drops the edits not saved yet: stops saving and retrying, and never writes again. */
  readonly discard = () => {
    this.discarded = true
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.flushRequested = false
    this.setState({ dirty: false })
  }

  /**
   * Saves a pending change now, then stops following the file and the editors. A final write
   * that fails is reported to the host and retried with the usual backoff.
   */
  dispose() {
    if (this.disposed) return
    const final = this.flush()
    this.disposed = true
    this.endTyping()
    for (const binding of this.bindings) binding.dispose()
    this.bindings.clear()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.unregisterFlush = null
    this.textListeners.clear()
    this.stateListeners.clear()
    final.catch((reason: unknown) => this.host.closedSaveFailed?.(this.pathValue, reason))
  }

  // --- internals ---------------------------------------------------------

  private requireOpened(): OpenedDocument {
    if (!this.opened) throw new Error('The document is not open.')
    return this.opened
  }

  private rendered() {
    const opened = this.requireOpened()
    return renderText(documentBody(opened.replica, opened.rootId), opened.style)
  }

  private registerFlush() {
    // Deleted from the cleanups when re-registered under a new path.
    const previous = this.unregisterFlush
    if (previous) {
      previous()
      const index = this.cleanups.indexOf(previous)
      if (index >= 0) this.cleanups.splice(index, 1)
    }
    const unregister = registerWorkspaceEditSession(this.flush, this.pathValue, { discard: this.discard })
    this.unregisterFlush = unregister
    this.cleanups.push(unregister)
  }

  /** Groups typing like CodeMirror's history: a run of keystrokes of one kind undoes as one step. */
  private beforeLocal(transaction: Transaction) {
    const replica = this.opened?.replica
    if (!replica) return
    const kind = typingKind(transaction)
    const isolated = transaction.annotation(isolateHistory) !== undefined
    const now = Date.now()
    const typing = this.typing
    if (typing && (isolated || kind !== typing.kind || now - typing.at > TYPING_GROUP_MS)) this.endTyping()
    if (!kind || isolated) return
    if (!this.typing) {
      try {
        replica.beginUndoGroup()
      } catch {
        return
      }
      this.typing = { kind, at: now, timer: setTimeout(() => this.endTyping(), TYPING_GROUP_MS) }
      return
    }
    clearTimeout(this.typing.timer)
    this.typing.at = now
    this.typing.timer = setTimeout(() => this.endTyping(), TYPING_GROUP_MS)
  }

  private endTyping() {
    const typing = this.typing
    if (!typing) return
    this.typing = null
    clearTimeout(typing.timer)
    try {
      this.opened?.replica.endUndoGroup()
    } catch {
      // The group was ended by the replica (an undo) already.
    }
  }

  private onReplicaChange() {
    if (this.disposed) return
    const text = this.text()
    for (const listener of this.textListeners) listener(text)
    if (this.importing > 0) return
    // A new edit starts new save attempts.
    this.retries = 0
    this.setState({ dirty: this.isDirty() })
    if (this.saveRun) return
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  private readonly onExternalChange = (change: WorkspaceDocumentExternalChange) => {
    if (this.disposed || change.path !== this.pathValue || change.eventType === 'unlink') return
    if (this.host.holdsExternalChange?.(this.pathValue)) return
    void this.reconcile()
  }

  private async reconcileNow() {
    if (this.disposed || !this.opened || this.fileText === null) return
    let text: string
    try {
      text = (await readWorkspaceDocument(this.pathValue)).content
    } catch {
      return
    }
    if (this.disposed || text === this.fileText) return
    try {
      this.mergeFile(text)
    } catch (reason) {
      this.failed(reason)
      return
    }
    this.setState({ dirty: this.isDirty() })
    if (this.isDirty() && this.saveTimer === undefined && !this.saveRun) this.schedule(SAVE_DELAY_MS)
  }

  /** Merges the file text `text` into the replica (import origin) and makes it the file this session expects. */
  private mergeFile(text: string) {
    const opened = this.requireOpened()
    if (text !== this.fileText) {
      this.importing += 1
      try {
        // Both raw file texts: the base is the file as this session last read or wrote it.
        mergeFileIntoReplica(opened, this.fileText ?? '', text)
      } finally {
        this.importing -= 1
      }
      this.fileText = text
      opened.style = analyzeText(text).style
    }
    if (this.rendered() === text) this.savedVersion = opened.replica.version()
  }

  private save(): Promise<void> {
    const run: Promise<void> = Promise.resolve().then(async () => {
      this.saveFailure = null
      try {
        await this.saveAttempts()
      } catch (reason) {
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
    const opened = this.opened
    if (!opened || this.fileText === null) return
    await this.prepare()
    for (let attempt = 1; ; attempt += 1) {
      if (this.discarded) return
      if (!this.isDirty()) {
        if (this.state.status === 'saving') this.setState({ status: 'ready', dirty: false })
        return
      }
      const version = opened.replica.version()
      this.setState({ status: 'saving', error: '' })
      let saved: { fileText: string; meta: OpenedDocument['meta'] }
      try {
        saved = await saveDocument({
          path: this.pathValue,
          opened,
          expectedFileText: this.fileText,
          expectedRoot: this.root,
          onStoreError: (error) => console.warn('[document] store write failed', error),
        })
      } catch (reason) {
        if (!isDocumentSaveConflict(reason) || attempt >= MAX_SAVE_ATTEMPTS) {
          this.failed(reason)
          return
        }
        let current: string
        try {
          current = (await readWorkspaceDocument(this.pathValue)).content
        } catch (readFailure) {
          this.failed(readFailure)
          return
        }
        this.mergeFile(current)
        continue
      }
      this.fileText = saved.fileText
      opened.meta = saved.meta
      this.savedVersion = version
      this.retries = 0
      clearTimeout(this.retryTimer)
      this.setState({ status: 'ready', error: '', dirty: this.isDirty() })
      this.host.onSaved?.(this.pathValue, saved.fileText)
      if (!this.isDirty()) return
      if (this.flushRequested) {
        this.flushRequested = false
        attempt = 0
        continue
      }
      if (this.saveTimer === undefined) this.schedule(SAVE_DELAY_MS)
      return
    }
  }

  /** Lets the host rewrite the text before it is written, as one edit, unless the text changed meanwhile. */
  private async prepare() {
    const prepareSave = this.host.prepareSave
    if (!prepareSave || !this.opened) return
    const text = this.text()
    let next: string
    try {
      next = await prepareSave(text, this.pathValue)
    } catch {
      return
    }
    if (next === text || this.disposed || this.text() !== text) return
    this.replaceText(next, person(LOCAL_PERSON, 'save'))
  }

  /** Whether the version `saved` holds every change of `target`. */
  private includes(saved: Version, target: Version) {
    const order = VersionVector.decode(saved.encode()).compare(VersionVector.decode(target.encode()))
    return order === 0 || order === 1
  }

  /** A save failed: show it and retry with backoff (also after the editor closed, for the final write). */
  private failed(reason: unknown) {
    if (this.discarded) return
    this.saveFailure = asError(reason)
    this.setState({ status: 'error', error: message(reason), dirty: this.isDirty() })
    if (this.retries >= RETRY_DELAYS_MS.length) return
    const delay = RETRY_DELAYS_MS[this.retries]
    this.retries += 1
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.flush().catch(() => undefined)
    }, delay)
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

  private setState(patch: Partial<DocumentSessionState>) {
    const next = { ...this.state, ...patch }
    if (next.status === this.state.status && next.error === this.state.error && next.dirty === this.state.dirty) return
    this.state = next
    if (this.disposed) return
    for (const listener of this.stateListeners) listener(next)
  }
}
