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
import { agent, ChangeAudit, person, randomActor, system, touchesOnlyComments, type Origin, type Replica, type TextDelta, type Tx, type Version } from '@/lib/kdm'
import { readWorkspaceDocument, subscribeWorkspaceDocumentExternalChanges, type WorkspaceDocumentExternalChange } from '@/services/desktop'
import { registerWorkspaceEditSession } from '@/services/workspaceEditSessions'
import { TextBinding } from '@kition/document-editor/model'
import { addAgentReviewMarks, agentReviewHighlight, agentReviewMarks, mapAgentReviewMarks, type AgentReviewMarks } from './documentAgentReview'
import { documentHistoryExtension, type DocumentHistory } from '@kition/document-editor/model'
import { applyTextEdits, diffText, mergeEdits } from '@kition/document-editor/model'
import { registerOpenMarkdownDocument } from './openDocumentSessions'
import { DOCUMENT_BODY } from '@kition/document-editor/model'
import { compactStoredDocument, mergeFileIntoReplica, openDocument, saveDocument, type OpenedDocument } from './documentStore'
import { recordDocumentCheckpoint, type DocumentCheckpointInput } from '@/services/desktop'
import { analyzeText, createDocumentReplica, documentBody, renderText, repairCommentThreads } from '@kition/document-editor/model'

/** The principal of edits made in this window. */
export const LOCAL_PERSON = 'user:local'
/** The principal of agent edits applied to an open document. */
const LOCAL_AGENT = 'agent:kition'

/** Origin of the rewrite before a save (temporary image links to assets): not an undo step. */
const SAVE_REWRITE_ORIGIN: Origin = system('save')
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

/**
 * An agent's edit of the open document, already in the text (and saved), that the person has not
 * accepted or rejected yet. Several edits before a decision are reviewed together.
 */
export type DocumentAgentReview = {
  /** The text before the first edit under review. */
  before: string
  /** The text right after the newest edit under review. */
  after: string
  /** What the edits changed, positioned in the current text. */
  marks: AgentReviewMarks
  /** The agent tool that made the newest edit (`file` for a file change merged on open). */
  tool: string
  turnId?: string
}

type AgentReviewState = DocumentAgentReview & {
  /** The undo steps of the agent's edits under review (none for a change merged on open). */
  groups: number
  /** Nothing else changed the text since the newest edit: undo takes the edits back exactly. */
  untouched: boolean
}

export type DocumentSessionHost = {
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
/** While editing, a save records a checkpoint in the document's version history at most this often. */
const CHECKPOINT_EVERY_MS = 5 * 60_000
/** The replica's version as the store's history records it (lowercase hex). */
function versionHex(replica: Replica): string {
  let out = ''
  for (const byte of replica.version().encode()) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Records a checkpoint in the document's history; best effort, never in the way of editing. */
function recordCheckpoint(docId: string, input: DocumentCheckpointInput, root: string) {
  try {
    void recordDocumentCheckpoint(docId, input, { expectedRoot: root }).catch(() => undefined)
  } catch {
    // No store to record in.
  }
}

/** The origin of restoring a version from the history: one undo step of the person's. */
const restoreOrigin: Origin = person(LOCAL_PERSON, 'restore')
/** Writes per save, each after merging the file a conflict showed changed. */
const MAX_SAVE_ATTEMPTS = 3
/** The guarded write's refusal (the file is not what this session last read or wrote). */
const SAVE_CONFLICT = 'DESIGN_SAVE_CONFLICT'
const NOT_SAVED = 'DOCUMENT_NOT_SAVED'
const NO_WORKSPACE_ROOT = 'The workspace folder is not known, so the document cannot be saved safely.'
/** The store's refusal when the workspace switched to another folder meanwhile. */
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
const asError = (reason: unknown) => (reason instanceof Error ? reason : new Error(message(reason)))

/** The error of a session whose file was deleted (or moved away) outside Kition. */
const FILE_MISSING = 'DOCUMENT_FILE_MISSING'

/** Whether a failure says the file is gone: the session keeps the text and can recreate the file (`recreate`). */
export function isDocumentFileMissing(reason: unknown) {
  return message(reason).includes(FILE_MISSING)
}

/** Whether reading the file failed because there is no file (the shells' and the browser store's wording). */
function isNotFound(reason: unknown) {
  return /not found|no such file|cannot find|os error 2\b/i.test(message(reason))
}

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
  /** The file is gone (deleted or moved outside Kition): saves wait for `recreate`. */
  private fileMissing = false
  /** The next save writes the file again where it is missing (guarded: only while it is still missing). */
  private recreating = false
  /** Above zero while this session changes the replica itself (merges): not an edit to save. */
  private importing = 0
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private discarded = false
  private readonly cleanups: Array<() => void> = []
  private unregisterFlush: (() => void) | null = null
  private readonly textListeners = new Set<() => void>()
  /** Hear changes of the replica beyond the text: comment threads (rule M23), ours or merged. */
  private readonly commentListeners = new Set<() => void>()
  private readonly stateListeners = new Set<(state: DocumentSessionState) => void>()
  private readonly bindings = new Set<TextBinding>()
  /** The open typing undo group, if any. */
  private typing: { kind: TypingKind; at: number; timer: ReturnType<typeof setTimeout> } | null = null
  private review: AgentReviewState | null = null
  /** Set while the session applies an agent's edit (the edit does not touch its own review). */
  private applyingAgent = false
  private readonly reviewListeners = new Set<() => void>()
  /** Withdraws the document from the open documents (`openDocumentSessions.ts`). */
  private withdrawOpen: (() => void) | null = null
  /** When the last checkpoint was recorded; a save records the next one `CHECKPOINT_EVERY_MS` later. */
  private lastCheckpointAt = 0
  /** A checkpoint the next save records whenever it comes (an agent's edit). */
  private pendingCheckpoint: DocumentCheckpointInput | null = null
  /**
   * The comment steps a commenter made (their text is read-only, Kit Standard 2.0 rule M23): what
   * their Undo can take back and their Redo bring back. Nothing before them is theirs to undo.
   */
  private commentSteps = { undo: 0, redo: 0 }
  readonly history: DocumentHistory = {
    undo: () => this.undo(),
    redo: () => this.redo(),
    readOnlyUndo: () => this.commenterStep('undo'),
    readOnlyRedo: () => this.commenterStep('redo'),
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
    // Every write and read is guarded by the workspace root; without one, nothing could be saved safely.
    if (!this.root) throw new Error(NO_WORKSPACE_ROOT)
    const opened = await this.openReplica(fileText)
    if (this.disposed) return
    this.opened = opened
    this.fileText = opened.fileText
    this.savedVersion = this.holdsFileText(opened.fileText) ? opened.replica.version() : null
    this.cleanups.push(opened.replica.subscribeText(opened.rootId, DOCUMENT_BODY, (delta) => this.onReplicaChange(delta)))
    this.cleanups.push(subscribeWorkspaceDocumentExternalChanges(this.onExternalChange))
    this.registerFlush()
    this.announceOpen()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!this.hasUnsavedChanges()) return
      event.preventDefault()
      event.returnValue = ''
      void this.flush().catch(() => undefined)
    }
    window.addEventListener('beforeunload', beforeUnload)
    this.cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload))
    this.setState({ status: 'ready', error: '', dirty: this.isDirty() })
    this.checkpointOpened()
    // The store held edits the file does not have (or the open merged a file change): save them.
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
    // The file may have changed between its read and now (no change event reaches a session not yet open).
    void this.reconcile()
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

  /** Calls `listener` after every change of the text (read it with `text()`). */
  subscribeText(listener: () => void) {
    this.textListeners.add(listener)
    return () => {
      this.textListeners.delete(listener)
    }
  }

  /** Calls `listener` after the document's comment threads may have changed. */
  subscribeComments(listener: () => void) {
    this.commentListeners.add(listener)
    return () => {
      this.commentListeners.delete(listener)
    }
  }

  /**
   * Writes comment threads (Kit Standard 2.0 rule M23) in one transaction with `origin`: they are
   * beside the text, so the editors do not change, but the session saves the replica and
   * co-editing sends the change. Answers what `run` answered.
   */
  transactComments<R>(origin: Origin, run: (tx: Tx) => R, options: { commenter?: boolean } = {}): R {
    const { replica } = this.requireOpened()
    this.endTyping()
    const before = replica.version()
    const result = replica.transact(origin, run)
    // A commenter's comment is one step their Undo can take back; a new step drops what was undone.
    if (options.commenter && !replica.version().equals(before)) this.commentSteps = { undo: this.commentSteps.undo + 1, redo: 0 }
    this.afterReplicaChange()
    return result
  }

  /**
   * A commenter's Undo or Redo: only while their comments left a step to take, and only when the
   * step changes nothing but comments (as a sync server checks a commenter's push); a step that
   * would reach further is taken back and refused. Answers whether a comment step ran.
   */
  private commenterStep(what: 'undo' | 'redo'): boolean {
    const opened = this.opened
    if (!opened || this.commentSteps[what] === 0) return false
    this.endTyping()
    const { replica } = opened
    const before = replica.version()
    const audit = ChangeAudit.load(replica.exportChanges())
    if (!(what === 'undo' ? replica.undo() : replica.redo()) || replica.version().equals(before)) return false
    let comment = false
    try {
      comment = touchesOnlyComments(audit.touched(replica.exportChanges(before)))
    } catch {
      // A change that cannot be read is not taken as a comment.
    }
    if (!comment) {
      if (what === 'undo') replica.redo()
      else replica.undo()
      this.commentSteps = { undo: 0, redo: 0 }
      this.afterReplicaChange()
      return false
    }
    this.commentSteps = what === 'undo' ? { undo: this.commentSteps.undo - 1, redo: this.commentSteps.redo + 1 } : { undo: this.commentSteps.undo + 1, redo: this.commentSteps.redo - 1 }
    this.afterReplicaChange()
    return true
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

  /** Marks the agent's edit under review in an editor bound to this session. */
  agentReviewExtension() {
    return agentReviewHighlight(this)
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

  /**
   * Restores `text` (the document as it was at a checkpoint) as one change of the person's, one undo step, after
   * recording where the document was before it. Answers whether the text changed.
   */
  restoreText(text: string, label?: string): boolean {
    const opened = this.requireOpened()
    const before = versionHex(opened.replica)
    recordCheckpoint(opened.meta.docId, { origin: 'before-restore', author: LOCAL_PERSON, version: before }, this.root)
    const changed = this.replaceText(text, restoreOrigin)
    if (changed) {
      this.pendingCheckpoint = { origin: 'restore', author: LOCAL_PERSON, ...(label ? { label } : {}) }
      this.schedule(0)
    }
    return changed
  }

  /** The document's id in the store (its version history's). */
  storeId(): string | null {
    return this.opened?.meta.docId ?? null
  }

  /**
   * Applies `next`, a text made from the earlier text `base` (a dialog opened on it, an agent's edit
   * under review, a rewrite before a save), as a three-way merge onto the text as it is now: the
   * change `base → next` is applied and edits that reached the text since `base` (typing, merged
   * file changes) are kept — never a whole-text replacement. One transaction with `origin` (one
   * undo step for person and agent origins). Answers whether the text changed.
   */
  applyFrom(base: string, next: string, origin: Origin): boolean {
    const opened = this.requireOpened()
    const edits = mergeEdits(analyzeText(base).text, analyzeText(next).text, this.text())
    if (!edits.length) return false
    this.endTyping()
    opened.replica.transact(origin, (tx) => applyTextEdits(tx, opened.rootId, DOCUMENT_BODY, edits))
    return true
  }

  /**
   * Applies an agent's whole new file text as one agent-origin undo step, shows it for review
   * (`agentReview`), saves, and answers the saved file text.
   */
  async applyAgentContent(content: string, meta: { tool: string; turnId?: string }): Promise<{ applied: boolean; content?: string; reason?: string }> {
    if (!this.opened) return { applied: false, reason: 'not-open' }
    const before = this.text()
    let changed: boolean
    this.applyingAgent = true
    try {
      changed = this.replaceText(content, agent(LOCAL_AGENT, meta.tool || 'agent'))
    } finally {
      this.applyingAgent = false
    }
    if (changed) this.pendingCheckpoint = { origin: 'agent', author: LOCAL_AGENT, ...(meta.tool ? { label: meta.tool } : {}) }
    if (changed) this.reviewEdit(before, meta, 1)
    await this.flush()
    return { applied: true, content: this.fileText ?? this.read() }
  }

  /** The agent's edit under review, if any. */
  agentReview(): DocumentAgentReview | null {
    return this.review
  }

  /** Called when a review starts, grows, or ends (not when its marks only moved with the text). */
  subscribeAgentReview(listener: () => void) {
    this.reviewListeners.add(listener)
    return () => {
      this.reviewListeners.delete(listener)
    }
  }

  /** Keeps the edit under review as it is. */
  acceptAgentReview() {
    this.setReview(null)
  }

  /** Takes the edit under review back (the person's edits since are kept) and saves. */
  rejectAgentReview(): Promise<void> {
    return this.review ? this.settleAgentReview(this.review.before) : Promise.resolve()
  }

  /**
   * Ends the review with `text` as what the reviewer kept of the edit (`before` with some of its
   * changes), applied to the current text so that the person's edits since are kept, and saves.
   * When nothing else changed the text since the edit, rejecting it all undoes the agent's steps.
   */
  async settleAgentReview(text: string): Promise<void> {
    const review = this.review
    const opened = this.opened
    if (!review || !opened) return
    if (text !== review.after) {
      this.endTyping()
      if (text === review.before && review.untouched && review.groups > 0) {
        // The agent's steps are its own undo scope (KitModel 1.1 M12a): take them back there.
        for (let step = 0; step < review.groups; step += 1) opened.replica.undoIn('agent')
      } else {
        // Three-way: only what the reviewer took back changes; edits that reached the text since stay.
        this.applyFrom(review.after, text, person(LOCAL_PERSON, 'review'))
      }
    }
    if (this.review === review) this.setReview(null)
    await this.flush()
  }

  /**
   * Shows what the file change merged when the document opened (the agent wrote the file while
   * it was closed) as an edit under review. Answers whether there was such a change.
   */
  reviewOpenMerge(): boolean {
    const opened = this.opened
    if (!opened?.merged || opened.previousText === undefined || this.review) return false
    if (opened.previousText === this.text()) return false
    this.reviewEdit(opened.previousText, { tool: 'file' }, 0)
    return true
  }

  undo(): boolean {
    if (!this.opened) return false
    this.endTyping()
    const review = this.review
    // The person's Undo keeps the agent's steps (KitModel 1.1 M12a), except while the agent's edit is
    // under review and the text is still what it made (nothing changed since, or the person undid
    // what they changed): then Undo takes back the agent's newest step, in the agent's scope, as the
    // review's own way to take the edit back.
    const exact = Boolean(review && review.groups > 0 && (review.untouched || this.text() === review.after))
    const undone = this.opened.replica.undoIn(exact ? 'agent' : 'person')
    if (undone && review && this.review === review) this.afterUndo(review, exact)
    return undone
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
    if (this.withdrawOpen) this.announceOpen()
  }

  /**
   * Imports changes another replica of this document made (a co-editor's): the editors show them
   * like a merged file change, they are no undo step, and the session saves them to the file.
   */
  importRemoteChanges(changes: Uint8Array) {
    const opened = this.requireOpened()
    const before = opened.replica.version()
    opened.replica.importChanges(changes)
    if (opened.replica.version().equals(before)) return
    // Concurrent comment commands can leave a thread without comments, or a reply in a deleted thread.
    opened.replica.transact(system('repair'), (tx) => repairCommentThreads(tx))
    // A change beside the text (a comment) reaches no text listener: save and show it too.
    this.afterReplicaChange()
  }

  /** The replica changed beyond what the text listeners heard: tell comment listeners, and save. */
  private afterReplicaChange() {
    if (this.disposed) return
    for (const listener of [...this.commentListeners]) listener()
    this.retries = 0
    this.setState({ dirty: this.isDirty() })
    if (this.saveRun) return
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  /** Merges what the file holds now (after another writer changed it); local edits are kept. */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow())
  }

  /**
   * Writes the document's text to its path again after its file was deleted outside Kition. The write
   * expects no file there: a file that appeared meanwhile is merged first, never overwritten. Rejects
   * like `flush` when the text is not saved.
   */
  async recreate(): Promise<void> {
    if (!this.fileMissing) return this.flush()
    this.recreating = true
    try {
      await this.flush()
    } finally {
      this.recreating = false
    }
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
    const opened = this.opened
    const root = this.root
    // The final save, then the change log folded into a snapshot (a clean close compacts the store).
    const final = this.flush().then(() => {
      if (opened && !this.discarded) void compactStoredDocument(opened, { expectedRoot: root })
    })
    this.disposed = true
    this.endTyping()
    for (const binding of this.bindings) binding.dispose()
    this.bindings.clear()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.unregisterFlush = null
    this.withdrawOpen = null
    this.textListeners.clear()
    this.commentListeners.clear()
    this.stateListeners.clear()
    this.reviewListeners.clear()
    final.catch((reason: unknown) => this.host.closedSaveFailed?.(this.pathValue, reason))
  }

  // --- internals ---------------------------------------------------------

  /**
   * The document's replica from the store. The `.md` file is the document and the store only adds
   * history, so when the store fails (a damaged entry, an unexpected error) the file is imported
   * as a new replica and edited without history; its saves still go through the guarded write.
   * A workspace that switched meanwhile is not such a failure: the open is refused.
   */
  private async openReplica(fileText: string): Promise<OpenedDocument> {
    const actor = randomActor()
    try {
      return await openDocument(this.pathValue, fileText, actor, { expectedRoot: this.root })
    } catch (reason) {
      if (message(reason).includes(WORKSPACE_CHANGED)) throw reason
      console.warn('[document] the replica store could not open this document; editing it without its history', reason)
      const { replica, rootId, style } = createDocumentReplica(fileText, actor)
      const meta: OpenedDocument['meta'] = { docId: replica.docId, kit: 'kit.document', path: this.pathValue, fileHash: '', fileStamp: null, exported: '', style: { ...style } }
      return { replica, rootId, meta, style, fileText, isNew: true, merged: false }
    }
  }

  private requireOpened(): OpenedDocument {
    if (!this.opened) throw new Error('The document is not open.')
    return this.opened
  }

  private rendered() {
    const opened = this.requireOpened()
    return renderText(documentBody(opened.replica, opened.rootId), opened.style)
  }

  /** Runs and forgets the cleanup `previous` (a registration under the old path), if any. */
  private dropCleanup(previous: (() => void) | null) {
    if (!previous) return
    previous()
    const index = this.cleanups.indexOf(previous)
    if (index >= 0) this.cleanups.splice(index, 1)
  }

  private registerFlush() {
    this.dropCleanup(this.unregisterFlush)
    const unregister = registerWorkspaceEditSession(this.flush, this.pathValue, { discard: this.discard })
    this.unregisterFlush = unregister
    this.cleanups.push(unregister)
  }

  /** Records where the document starts this session in its version history (best effort). */
  private checkpointOpened() {
    const opened = this.opened
    if (!opened || !opened.stored) return
    this.lastCheckpointAt = Date.now()
    recordCheckpoint(opened.meta.docId, { origin: 'open', author: LOCAL_PERSON, version: versionHex(opened.replica) }, this.root)
  }

  /** The checkpoint a save records now, if any: an agent's edit, or editing past `CHECKPOINT_EVERY_MS`. */
  private dueCheckpoint(): DocumentCheckpointInput | undefined {
    if (this.pendingCheckpoint) return this.pendingCheckpoint
    if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_EVERY_MS) return { origin: 'edit', author: LOCAL_PERSON }
    return undefined
  }

  /** Announces the document as open for editing under its current path (co-editing follows it). */
  private announceOpen() {
    this.dropCleanup(this.withdrawOpen)
    const withdraw = registerOpenMarkdownDocument({
      path: this.pathValue,
      replica: () => this.requireOpened().replica,
      importChanges: (changes) => this.importRemoteChanges(changes),
      subscribe: (listener) => {
        const stopText = this.subscribeText(listener)
        const stopComments = this.subscribeComments(listener)
        return () => {
          stopText()
          stopComments()
        }
      },
      save: () => this.flush(),
      storeId: () => this.storeId(),
      restoreText: (text, label) => this.restoreText(text, label),
    })
    this.withdrawOpen = withdraw
    this.cleanups.push(withdraw)
  }

  /** The text changed from `before` by an agent's edit (`groups` undo steps): starts or grows the review. */
  private reviewEdit(before: string, meta: { tool: string; turnId?: string }, groups: number) {
    const after = this.text()
    const current = this.review
    // Untouched since the earlier edits: the edits together are `before → after`.
    const marks = !current ? agentReviewMarks(before, after)
      : current.untouched ? agentReviewMarks(current.before, after)
        : addAgentReviewMarks(current.marks, agentReviewMarks(before, after))
    this.setReview({
      before: current?.before ?? before,
      after,
      marks,
      tool: meta.tool,
      ...(meta.turnId ? { turnId: meta.turnId } : {}),
      groups: (current?.groups ?? 0) + groups,
      untouched: current ? current.untouched : true,
    })
  }

  /** An undo while `review` lasts: it took back the newest agent step (`exact`), or maybe the last of them. */
  private afterUndo(review: AgentReviewState, exact: boolean) {
    const text = this.text()
    if (exact) {
      const groups = review.groups - 1
      if (groups <= 0) this.setReview(null)
      else this.setReview({ ...review, after: text, marks: agentReviewMarks(review.before, text), groups, untouched: true })
      return
    }
    // The edits are no longer in the text when taking them back would change nothing.
    if (mergeEdits(review.after, review.before, text).length === 0) this.setReview(null)
  }

  private setReview(review: AgentReviewState | null) {
    if (review === null && this.review === null) return
    this.review = review
    for (const listener of [...this.reviewListeners]) listener()
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

  private onReplicaChange(delta: TextDelta[]) {
    if (this.disposed) return
    const review = this.review
    if (review) {
      review.marks = mapAgentReviewMarks(review.marks, delta)
      if (!this.applyingAgent) review.untouched = false
    }
    // Listeners read the text when they need it: rendering it on every keystroke is not free.
    for (const listener of this.textListeners) listener()
    if (this.importing > 0) return
    // A new edit starts new save attempts.
    this.retries = 0
    this.setState({ dirty: this.isDirty() })
    if (this.saveRun) return
    if (this.isDirty()) this.schedule(SAVE_DELAY_MS)
  }

  private readonly onExternalChange = (change: WorkspaceDocumentExternalChange) => {
    if (this.disposed || change.path !== this.pathValue) return
    // A deletion is checked like any change: the read finds the file gone (or back already).
    void this.reconcile()
  }

  private async reconcileNow() {
    if (this.disposed || !this.opened || this.fileText === null) return
    let text: string
    try {
      text = (await readWorkspaceDocument(this.pathValue, this.root)).content
    } catch (reason) {
      if (!this.disposed && isNotFound(reason)) this.markMissing()
      return
    }
    if (this.disposed) return
    const wasMissing = this.fileMissing
    this.fileMissing = false
    if (wasMissing) this.setState({ status: 'ready', error: '' })
    if (text === this.fileText) {
      if (wasMissing && this.isDirty() && this.saveTimer === undefined && !this.saveRun) this.schedule(SAVE_DELAY_MS)
      return
    }
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
    if (this.holdsFileText(text)) this.savedVersion = opened.replica.version()
  }

  /**
   * Whether the replica holds what the file text `fileText` says: the same text, whatever its line
   * endings. A file with mixed (or lone CR) line endings is not rewritten in the normalised style
   * until a real edit is saved.
   */
  private holdsFileText(fileText: string) {
    return this.text() === analyzeText(fileText).text
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
    for (let attempt = 1; ; attempt += 1) {
      if (this.discarded) return
      // Before every write, also the ones a flush or a conflict starts: no temporary link reaches the file.
      await this.prepare()
      if (this.discarded) return
      if (!this.isDirty()) {
        if (this.state.status === 'saving') this.setState({ status: 'ready', dirty: false })
        return
      }
      if (this.fileMissing && !this.recreating) {
        // Writing over the old text's guard cannot succeed; the person decides (`recreate`).
        this.saveFailure = new Error(FILE_MISSING)
        return
      }
      const version = opened.replica.version()
      const recreate = this.fileMissing
      this.setState({ status: 'saving', error: '' })
      let saved: { fileText: string; meta: OpenedDocument['meta'] }
      const checkpoint = this.dueCheckpoint()
      try {
        saved = await saveDocument({
          path: this.pathValue,
          opened,
          ...(checkpoint ? { checkpoint } : {}),
          // `null`: the file must still be missing.
          expectedFileText: recreate ? null : this.fileText,
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
          current = (await readWorkspaceDocument(this.pathValue, this.root)).content
        } catch (readFailure) {
          if (isNotFound(readFailure)) this.markMissing()
          else this.failed(readFailure)
          return
        }
        // The file is there (again): merge it, and write over it guarded by what it holds.
        this.fileMissing = false
        this.mergeFile(current)
        continue
      }
      this.fileMissing = false
      this.fileText = saved.fileText
      opened.meta = saved.meta
      if (checkpoint) {
        this.lastCheckpointAt = Date.now()
        if (this.pendingCheckpoint === checkpoint) this.pendingCheckpoint = null
      }
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

  /**
   * Lets the host rewrite the text before it is written (temporary image links become assets). The
   * rewrite is merged three-way, so typing done meanwhile is kept, and it is not an undo step (undo
   * must never bring a temporary link back). It also runs for the final save of a closing session.
   */
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
    if (next === text || !this.opened) return
    this.importing += 1
    try {
      this.applyFrom(text, next, SAVE_REWRITE_ORIGIN)
    } finally {
      this.importing -= 1
    }
  }

  /** Whether the version `saved` holds every change of `target`. */
  private includes(saved: Version, target: Version) {
    const order = VersionVector.decode(saved.encode()).compare(VersionVector.decode(target.encode()))
    return order === 0 || order === 1
  }

  /** The file is gone: say so and stop retrying; the text stays here until it is recreated or discarded. */
  private markMissing() {
    if (this.discarded) return
    this.fileMissing = true
    this.saveFailure = new Error(FILE_MISSING)
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.setState({ status: 'error', error: FILE_MISSING, dirty: this.isDirty() })
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
    if (this.disposed || this.discarded || this.fileMissing) return
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
