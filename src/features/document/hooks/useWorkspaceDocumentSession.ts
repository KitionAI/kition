import type { Dispatch, SetStateAction } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { persistBlobImageLinks } from '@/features/document/lib/documentAssetPersistence'
import { inferDocumentPlatform, readWorkspaceDocumentDraft } from '@/features/document/lib/documentDraft'
import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import {
  applyDocumentRevisionDecisions,
  createDocumentRevisionComparison,
  remapPendingDocumentRevision,
  type DocumentRevisionDecision,
  type PendingDocumentRevision,
} from '@/features/document/lib/documentRevision'
import { DocumentSession, isDocumentSaveConflict, LOCAL_PERSON, type DocumentSessionState } from '@/features/document/kdm/documentSession'
import {
  findDocumentSession,
  getDocumentSession,
  listDocumentSessions,
  registerDocumentSession,
  remapDocumentSessions,
  unregisterDocumentSession,
} from '@/features/document/kdm/documentSessions'
import {
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
  isPreviewableWorkspaceFormat,
  remapWorkspaceBranchPath,
} from '@/features/workspace/lib/workspace'
import { updateWorkspaceTreeDocumentItem } from '@/features/workspace/lib/workspaceTree'
import { writeLastActiveDocumentPath } from '@/features/workspace/lib/workspacePersistence'
import { person } from '@/lib/kdm'
import { notify } from '@/lib/notify'
import {
  listWorkspaceDocuments,
  openWorkspaceFile,
  readWorkspaceDocument,
  subscribeWorkspaceDocumentExternalChanges,
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

type EditorMode = 'rich' | 'split' | 'source' | 'preview'
type AutoSaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

/** An open document tab's file: Markdown ones also have a `DocumentSession` in the registry. */
export type OpenedDocumentEntry = {
  document: WorkspaceDocument
  format: WorkspaceDocumentFormat
}

function normalizeDocumentRevisionPath(path: string) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function documentRevisionPathsMatch(firstPath: string, secondPath: string) {
  const first = normalizeDocumentRevisionPath(firstPath)
  const second = normalizeDocumentRevisionPath(secondPath)
  return Boolean(
    first
    && second
    && (
      first === second
      || first.endsWith(`/${second}`)
      || second.endsWith(`/${first}`)
    )
  )
}

const errorMessage = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason ?? ''))

type UseWorkspaceDocumentSessionOptions = {
  editorLocked: boolean
  editorMode: EditorMode
  files: WorkspaceDocumentTreeItem[]
  /** The workspace root (the guard of document saves); empty until the workspace is listed. */
  rootPath?: string
  isModifiedDocumentPath: (path: string) => boolean
  onClearModifiedDocumentPath: (path: string) => void
  onError: (message: string) => void
  onFeedback: (message: string) => void
  onOpenDocumentTab: (document: WorkspaceDocument) => void
  onOpenFileViewerTab: (path: string, format: WorkspaceDocumentFormat) => void
  onRequireMarkdownMode: () => void
  setTreeItems: Dispatch<SetStateAction<WorkspaceDocumentTreeItem[]>>
}

/** How long the published text (`draftContent`) may lag behind typing. */
const DRAFT_STATE_FLUSH_MS = 150

/**
 * The open documents of the workspace: which one is active, its text as published for the
 * workspace (word counts, previews, export), and the agent's proposals under review. Each open
 * Markdown document is a `DocumentSession` (its KDM replica, guarded saves, merged file changes)
 * kept in the session registry while its tab is open; editors bind to the session directly.
 */
export function useWorkspaceDocumentSession({
  editorMode,
  files,
  rootPath = '',
  isModifiedDocumentPath,
  onClearModifiedDocumentPath,
  onError,
  onFeedback,
  onOpenDocumentTab,
  onOpenFileViewerTab,
  onRequireMarkdownMode,
  setTreeItems,
}: UseWorkspaceDocumentSessionOptions) {
  const { t } = useTranslation(['document', 'common'])
  const [activeDocument, setActiveDocument] = useState<WorkspaceDocument | null>(null)
  const [activeResourcePath, setActiveResourcePath] = useState('')
  const [activeDocumentFormat, setActiveDocumentFormat] = useState<WorkspaceDocumentFormat>('markdown')
  const [activeDocumentSession, setActiveDocumentSession] = useState<DocumentSession | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState<DocumentPlatform>('page')
  const [saving, setSaving] = useState(false)
  const [documentRevisions, setDocumentRevisions] = useState<Record<string, PendingDocumentRevision>>({})
  const [revisionSavingPath, setRevisionSavingPath] = useState('')
  const [openedEntries, setOpenedEntries] = useState<Record<string, OpenedDocumentEntry>>({})
  /** Bumped when any open session's save state changes (tab modified marks, the save status). */
  const [, setSessionTick] = useState(0)

  const activeDocumentRef = useRef<WorkspaceDocument | null>(null)
  const activeDocumentFormatRef = useRef<WorkspaceDocumentFormat>('markdown')
  const activeSessionRef = useRef<DocumentSession | null>(null)
  const openedEntriesRef = useRef<Record<string, OpenedDocumentEntry>>({})
  const documentRevisionsRef = useRef<Record<string, PendingDocumentRevision>>({})
  const revisionSavingPathRef = useRef('')
  const externalRefreshVersionRef = useRef(0)
  const rootPathRef = useRef(rootPath)
  const isModifiedRef = useRef(isModifiedDocumentPath)
  const translateRef = useRef(t)
  /** The session whose text `draftContent` follows. */
  const publishedRef = useRef<{ session: DocumentSession; unsubscribe: () => void; timer: number | null } | null>(null)
  /** Unsubscribes from each open session's state. */
  const sessionWatchersRef = useRef(new Map<DocumentSession, () => void>())

  activeDocumentRef.current = activeDocument
  activeDocumentFormatRef.current = activeDocumentFormat
  documentRevisionsRef.current = documentRevisions
  revisionSavingPathRef.current = revisionSavingPath
  isModifiedRef.current = isModifiedDocumentPath
  translateRef.current = t
  if (rootPath) rootPathRef.current = rootPath

  const activeState: DocumentSessionState | null = activeDocumentSession?.getState() ?? null
  const hasUnsavedChanges = Boolean(activeDocumentSession?.isDirty())
  const autoSaveStatus: AutoSaveStatus = !activeState
    ? 'saved'
    : activeState.status === 'saving' ? 'saving'
      : activeState.status === 'error' ? 'error'
        : activeState.dirty ? 'dirty' : 'saved'
  const activeDocumentRevision = activeDocument
    ? documentRevisions[activeDocument.path] || null
    : null

  function updateEntries(update: (current: Record<string, OpenedDocumentEntry>) => Record<string, OpenedDocumentEntry>) {
    const next = update(openedEntriesRef.current)
    if (next === openedEntriesRef.current) return
    openedEntriesRef.current = next
    setOpenedEntries(next)
  }

  function updateDocumentRevisions(
    update: (current: Record<string, PendingDocumentRevision>) => Record<string, PendingDocumentRevision>,
  ) {
    setDocumentRevisions((current) => {
      const next = update(current)
      documentRevisionsRef.current = next
      return next
    })
  }

  // --- the published text ----------------------------------------------------

  function stopPublishing() {
    const published = publishedRef.current
    if (!published) return
    published.unsubscribe()
    if (published.timer !== null) window.clearTimeout(published.timer)
    publishedRef.current = null
  }

  function publishSession(session: DocumentSession | null) {
    if (publishedRef.current?.session === session) return
    stopPublishing()
    activeSessionRef.current = session
    setActiveDocumentSession(session)
    if (!session) return
    setDraftContent(session.text())
    const published = {
      session,
      timer: null as number | null,
      unsubscribe: session.subscribeText(() => {
        if (published.timer !== null) return
        published.timer = window.setTimeout(() => {
          published.timer = null
          if (publishedRef.current !== published) return
          startTransition(() => setDraftContent(session.text()))
        }, DRAFT_STATE_FLUSH_MS)
      }),
    }
    publishedRef.current = published
  }

  // --- sessions ----------------------------------------------------------------

  function watchSession(session: DocumentSession) {
    const toastId = () => `doc-autosave:${session.path}`
    const unsubscribe = session.subscribeState((state) => {
      setSessionTick((tick) => tick + 1)
      if (state.status === 'error') {
        notify.persistentError(translateRef.current('document:autosave.failed'), {
          label: translateRef.current('common:actions.retry'),
          onClick: () => void session.flush().catch(() => undefined),
        }, {
          id: toastId(),
          description: isDocumentSaveConflict(state.error)
            ? translateRef.current('document:session.saveConflict')
            : state.error || translateRef.current('document:autosave.failed'),
        })
      } else if (state.status === 'ready') {
        notify.dismiss(toastId())
      }
    })
    sessionWatchersRef.current.set(session, unsubscribe)
  }

  function closeSession(session: DocumentSession) {
    sessionWatchersRef.current.get(session)?.()
    sessionWatchersRef.current.delete(session)
    if (publishedRef.current?.session === session) publishSession(null)
    unregisterDocumentSession(session)
    session.dispose()
  }

  function createSession(document: WorkspaceDocument): DocumentSession {
    const session = new DocumentSession(document.path, { root: rootPathRef.current }, {
      holdsExternalChange: (path) => isModifiedRef.current(path) || Boolean(documentRevisionsRef.current[path]),
      onSaved: (path, fileText) => {
        const updated_at = new Date().toISOString()
        const entry = openedEntriesRef.current[path]
        const saved: WorkspaceDocument = { ...(entry?.document ?? document), path, content: fileText, updated_at, size: fileText.length }
        updateEntries((current) => (current[path] ? { ...current, [path]: { ...current[path], document: saved } } : current))
        setActiveDocument((current) => (current?.path === path ? saved : current))
        setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, saved))
      },
      // Temporary `blob:` image links are saved as workspace assets before the text is written.
      prepareSave: (text, path) => (text.includes('](blob:') ? persistBlobImageLinks(text, path) : Promise.resolve(text)),
      closedSaveFailed: (path, reason) => notify.error(
        translateRef.current('document:session.closeSaveFailed', { title: path.split('/').pop() || path }),
        { description: isDocumentSaveConflict(reason) ? translateRef.current('document:session.saveConflict') : errorMessage(reason) },
      ),
    })
    registerDocumentSession(session)
    watchSession(session)
    return session
  }

  /** Opens (or reuses) the session of a Markdown document; resolves once it is ready. */
  async function ensureSession(document: WorkspaceDocument): Promise<DocumentSession> {
    const existing = findDocumentSession(document.path)
    if (existing?.isReady()) {
      if (document.content !== existing.savedText()) void existing.reconcile()
      return existing
    }
    if (existing) {
      await startingRef.current.get(existing)
      if (existing.isReady()) return existing
      throw new Error(t('document:session.openFailed'))
    }
    if (!rootPathRef.current) {
      try {
        rootPathRef.current = (await listWorkspaceDocuments()).root_path || ''
      } catch {
        // Saves then fail their guard and are retried; the document still opens.
      }
    }
    const session = createSession(document)
    const start = session.start(document.content)
    startingRef.current.set(session, start)
    try {
      await start
    } catch (reason) {
      closeSession(session)
      throw reason
    } finally {
      startingRef.current.delete(session)
    }
    return session
  }
  const startingRef = useRef(new Map<DocumentSession, Promise<void>>())
  /** The latest activation: an older one that finishes later does not take over the editor. */
  const activationRef = useRef(0)

  function applyWorkspaceDocument(document: WorkspaceDocument) {
    const draft = readWorkspaceDocumentDraft(document)
    const existing = openedEntriesRef.current[document.path]
    // A known document keeps the entry (and session) it has; a fresh read only refreshes the file text.
    const entry: OpenedDocumentEntry = { document: existing?.format === draft.format ? { ...existing.document, ...document } : document, format: draft.format }
    updateEntries((current) => ({ ...current, [document.path]: entry }))
    // The refs at once: the session may open before the next render.
    activeDocumentRef.current = entry.document
    activeDocumentFormatRef.current = draft.format
    setActiveDocument(entry.document)
    setActiveResourcePath('')
    setActiveDocumentFormat(draft.format)
    setSelectedPlatform(inferDocumentPlatform(document.path, draft.markdown))
    if (draft.format === 'markdown' && editorMode !== 'rich' && editorMode !== 'preview') {
      onRequireMarkdownMode()
    }
    writeLastActiveDocumentPath(document.path)
    onOpenDocumentTab(entry.document)

    const activation = ++activationRef.current
    if (draft.format !== 'markdown') {
      publishSession(null)
      setDraftContent(draft.markdown)
      return Promise.resolve()
    }
    const ready = getDocumentSession(document.path)
    if (ready) {
      if (document.content !== ready.savedText()) void ready.reconcile()
      publishSession(ready)
      return Promise.resolve()
    }
    publishSession(null)
    setDraftContent(draft.markdown)
    return ensureSession(document).then((session) => {
      if (activationRef.current === activation && activeDocumentRef.current?.path === session.path) publishSession(session)
    }).catch((reason: unknown) => {
      updateEntries((current) => {
        const next = { ...current }
        delete next[document.path]
        return next
      })
      onError(errorMessage(reason) || t('document:session.openFailed'))
    })
  }

  function clearActiveDocumentSession() {
    publishSession(null)
    activeDocumentRef.current = null
    setActiveDocument(null)
    setActiveResourcePath('')
    setActiveDocumentFormat('markdown')
    setDraftContent('')
    updateDocumentRevisions(() => ({}))
    revisionSavingPathRef.current = ''
    setRevisionSavingPath('')
    writeLastActiveDocumentPath('')
  }

  /** The tab of `path` closed (after its pending save was written or discarded). */
  function closeOpenedDocument(path: string) {
    const session = findDocumentSession(path)
    if (session) closeSession(session)
    updateEntries((current) => {
      if (!current[path]) return current
      const next = { ...current }
      delete next[path]
      return next
    })
    updateDocumentRevisions((current) => {
      if (!current[path]) return current
      const next = { ...current }
      delete next[path]
      return next
    })
  }

  /** Files that were deleted: their sessions stop without saving. */
  function forgetOpenedDocuments(predicate: (path: string) => boolean) {
    for (const session of listDocumentSessions()) {
      if (!predicate(session.path)) continue
      session.discard()
      closeSession(session)
    }
    updateEntries((current) => {
      const kept = Object.entries(current).filter(([path]) => !predicate(path))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
    updateDocumentRevisions((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => !predicate(path)),
    ))
  }

  /** Files were renamed or moved (on disk already): their sessions, entries, and reviews follow. */
  function remapOpenedDocuments(sourcePath: string, targetPath: string) {
    if (!sourcePath || !targetPath || sourcePath === targetPath) return
    remapDocumentSessions((path) => remapWorkspaceBranchPath(path, sourcePath, targetPath))
    const rename = (document: WorkspaceDocument, nextPath: string): WorkspaceDocument => ({
      ...document,
      path: nextPath,
      name: nextPath.split('/').pop() || document.name,
    })
    updateEntries((current) => {
      let changed = false
      const next: Record<string, OpenedDocumentEntry> = {}
      for (const [path, entry] of Object.entries(current)) {
        const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
        if (nextPath === path) {
          next[path] = entry
          continue
        }
        changed = true
        next[nextPath] = { ...entry, document: rename(entry.document, nextPath) }
      }
      return changed ? next : current
    })
    updateDocumentRevisions((current) => {
      let changed = false
      const next: Record<string, PendingDocumentRevision> = {}
      for (const [path, revision] of Object.entries(current)) {
        const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
        if (nextPath !== path) changed = true
        next[nextPath] = nextPath === path ? revision : remapPendingDocumentRevision(revision, nextPath)
      }
      return changed ? next : current
    })
    setActiveDocument((current) => {
      if (!current) return current
      const nextPath = remapWorkspaceBranchPath(current.path, sourcePath, targetPath)
      return nextPath === current.path ? current : rename(current, nextPath)
    })
  }

  function getOpenedDocument(path: string): OpenedDocumentEntry | null {
    return openedEntries[path] || null
  }

  function isOpenedDocumentModified(path: string) {
    return Boolean(findDocumentSession(path)?.isDirty())
  }

  /**
   * Replaces the active document's text (an imported file, the saved version) as one undoable
   * edit; its session saves it. Answers whether the text changed.
   */
  function replaceActiveDocumentText(text: string, label: string) {
    const session = activeSessionRef.current
    if (!session?.isReady()) return false
    return session.replaceText(text, person(LOCAL_PERSON, label))
  }

  /** Puts the active document back to the file's text as last saved (an undoable edit). */
  function restoreSavedVersion() {
    const session = activeSessionRef.current
    const saved = session?.savedText()
    if (!session || saved === null || saved === undefined) return false
    return replaceActiveDocumentText(saved, 'restore')
  }

  // --- the agent's proposals under review ---------------------------------------

  async function finalizeDocumentRevision(
    revision: PendingDocumentRevision,
    decisions: Record<string, DocumentRevisionDecision>,
    feedbackKey:
      | 'revision.acceptedFeedback'
      | 'revision.rejectedFeedback'
      | 'revision.appliedFeedback',
  ) {
    if (revisionSavingPathRef.current) return

    revisionSavingPathRef.current = revision.path
    setRevisionSavingPath(revision.path)
    updateDocumentRevisions((current) => ({
      ...current,
      [revision.path]: { ...revision, decisions },
    }))

    try {
      const finalContent = applyDocumentRevisionDecisions(revision.comparison, decisions)
      const session = getDocumentSession(revision.path)
      let finalDocument: WorkspaceDocument = { ...revision.proposedDocument, content: finalContent }
      if (session) {
        await session.acceptReviewedText(revision.proposedDocument.content, finalContent)
        finalDocument = { ...finalDocument, content: session.savedText() ?? finalContent }
      } else if (finalContent !== revision.proposedDocument.content) {
        finalDocument = await writeWorkspaceDocument(revision.path, finalContent)
      }

      updateDocumentRevisions((current) => {
        const next = { ...current }
        delete next[revision.path]
        return next
      })
      setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, finalDocument))
      onClearModifiedDocumentPath(revision.path)
      onFeedback(t(feedbackKey))
    } catch (requestError: unknown) {
      onError(errorMessage(requestError) || t('revision.saveFailed'))
    } finally {
      revisionSavingPathRef.current = ''
      setRevisionSavingPath('')
    }
  }

  function decideDocumentRevisionChange(
    path: string,
    changeId: string,
    decision: DocumentRevisionDecision,
  ) {
    if (revisionSavingPathRef.current) return
    const revision = documentRevisionsRef.current[path]
    if (!revision || !revision.comparison.changes.some((change) => change.id === changeId)) {
      return
    }

    const decisions = { ...revision.decisions, [changeId]: decision }
    const isComplete = revision.comparison.changes.every((change) => Boolean(decisions[change.id]))
    if (isComplete) {
      void finalizeDocumentRevision(revision, decisions, 'revision.appliedFeedback')
      return
    }

    updateDocumentRevisions((current) => ({
      ...current,
      [path]: { ...revision, decisions },
    }))
  }

  function resolveAllDocumentRevisionChanges(
    path: string,
    decision: DocumentRevisionDecision,
  ) {
    if (revisionSavingPathRef.current) return
    const revision = documentRevisionsRef.current[path]
    if (!revision) return
    const decisions = Object.fromEntries(
      revision.comparison.changes.map((change) => [change.id, revision.decisions[change.id] || decision]),
    ) as Record<string, DocumentRevisionDecision>
    void finalizeDocumentRevision(
      revision,
      decisions,
      Object.keys(revision.decisions).length ? 'revision.appliedFeedback'
        : decision === 'accepted' ? 'revision.acceptedFeedback' : 'revision.rejectedFeedback',
    )
  }

  /**
   * Shows the agent's change to the active document for review. A document with unsaved edits
   * merges the change instead (D4: nothing is dropped or overwritten).
   */
  async function refreshDocumentRevision(path: string) {
    const normalizedPath = normalizeDocumentRevisionPath(path)
    const currentDocument = activeDocumentRef.current
    if (!normalizedPath || currentDocument?.path !== normalizedPath) {
      return
    }

    const session = getDocumentSession(normalizedPath)
    if (session?.isDirty()) {
      await session.reconcile()
      onClearModifiedDocumentPath(normalizedPath)
      return
    }

    const refreshVersion = ++externalRefreshVersionRef.current
    const revisionBeforeRead = documentRevisionsRef.current[normalizedPath]
    const comparedBeforeRead = revisionBeforeRead?.proposedDocument.content
      ?? session?.read() ?? currentDocument.content

    try {
      const nextDocument = await readWorkspaceDocument(normalizedPath)
      if (externalRefreshVersionRef.current !== refreshVersion) return

      const latestDocument = activeDocumentRef.current
      const latestRevision = documentRevisionsRef.current[normalizedPath]
      const latestSession = getDocumentSession(normalizedPath)
      const latestCompared = latestRevision?.proposedDocument.content
        ?? latestSession?.read() ?? latestDocument?.content
      if (latestDocument?.path !== normalizedPath || latestCompared !== comparedBeforeRead) return
      if (latestSession?.isDirty()) {
        await latestSession.reconcile()
        onClearModifiedDocumentPath(normalizedPath)
        return
      }
      if (latestRevision?.proposedDocument.content === nextDocument.content) return

      if (activeDocumentFormatRef.current === 'data') {
        void applyWorkspaceDocument(nextDocument)
        setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, nextDocument))
        onClearModifiedDocumentPath(normalizedPath)
        return
      }

      const originalContent = latestRevision?.originalDocument.content ?? latestSession?.read() ?? latestDocument.content
      const comparison = createDocumentRevisionComparison(originalContent, nextDocument.content)
      if (!comparison.changes.length) {
        updateDocumentRevisions((current) => {
          const next = { ...current }
          delete next[normalizedPath]
          return next
        })
        await latestSession?.reconcile()
        onClearModifiedDocumentPath(normalizedPath)
      } else {
        updateDocumentRevisions((current) => ({
          ...current,
          [normalizedPath]: {
            path: normalizedPath,
            originalDocument: { ...latestDocument, content: originalContent },
            proposedDocument: nextDocument,
            comparison,
            decisions: {},
          },
        }))
        onFeedback(t('revision.externalChangeReady', { count: comparison.changes.length }))
      }
      setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, nextDocument))
    } catch (requestError: unknown) {
      if (externalRefreshVersionRef.current === refreshVersion) {
        onError(errorMessage(requestError) || t('revision.refreshFailed'))
      }
    }
  }

  function reviewModifiedDocuments(paths: string[]) {
    const activePath = activeDocumentRef.current?.path || ''
    const hasActivePath = paths.some((path) => documentRevisionPathsMatch(path, activePath))
    if (!activePath || !hasActivePath) {
      return Promise.resolve()
    }
    return refreshDocumentRevision(activePath)
  }

  async function openModifiedDocumentReview(path: string) {
    const normalizedPath = normalizeDocumentRevisionPath(path)
    if (!normalizedPath) return

    const activePath = activeDocumentRef.current?.path || ''
    if (documentRevisionPathsMatch(normalizedPath, activePath)) {
      await refreshDocumentRevision(activePath)
      return
    }

    const workspacePath = Object.keys(documentRevisionsRef.current)
      .find((revisionPath) => documentRevisionPathsMatch(revisionPath, normalizedPath))
      || files.find((item) => documentRevisionPathsMatch(item.path, normalizedPath))?.path
      || normalizedPath
    await openDocument(workspacePath)
  }

  // A file the tree should show appeared or went away.
  useEffect(() => subscribeWorkspaceDocumentExternalChanges((change) => {
    if (change.eventType === 'add' || change.eventType === 'unlink') {
      void listWorkspaceDocuments()
        .then((workspace) => setTreeItems(workspace.items || []))
        .catch(() => {})
    }
    if (change.eventType === 'unlink') return
    // Markdown sessions merge their own file's changes; a data document is re-read for review.
    if (change.path === activeDocumentRef.current?.path && activeDocumentFormatRef.current === 'data') {
      void refreshDocumentRevision(change.path)
    }
  }), [setTreeItems])

  // Cmd/Ctrl+S writes the active document now.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void activeSessionRef.current?.flush().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Another workspace: the sessions of the previous one were flushed by the switch; close them.
  const sessionsRootRef = useRef(rootPath)
  useEffect(() => {
    const previous = sessionsRootRef.current
    sessionsRootRef.current = rootPath
    if (!previous || !rootPath || previous === rootPath) return
    for (const session of listDocumentSessions()) closeSession(session)
    updateEntries(() => ({}))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on workspace switches only.
  }, [rootPath])

  // Unmount: write what is pending and stop every session.
  useEffect(() => () => {
    stopPublishing()
    for (const session of listDocumentSessions()) {
      sessionWatchersRef.current.get(session)?.()
      unregisterDocumentSession(session)
      session.dispose()
    }
    sessionWatchersRef.current.clear()
  }, [])

  const flushActiveDocument = useCallback(async () => {
    const session = activeSessionRef.current
    if (!session) return true
    try {
      await session.flush()
      return true
    } catch {
      return false
    }
  }, [])

  /** Writes the active document's pending edit; answers whether it is saved. */
  function ensureActiveDocumentSaved() {
    return flushActiveDocument()
  }

  /** Writes the active document's pending edit (the shortcut and file operations); answers whether it is saved. */
  function persistActiveDocument(_reason: 'auto' | 'shortcut' = 'auto') {
    return flushActiveDocument()
  }

  async function openDocument(path: string) {
    const previousActivePath = activeResourcePath || activeDocument?.path || ''
    flushSync(() => {
      setActiveResourcePath(path)
    })
    onError('')
    onFeedback('')

    try {
      const treeFile = files.find((item) => item.path === path)
      const format = treeFile?.format || inferWorkspaceItemFormat(path)
      if (!isEditableWorkspaceFormat(format)) {
        if (isPreviewableWorkspaceFormat(format)) {
          setActiveResourcePath(path)
          onOpenFileViewerTab(path, format)
          return
        }
        setActiveResourcePath(path)
        const openError = await openWorkspaceFile(path)
        if (openError) {
          setActiveResourcePath(previousActivePath)
          onError(`Failed to open file: ${openError}`)
          return
        }
        onFeedback(`Requested system to open ${path}`)
        return
      }

      // An open document (a background tab) keeps its session: no read, no reload.
      const entry = openedEntriesRef.current[path]
      if (entry && (entry.format !== 'markdown' || findDocumentSession(path))) {
        await applyWorkspaceDocument(entry.document)
        if (isModifiedDocumentPath(path) && !documentRevisionsRef.current[path]) {
          await refreshDocumentRevision(path)
        }
        return
      }

      const nextDocument = await readWorkspaceDocument(path)
      await applyWorkspaceDocument(nextDocument)
      onClearModifiedDocumentPath(path)
    } catch (requestError: unknown) {
      setActiveResourcePath(previousActivePath)
      onError(errorMessage(requestError) || 'Failed to open document')
    }
  }

  return {
    activeDocument,
    activeDocumentFormat,
    activeDocumentRevision,
    activeDocumentSession,
    activeResourcePath,
    applyWorkspaceDocument,
    autoSaveStatus,
    clearActiveDocumentSession,
    closeOpenedDocument,
    draftContent,
    documentRevisionSaving: Boolean(
      activeDocumentRevision && revisionSavingPath === activeDocumentRevision.path
    ),
    decideDocumentRevisionChange,
    ensureActiveDocumentSaved,
    forgetOpenedDocuments,
    getOpenedDocument,
    hasUnsavedChanges,
    isOpenedDocumentModified,
    openModifiedDocumentReview,
    openDocument,
    persistActiveDocument,
    remapOpenedDocuments,
    replaceActiveDocumentText,
    restoreSavedVersion,
    reviewModifiedDocuments,
    resolveAllDocumentRevisionChanges,
    saving,
    selectedPlatform,
    setActiveResourcePath,
    setSaving,
    setSelectedPlatform,
  }
}
