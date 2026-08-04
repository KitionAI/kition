import type { Dispatch, SetStateAction } from 'react'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useWorkspaceDocumentAutosave } from '@/features/document/hooks/useWorkspaceDocumentAutosave'
import {
  getWorkspaceDocumentStoredContent,
  inferDocumentPlatform,
  readWorkspaceDocumentDraft,
} from '@/features/document/lib/documentDraft'
import {
  pushDocumentSnapshot,
  readDocumentSnapshots,
  type DocumentSnapshot,
  writeDocumentSnapshots,
} from '@/features/document/lib/documentSnapshots'
import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import {
  createOpenedDocumentDraftCacheEntry,
  type OpenedDocumentDraftCacheEntry,
} from '@/features/document/lib/openedDocumentDrafts'
import {
  applyDocumentRevisionDecisions,
  createDocumentRevisionComparison,
  remapPendingDocumentRevision,
  type DocumentRevisionDecision,
  type PendingDocumentRevision,
} from '@/features/document/lib/documentRevision'
import {
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
  isPreviewableWorkspaceFormat,
  remapWorkspaceBranchPath,
} from '@/features/workspace/lib/workspace'
import { updateWorkspaceTreeDocumentItem } from '@/features/workspace/lib/workspaceTree'
import { writeLastActiveDocumentPath } from '@/features/workspace/lib/workspacePersistence'
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

type UseWorkspaceDocumentSessionOptions = {
  editorLocked: boolean
  editorMode: EditorMode
  files: WorkspaceDocumentTreeItem[]
  isModifiedDocumentPath: (path: string) => boolean
  onClearModifiedDocumentPath: (path: string) => void
  onError: (message: string) => void
  onFeedback: (message: string) => void
  onOpenDocumentTab: (document: WorkspaceDocument) => void
  onOpenFileViewerTab: (path: string, format: WorkspaceDocumentFormat) => void
  onRequireMarkdownMode: () => void
  setTreeItems: Dispatch<SetStateAction<WorkspaceDocumentTreeItem[]>>
}

                                                    
                     
const DRAFT_STATE_FLUSH_MS = 150

export function useWorkspaceDocumentSession({
  editorLocked,
  editorMode,
  files,
  isModifiedDocumentPath,
  onClearModifiedDocumentPath,
  onError,
  onFeedback,
  onOpenDocumentTab,
  onOpenFileViewerTab,
  onRequireMarkdownMode,
  setTreeItems,
}: UseWorkspaceDocumentSessionOptions) {
  const { t } = useTranslation('document')
  const [activeDocument, setActiveDocument] = useState<WorkspaceDocument | null>(null)
  const [activeResourcePath, setActiveResourcePath] = useState('')
  const [activeDocumentFormat, setActiveDocumentFormat] = useState<WorkspaceDocumentFormat>('markdown')
  const [draftContent, setDraftContent] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState<DocumentPlatform>('page')
  const [editorResetVersions, setEditorResetVersions] = useState<Record<string, number>>({})
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[]>(() => readDocumentSnapshots())
  const [saving, setSaving] = useState(false)
  const [documentRevisions, setDocumentRevisions] = useState<Record<string, PendingDocumentRevision>>({})
  const [revisionSavingPath, setRevisionSavingPath] = useState('')

  const activeDocumentRef = useRef<WorkspaceDocument | null>(null)
  const activeDocumentFormatRef = useRef<WorkspaceDocumentFormat>('markdown')
  const draftContentRef = useRef('')
  const editorLockedRef = useRef(false)
                                                                 
                                                                             
  const draftStateFlushTimerRef = useRef<number | null>(null)
  const openedDocumentDraftsRef = useRef<Record<string, OpenedDocumentDraftCacheEntry>>({})
  const autoSnapshotAtRef = useRef<Record<string, number>>({})
  const externalRefreshVersionRef = useRef(0)
  const documentRevisionsRef = useRef<Record<string, PendingDocumentRevision>>({})
  const revisionSavingPathRef = useRef('')

  const draftStoredContent = useMemo(
    () => getWorkspaceDocumentStoredContent({
      document: activeDocument,
      format: activeDocumentFormat,
      markdown: draftContent,
    }),
    [activeDocument, activeDocumentFormat, draftContent],
  )
  const hasUnsavedChanges = Boolean(activeDocument && draftStoredContent !== activeDocument.content)
  const activeDocumentRevision = activeDocument
    ? documentRevisions[activeDocument.path] || null
    : null

  activeDocumentRef.current = activeDocument
  activeDocumentFormatRef.current = activeDocumentFormat
  documentRevisionsRef.current = documentRevisions
  revisionSavingPathRef.current = revisionSavingPath
                                                                   
                                                                     
                                                        
  if (draftStateFlushTimerRef.current == null) {
    draftContentRef.current = draftContent
  }
  editorLockedRef.current = editorLocked

                                                             
                                                                           
                                                    
                                                              
                        
  //
                                                             
                                                      
                                                         
                                                   
                                                        
                                                    
  function handleDraftContentChange(nextValue: string) {
    draftContentRef.current = nextValue
    if (draftStateFlushTimerRef.current != null) {
      window.clearTimeout(draftStateFlushTimerRef.current)
    }
    draftStateFlushTimerRef.current = window.setTimeout(() => {
      draftStateFlushTimerRef.current = null
      startTransition(() => {
        setDraftContent(draftContentRef.current)
      })
    }, DRAFT_STATE_FLUSH_MS)
  }

                                                         
                    
  function replaceDraftContent(nextValue: string) {
    if (draftStateFlushTimerRef.current != null) {
      window.clearTimeout(draftStateFlushTimerRef.current)
      draftStateFlushTimerRef.current = null
    }
    draftContentRef.current = nextValue
    setDraftContent(nextValue)
  }

                                                                 
                                    
  function isDirtyByRef(): boolean {
    const document = activeDocumentRef.current
    if (!document) return false
    const stored = getWorkspaceDocumentStoredContent({
      document,
      format: activeDocumentFormatRef.current,
      markdown: draftContentRef.current,
    })
    return stored !== document.content
  }

  function cacheOpenedDocumentDraft(
    document = activeDocumentRef.current,
    format = activeDocumentFormatRef.current,
    markdown = draftContentRef.current,
  ) {
    if (!document) {
      return
    }

                                             
                                                                    
                                                        
    const storedContent = getWorkspaceDocumentStoredContent({ document, format, markdown })
    if (storedContent === document.content) {
      delete openedDocumentDraftsRef.current[document.path]
      return
    }

    openedDocumentDraftsRef.current[document.path] = createOpenedDocumentDraftCacheEntry({
      document,
      format,
      markdown,
      platform: inferDocumentPlatform(document.path, markdown),
    })
  }

  function removeOpenedDocumentDraft(path: string) {
    delete openedDocumentDraftsRef.current[path]
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

  function pruneOpenedDocumentDrafts(predicate: (path: string) => boolean) {
    for (const path of Object.keys(openedDocumentDraftsRef.current)) {
      if (predicate(path)) {
        delete openedDocumentDraftsRef.current[path]
      }
    }
    updateDocumentRevisions((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => !predicate(path)),
    ))
  }

     
                                           
                                                                    
                                                           
    
          
                                                                   
                   
                                                                             
                                                        
                                                               
     
  function remapOpenedDocumentDrafts(sourcePath: string, targetPath: string) {
    if (!sourcePath || !targetPath || sourcePath === targetPath) {
      return
    }

    const drafts = openedDocumentDraftsRef.current
    const remappedDrafts: Record<string, OpenedDocumentDraftCacheEntry> = {}
    let draftsChanged = false
    for (const [path, entry] of Object.entries(drafts)) {
      const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
      if (nextPath === path) {
        remappedDrafts[path] = entry
        continue
      }
      draftsChanged = true
      const nextName = nextPath.split('/').pop() || entry.document.name
      remappedDrafts[nextPath] = {
        ...entry,
        document: { ...entry.document, path: nextPath, name: nextName },
      }
    }
    if (draftsChanged) {
      openedDocumentDraftsRef.current = remappedDrafts
    }

    updateDocumentRevisions((current) => {
      let revisionsChanged = false
      const next: Record<string, PendingDocumentRevision> = {}
      for (const [path, revision] of Object.entries(current)) {
        const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
        if (nextPath !== path) revisionsChanged = true
        next[nextPath] = nextPath === path
          ? revision
          : remapPendingDocumentRevision(revision, nextPath)
      }
      return revisionsChanged ? next : current
    })

    setEditorResetVersions((current) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [path, version] of Object.entries(current)) {
        const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
        if (nextPath !== path) changed = true
        next[nextPath] = version
      }
      return changed ? next : current
    })

    setActiveDocument((current) => {
      if (!current) return current
      const nextPath = remapWorkspaceBranchPath(current.path, sourcePath, targetPath)
      if (nextPath === current.path) return current
      const nextName = nextPath.split('/').pop() || current.name
      return { ...current, path: nextPath, name: nextName }
    })
  }

  function getOpenedDocumentDraftEntry(path: string) {
    if (activeDocument?.path === path && activeDocument) {
      return createOpenedDocumentDraftCacheEntry({
        document: activeDocument,
        format: activeDocumentFormat,
        markdown: draftContent,
        platform: selectedPlatform,
      })
    }

    return openedDocumentDraftsRef.current[path] || null
  }

  function bumpEditorReset(path = activeDocumentRef.current?.path || '') {
    if (!path) {
      return
    }

    setEditorResetVersions((current) => ({
      ...current,
      [path]: (current[path] || 0) + 1,
    }))
  }

  function updateSnapshots(nextSnapshots: DocumentSnapshot[]) {
    setSnapshots(nextSnapshots)
    writeDocumentSnapshots(nextSnapshots)
  }

  function rememberDocumentSnapshot(document: WorkspaceDocument, content: string, reason: string) {
    setSnapshots((current) => {
      const nextSnapshots = pushDocumentSnapshot(current, document, content, reason)
      writeDocumentSnapshots(nextSnapshots)
      return nextSnapshots
    })
  }

  const {
    autoSaveStatus,
    cancelPendingAutoSave,
    persistActiveDocument,
    saveInFlightRef,
    waitForActiveSave,
  } = useWorkspaceDocumentAutosave({
    activeDocument,
    activeDocumentFormat,
    activeDocumentRef,
    activeDocumentFormatRef,
    autoSnapshotAtRef,
    draftContentRef,
    draftStoredContent,
    editorLocked,
    editorLockedRef,
    hasUnsavedChanges,
    rememberDocumentSnapshot,
    setActiveDocument,
    setDraftContent,
    setSaving,
    setTreeItems,
  })

  function applyWorkspaceDocument(
    document: WorkspaceDocument,
    options: { resetEditor?: boolean; restoreFromCache?: boolean } = {},
  ) {
    const cachedDraft = options.restoreFromCache !== false
      ? openedDocumentDraftsRef.current[document.path]
      : undefined
    const draft = cachedDraft || readWorkspaceDocumentDraft(document)
    const nextDocument = cachedDraft?.document || document
    console.warn('[KITION/apply] path=%s usingCache=%s draftLen=%d docContentLen=%d',
      document.path,
      Boolean(cachedDraft),
      draft.markdown.length,
      nextDocument.content.length,
    )

    setActiveDocument(nextDocument)
    setActiveResourcePath('')
    setActiveDocumentFormat(draft.format)
    replaceDraftContent(draft.markdown)
    setSelectedPlatform(cachedDraft?.platform || inferDocumentPlatform(nextDocument.path, draft.markdown))

    if (
      draft.format === 'markdown'
      && editorMode !== 'rich'
      && editorMode !== 'preview'
    ) {
      onRequireMarkdownMode()
    }
    if (options.resetEditor !== false) {
      bumpEditorReset(nextDocument.path)
    }

    writeLastActiveDocumentPath(nextDocument.path)
    onOpenDocumentTab(nextDocument)
  }

  function clearActiveDocumentSession() {
    setActiveDocument(null)
    setActiveResourcePath('')
    setActiveDocumentFormat('markdown')
    replaceDraftContent('')
    updateDocumentRevisions(() => ({}))
    revisionSavingPathRef.current = ''
    setRevisionSavingPath('')
    writeLastActiveDocumentPath('')
  }

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
      const finalDocument = finalContent === revision.proposedDocument.content
        ? revision.proposedDocument
        : await writeWorkspaceDocument(revision.path, finalContent)

      updateDocumentRevisions((current) => {
        const next = { ...current }
        delete next[revision.path]
        return next
      })
      removeOpenedDocumentDraft(revision.path)
      if (activeDocumentRef.current?.path === revision.path) {
        applyWorkspaceDocument(finalDocument, { restoreFromCache: false })
      }
      setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, finalDocument))
      onClearModifiedDocumentPath(revision.path)
      onFeedback(t(feedbackKey))
    } catch (requestError: any) {
      onError(requestError?.message || t('revision.saveFailed'))
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
      void finalizeDocumentRevision(
        revision,
        decisions,
        'revision.appliedFeedback',
      )
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
      revision.comparison.changes.map((change) => [change.id, decision]),
    ) as Record<string, DocumentRevisionDecision>
    void finalizeDocumentRevision(
      revision,
      decisions,
      decision === 'accepted' ? 'revision.acceptedFeedback' : 'revision.rejectedFeedback',
    )
  }

  async function refreshDocumentRevision(path: string) {
    const normalizedPath = normalizeDocumentRevisionPath(path)
    const currentDocument = activeDocumentRef.current
    if (!normalizedPath || currentDocument?.path !== normalizedPath) {
      return
    }

    if (isDirtyByRef()) {
      cancelPendingAutoSave()
      onFeedback(t('revision.dirtyExternalChange'))
      return
    }

    const refreshVersion = ++externalRefreshVersionRef.current
    const revisionBeforeRead = documentRevisionsRef.current[normalizedPath]
    const documentContentBeforeRead = revisionBeforeRead?.proposedDocument.content
      || currentDocument.content

    try {
      const nextDocument = await readWorkspaceDocument(normalizedPath)
      if (externalRefreshVersionRef.current !== refreshVersion) {
        return
      }

      const latestDocument = activeDocumentRef.current
      const latestRevision = documentRevisionsRef.current[normalizedPath]
      const latestComparedContent = latestRevision?.proposedDocument.content
        || latestDocument?.content
      if (
        latestDocument?.path !== normalizedPath
        || latestComparedContent !== documentContentBeforeRead
        || isDirtyByRef()
      ) {
        return
      }

      if (latestRevision?.proposedDocument.content === nextDocument.content) {
        return
      }

      if (activeDocumentFormatRef.current === 'data') {
        removeOpenedDocumentDraft(normalizedPath)
        applyWorkspaceDocument(nextDocument, { restoreFromCache: false })
        setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, nextDocument))
        onClearModifiedDocumentPath(normalizedPath)
        return
      }

      const originalDocument = latestRevision?.originalDocument || latestDocument
      const comparison = createDocumentRevisionComparison(
        originalDocument.content,
        nextDocument.content,
      )
      if (!comparison.changes.length) {
        updateDocumentRevisions((current) => {
          const next = { ...current }
          delete next[normalizedPath]
          return next
        })
        removeOpenedDocumentDraft(normalizedPath)
        applyWorkspaceDocument(nextDocument, { restoreFromCache: false })
        onClearModifiedDocumentPath(normalizedPath)
      } else {
        updateDocumentRevisions((current) => ({
          ...current,
          [normalizedPath]: {
            path: normalizedPath,
            originalDocument,
            proposedDocument: nextDocument,
            comparison,
            decisions: {},
          },
        }))
        onFeedback(t('revision.externalChangeReady', { count: comparison.changes.length }))
      }
      setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, nextDocument))
    } catch (requestError: any) {
      if (externalRefreshVersionRef.current === refreshVersion) {
        onError(requestError?.message || t('revision.refreshFailed'))
      }
    }
  }

  function reviewModifiedDocuments(paths: string[]) {
    const activePath = activeDocumentRef.current?.path || ''
    const hasActivePath = paths
      .some((path) => documentRevisionPathsMatch(path, activePath))
    if (!activePath || !hasActivePath) {
      return Promise.resolve()
    }
    return refreshDocumentRevision(activePath)
  }

  async function openModifiedDocumentReview(path: string) {
    const normalizedPath = normalizeDocumentRevisionPath(path)
    if (!normalizedPath) {
      return
    }

    const activePath = activeDocumentRef.current?.path || ''
    if (documentRevisionPathsMatch(normalizedPath, activePath)) {
      await refreshDocumentRevision(activePath)
      return
    }

    const pendingRevision = Object.values(documentRevisionsRef.current)
      .find((revision) => documentRevisionPathsMatch(revision.path, normalizedPath))
    if (pendingRevision) {
      applyWorkspaceDocument(pendingRevision.originalDocument, { restoreFromCache: false })
      return
    }

    const workspacePath = files.find((item) => (
      documentRevisionPathsMatch(item.path, normalizedPath)
    ))?.path || normalizedPath
    await openDocument(workspacePath)
  }

  useEffect(() => subscribeWorkspaceDocumentExternalChanges((change) => {
    if (change.eventType === 'add' || change.eventType === 'unlink') {
      void listWorkspaceDocuments()
        .then((workspace) => setTreeItems(workspace.items || []))
        .catch(() => {})
    }

    if (change.eventType === 'unlink') {
      return
    }
    void refreshDocumentRevision(change.path)
  }), [
    refreshDocumentRevision,
    setTreeItems,
  ])

  useEffect(() => {
    cacheOpenedDocumentDraft(activeDocument, activeDocumentFormat, draftContent)
  }, [activeDocument, activeDocumentFormat, draftContent])

  useEffect(
    () => () => {
      if (draftStateFlushTimerRef.current != null) {
        window.clearTimeout(draftStateFlushTimerRef.current)
        draftStateFlushTimerRef.current = null
      }
    },
    [],
  )

  async function ensureActiveDocumentSaved() {
    if (!isDirtyByRef()) {
      return true
    }

    cancelPendingAutoSave()
    if (saveInFlightRef.current) {
      const saved = await waitForActiveSave()
      if (!saved) {
        return false
      }
    }

    const currentDocument = activeDocumentRef.current
    if (!currentDocument) {
      return true
    }

    const currentContent = getWorkspaceDocumentStoredContent({
      document: currentDocument,
      format: activeDocumentFormatRef.current,
      markdown: draftContentRef.current,
    })
    if (currentContent === currentDocument.content) {
      return true
    }

    return persistActiveDocument('shortcut')
  }

  async function openDocument(path: string) {
    const previousActivePath = activeResourcePath || activeDocument?.path || ''
    cacheOpenedDocumentDraft()
    console.warn('[KITION/open] path=%s prevActive=%s activeRef=%s cacheKeys=%o',
      path,
      previousActivePath,
      activeDocumentRef.current?.path || '(none)',
      Object.keys(openedDocumentDraftsRef.current),
    )
    flushSync(() => {
      setActiveResourcePath(path)
    })
    onError('')
    onFeedback('')

    try {
      if (isDirtyByRef()) {
        cancelPendingAutoSave()
        if (saveInFlightRef.current) {
          const saved = await waitForActiveSave()
          if (!saved) {
            setActiveResourcePath(previousActivePath)
            return
          }

          const currentDocument = activeDocumentRef.current
          const currentContent = getWorkspaceDocumentStoredContent({
            document: currentDocument,
            format: activeDocumentFormatRef.current,
            markdown: draftContentRef.current,
          })
          if (currentDocument && currentContent !== currentDocument.content) {
            const savedLatest = await persistActiveDocument('auto')
            if (!savedLatest) {
              setActiveResourcePath(previousActivePath)
              return
            }
          }
        } else {
          void persistActiveDocument('auto')
        }
      }

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

      const cachedDraft = openedDocumentDraftsRef.current[path]
      const pendingRevision = documentRevisionsRef.current[path]
      console.warn('[KITION/open] cacheHit=%s draftLen=%d isModified=%s',
        Boolean(cachedDraft),
        cachedDraft?.markdown?.length ?? -1,
        isModifiedDocumentPath(path),
      )
      if (pendingRevision) {
        applyWorkspaceDocument(pendingRevision.originalDocument, {
          restoreFromCache: false,
        })
        return
      }
      if (cachedDraft && !isModifiedDocumentPath(path)) {
        applyWorkspaceDocument(cachedDraft.document, {
          resetEditor: false,
          restoreFromCache: true,
        })
        return
      }

      const nextDocument = await readWorkspaceDocument(path)
      console.warn('[KITION/open] diskRead path=%s contentLen=%d', path, nextDocument.content.length)
      applyWorkspaceDocument(nextDocument, { restoreFromCache: false })
      onClearModifiedDocumentPath(path)

      if (!snapshots.some((item) => item.path === nextDocument.path)) {
        rememberDocumentSnapshot(nextDocument, nextDocument.content, 'Initial version')
      }
    } catch (requestError: any) {
      setActiveResourcePath(previousActivePath)
      onError(requestError?.message || 'Failed to open document')
    }
  }

  return {
    activeDocument,
    activeDocumentFormat,
    activeDocumentRevision,
    activeResourcePath,
    applyWorkspaceDocument,
    autoSaveStatus,
    bumpEditorReset,
    clearActiveDocumentSession,
    draftContent,
    draftStoredContent,
    documentRevisionSaving: Boolean(
      activeDocumentRevision && revisionSavingPath === activeDocumentRevision.path
    ),
    decideDocumentRevisionChange,
    editorResetVersions,
    ensureActiveDocumentSaved,
    getOpenedDocumentDraftEntry,
    hasUnsavedChanges,
    handleDraftContentChange,
    openModifiedDocumentReview,
    openDocument,
    persistActiveDocument,
    pruneOpenedDocumentDrafts,
    remapOpenedDocumentDrafts,
    removeOpenedDocumentDraft,
    rememberDocumentSnapshot,
    reviewModifiedDocuments,
    resolveAllDocumentRevisionChanges,
    saving,
    selectedPlatform,
    setActiveResourcePath,
    setDraftContent,
    setSaving,
    setSelectedPlatform,
    snapshots,
    updateSnapshots,
  }
}
