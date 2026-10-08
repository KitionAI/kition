import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DATA_TABLE_ACTION_EVENT, type TableAction } from '@/features/table/lib/tableActions'
import type { EditorMode, EditorViewPreferences } from '@/features/workspace/hooks/useWorkspaceChrome'
import { isDesktopRuntime, openWorkspaceFile, type WorkspaceDocument, type WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceTopbarActionsOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  ensureActiveDocumentSaved: () => Promise<boolean>
  hasPendingRevision: boolean
  applyWorkspaceDocument: (document: WorkspaceDocument, options?: { resetEditor?: boolean; restoreFromCache?: boolean }) => void
  bumpEditorReset: () => void
  editorLocked: boolean
  setDraftContent: Dispatch<SetStateAction<string>>
  setEditorView: Dispatch<SetStateAction<EditorViewPreferences>>
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setItemMenuOpen: Dispatch<SetStateAction<boolean>>
  importInputRef: MutableRefObject<HTMLInputElement | null>
}

export function useWorkspaceTopbarActions({
  activeDocument,
  activeDocumentFormat,
  ensureActiveDocumentSaved,
  hasPendingRevision,
  applyWorkspaceDocument,
  bumpEditorReset,
  editorLocked,
  importInputRef,
  setDraftContent,
  setEditorView,
  setError,
  setFeedback,
  setItemMenuOpen,
}: UseWorkspaceTopbarActionsOptions) {
  const { t } = useTranslation('workspace')
  const [openingInSystem, setOpeningInSystem] = useState(false)
  const openingRef = useRef(false)
  const openDocumentInSystem = useCallback(async () => {
    if (!activeDocument || activeDocumentFormat !== 'markdown' || openingRef.current) return
    setItemMenuOpen(false)
    if (hasPendingRevision) {
      setError(t('errors.reviewBeforeExternalOpen'))
      return
    }
    openingRef.current = true
    setOpeningInSystem(true)
    try {
      if (!await ensureActiveDocumentSaved()) return
      await openWorkspaceFile(activeDocument.path)
    } catch {
      setError(t('errors.openInSystemFailed'))
    } finally {
      openingRef.current = false
      setOpeningInSystem(false)
    }
  }, [activeDocument, activeDocumentFormat, ensureActiveDocumentSaved, hasPendingRevision, setError, setItemMenuOpen, t])

  const setEditorMode = useCallback((mode: EditorMode) => {
    setEditorView((current) => ({ ...current, editorMode: mode }))
    bumpEditorReset()
    setItemMenuOpen(false)
  }, [bumpEditorReset, setEditorView, setItemMenuOpen])

  const restoreSavedDraft = useCallback(() => {
    if (!activeDocument) {
      return
    }

    applyWorkspaceDocument(activeDocument)
    setFeedback(t('feedback.restoredSavedVersion'))
    setItemMenuOpen(false)
  }, [activeDocument, applyWorkspaceDocument, setFeedback, setItemMenuOpen, t])

  const runActiveDataTableAction = useCallback((action: TableAction) => {
    if (!activeDocument || activeDocumentFormat !== 'data') {
      return
    }

    window.dispatchEvent(new CustomEvent(DATA_TABLE_ACTION_EVENT, {
      detail: { documentPath: activeDocument.path, action },
    }))
    setItemMenuOpen(false)
  }, [activeDocument, activeDocumentFormat, setItemMenuOpen])

  const importMarkdownFile = useCallback(async (file?: File) => {
    if (!file || editorLocked) {
      return
    }

    try {
      const content = await file.text()
      setDraftContent(content)
      bumpEditorReset()
      setFeedback(`Imported ${file.name}. It will be saved back to the current document automatically.`)
    } catch {
      setError(t('errors.importMarkdownFailed'))
    } finally {
      setItemMenuOpen(false)
      if (importInputRef.current) {
        importInputRef.current.value = ''
      }
    }
  }, [
    bumpEditorReset,
    editorLocked,
    importInputRef,
    setDraftContent,
    setError,
    setFeedback,
    setItemMenuOpen,
    t,
  ])

  return {
    openDocumentInSystem,
    openingInSystem,
    canOpenInSystem: isDesktopRuntime(),
    importMarkdownFile,
    restoreSavedDraft,
    runActiveDataTableAction,
    setEditorMode,
  }
}
