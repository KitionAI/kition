import type { Dispatch, SetStateAction } from 'react'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
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
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
  isPreviewableWorkspaceFormat,
  remapWorkspaceBranchPath,
} from '@/features/workspace/lib/workspace'
import { writeLastActiveDocumentPath } from '@/features/workspace/lib/workspacePersistence'
import {
  openWorkspaceFile,
  readWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

type EditorMode = 'rich' | 'split' | 'source' | 'preview'

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
  const [activeDocument, setActiveDocument] = useState<WorkspaceDocument | null>(null)
  const [activeResourcePath, setActiveResourcePath] = useState('')
  const [activeDocumentFormat, setActiveDocumentFormat] = useState<WorkspaceDocumentFormat>('markdown')
  const [draftContent, setDraftContent] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState<DocumentPlatform>('page')
  const [editorResetVersions, setEditorResetVersions] = useState<Record<string, number>>({})
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[]>(() => readDocumentSnapshots())
  const [saving, setSaving] = useState(false)

  const activeDocumentRef = useRef<WorkspaceDocument | null>(null)
  const activeDocumentFormatRef = useRef<WorkspaceDocumentFormat>('markdown')
  const draftContentRef = useRef('')
  const editorLockedRef = useRef(false)
                                                                 
                                                                             
  const draftStateFlushTimerRef = useRef<number | null>(null)
  const openedDocumentDraftsRef = useRef<Record<string, OpenedDocumentDraftCacheEntry>>({})
  const autoSnapshotAtRef = useRef<Record<string, number>>({})

  const draftStoredContent = useMemo(
    () => getWorkspaceDocumentStoredContent({
      document: activeDocument,
      format: activeDocumentFormat,
      markdown: draftContent,
    }),
    [activeDocument, activeDocumentFormat, draftContent],
  )
  const hasUnsavedChanges = Boolean(activeDocument && draftStoredContent !== activeDocument.content)

  activeDocumentRef.current = activeDocument
  activeDocumentFormatRef.current = activeDocumentFormat
                                                                   
                                                                     
                                                        
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

  function pruneOpenedDocumentDrafts(predicate: (path: string) => boolean) {
    for (const path of Object.keys(openedDocumentDraftsRef.current)) {
      if (predicate(path)) {
        delete openedDocumentDraftsRef.current[path]
      }
    }
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
    writeLastActiveDocumentPath('')
  }

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
      console.warn('[KITION/open] cacheHit=%s draftLen=%d isModified=%s',
        Boolean(cachedDraft),
        cachedDraft?.markdown?.length ?? -1,
        isModifiedDocumentPath(path),
      )
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
    activeResourcePath,
    applyWorkspaceDocument,
    autoSaveStatus,
    bumpEditorReset,
    clearActiveDocumentSession,
    draftContent,
    draftStoredContent,
    editorResetVersions,
    ensureActiveDocumentSaved,
    getOpenedDocumentDraftEntry,
    hasUnsavedChanges,
    handleDraftContentChange,
    openDocument,
    persistActiveDocument,
    pruneOpenedDocumentDrafts,
    remapOpenedDocumentDrafts,
    removeOpenedDocumentDraft,
    rememberDocumentSnapshot,
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
