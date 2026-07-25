import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getWorkspaceDocumentStoredContent,
  readWorkspaceDocumentDraft,
  visibleDraftLength,
} from '@/features/document/lib/documentDraft'
import { persistBlobImageLinks } from '@/features/document/lib/documentAssetPersistence'
import { updateWorkspaceTreeDocumentItem } from '@/features/workspace/lib/workspaceTree'
import { notify } from '@/lib/notify'
import {
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

type AutoSaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

type UseWorkspaceDocumentAutosaveOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  activeDocumentRef: MutableRefObject<WorkspaceDocument | null>
  activeDocumentFormatRef: MutableRefObject<WorkspaceDocumentFormat>
  autoSnapshotAtRef: MutableRefObject<Record<string, number>>
  draftContentRef: MutableRefObject<string>
  draftStoredContent: string
  editorLocked: boolean
  editorLockedRef: MutableRefObject<boolean>
  hasUnsavedChanges: boolean
  rememberDocumentSnapshot: (document: WorkspaceDocument, content: string, reason: string) => void
  setActiveDocument: Dispatch<SetStateAction<WorkspaceDocument | null>>
  setDraftContent: Dispatch<SetStateAction<string>>
  setSaving: Dispatch<SetStateAction<boolean>>
  setTreeItems: Dispatch<SetStateAction<WorkspaceDocumentTreeItem[]>>
}

export function useWorkspaceDocumentAutosave({
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
}: UseWorkspaceDocumentAutosaveOptions) {
  const { t } = useTranslation(['document', 'common'])
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('saved')

  const autoSaveTimerRef = useRef<number | null>(null)
  const saveInFlightRef = useRef(false)
  const activeSavePromiseRef = useRef<Promise<boolean> | null>(null)
  const saveAgainAfterCurrentRef = useRef(false)

  const waitForActiveSave = useCallback(async () => {
    return activeSavePromiseRef.current ?? true
  }, [])

  const persistActiveDocument = useCallback(async (
    reason: 'auto' | 'shortcut' = 'auto',
  ): Promise<boolean> => {
    const document = activeDocumentRef.current
    if (!document || activeDocumentFormatRef.current === 'data' || editorLockedRef.current) {
      console.warn('[KITION/persist] bail reason=%s hasDoc=%s format=%s locked=%s',
        reason,
        Boolean(document),
        activeDocumentFormatRef.current,
        editorLockedRef.current,
      )
      return true
    }

    const format = activeDocumentFormatRef.current
    const markdown = draftContentRef.current
    const contentBeforeAssetPersist = getWorkspaceDocumentStoredContent({
      document,
      format,
      markdown,
    })
    console.warn('[KITION/persist] enter reason=%s path=%s draftLen=%d docContentLen=%d storeLen=%d',
      reason,
      document.path,
      markdown.length,
      document.content.length,
      contentBeforeAssetPersist.length,
    )

    if (contentBeforeAssetPersist === document.content) {
      console.warn('[KITION/persist] skip — content equals doc.content path=%s', document.path)
      setAutoSaveStatus('saved')
      return true
    }

    if (saveInFlightRef.current) {
      saveAgainAfterCurrentRef.current = true
      setAutoSaveStatus('dirty')
      return false
    }

    saveInFlightRef.current = true
    setSaving(true)
    setAutoSaveStatus('saving')
    const toastId = `doc-autosave:${document.path}`
    notify.dismiss(toastId)

    let savePromise: Promise<boolean>
    savePromise = (async () => {
      try {
        const persistedMarkdown = await persistBlobImageLinks(markdown, document.path)
        const persistedContent = getWorkspaceDocumentStoredContent({
          document,
          format,
          markdown: persistedMarkdown,
        })
        if (
          reason === 'auto'
          && visibleDraftLength(readWorkspaceDocumentDraft(document).markdown) > 100
          && visibleDraftLength(persistedMarkdown) < 5
        ) {
          setAutoSaveStatus('dirty')
          notify.warning(t('document:autosave.contentLoadingSkipped'), {
            id: toastId,
          })
          return false
        }

        const savedDocument = await writeWorkspaceDocument(document.path, persistedContent)
        console.warn('[KITION/persist] write OK path=%s savedLen=%d', savedDocument.path, persistedContent.length)
        const now = Date.now()
        const lastSnapshotAt = autoSnapshotAtRef.current[savedDocument.path] || 0
        if (reason === 'shortcut' || now - lastSnapshotAt > 5 * 60 * 1000) {
          rememberDocumentSnapshot(
            savedDocument,
            persistedContent,
            reason === 'shortcut' ? 'Manual save' : 'Autosave',
          )
          autoSnapshotAtRef.current[savedDocument.path] = now
        }

        if (activeDocumentRef.current?.path === savedDocument.path) {
          setActiveDocument((current) => (
            current?.path === savedDocument.path ? savedDocument : current
          ))
          setTreeItems((items) => updateWorkspaceTreeDocumentItem(items, savedDocument))

          if (persistedMarkdown !== markdown && draftContentRef.current === markdown) {
            setDraftContent(persistedMarkdown)
          }

          const latestContent = getWorkspaceDocumentStoredContent({
            document: savedDocument,
            format: activeDocumentFormatRef.current,
            markdown: draftContentRef.current,
          })
          setAutoSaveStatus(latestContent === persistedContent ? 'saved' : 'dirty')
        } else {
          const currentDocument = activeDocumentRef.current
          if (currentDocument) {
            const currentContent = getWorkspaceDocumentStoredContent({
              document: currentDocument,
              format: activeDocumentFormatRef.current,
              markdown: draftContentRef.current,
            })
            setAutoSaveStatus(currentContent === currentDocument.content ? 'saved' : 'dirty')
          } else {
            setAutoSaveStatus('saved')
          }
        }

        return true
      } catch (requestError: any) {
        console.error('[KITION/persist] save failed path=%s reason=%s', document.path, reason, requestError)
        setAutoSaveStatus('error')
        const failedPath = document.path
        notify.persistentError(t('document:autosave.failed'), {
          label: t('common:actions.retry'),
          onClick: () => {
            if (activeDocumentRef.current?.path === failedPath) {
              void persistActiveDocument('shortcut')
            } else {
              // User moved on — drop the stale toast.
              notify.dismiss(toastId)
            }
          },
        }, {
          id: toastId,
          description: requestError?.message ?? t('document:autosave.failed'),
        })
        return false
      } finally {
        saveInFlightRef.current = false
        if (activeSavePromiseRef.current === savePromise) {
          activeSavePromiseRef.current = null
        }
        setSaving(false)
        if (saveAgainAfterCurrentRef.current) {
          saveAgainAfterCurrentRef.current = false
          if (autoSaveTimerRef.current) {
            window.clearTimeout(autoSaveTimerRef.current)
          }
          autoSaveTimerRef.current = window.setTimeout(() => {
            autoSaveTimerRef.current = null
            void persistActiveDocument('auto')
          }, 250)
        }
      }
    })()
    activeSavePromiseRef.current = savePromise
    return savePromise
  }, [
    activeDocumentFormatRef,
    activeDocumentRef,
    autoSnapshotAtRef,
    draftContentRef,
    editorLockedRef,
    rememberDocumentSnapshot,
    setActiveDocument,
    setDraftContent,
    setSaving,
    setTreeItems,
    t,
  ])

  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    cancelPendingAutoSave()

    if (!activeDocument || activeDocumentFormat === 'data' || editorLocked) {
      setAutoSaveStatus('saved')
      return
    }

    if (!hasUnsavedChanges) {
      if (!saveInFlightRef.current) {
        setAutoSaveStatus('saved')
      }
      return
    }

    setAutoSaveStatus((current) => current === 'saving' ? current : 'dirty')
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null
      void persistActiveDocument('auto')
    }, 300)

    return cancelPendingAutoSave
  }, [
    activeDocument?.path,
    activeDocumentFormat,
    cancelPendingAutoSave,
    draftStoredContent,
    editorLocked,
    hasUnsavedChanges,
    persistActiveDocument,
  ])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        cancelPendingAutoSave()
        void persistActiveDocument('shortcut')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelPendingAutoSave, persistActiveDocument])

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return
    }

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
      void persistActiveDocument('shortcut')
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        void persistActiveDocument('shortcut')
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [hasUnsavedChanges, persistActiveDocument])

  return {
    autoSaveStatus,
    cancelPendingAutoSave,
    persistActiveDocument,
    saveInFlightRef,
    waitForActiveSave,
  }
}
