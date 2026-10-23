import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EditorMode, EditorViewPreferences } from '@/features/workspace/hooks/useWorkspaceChrome'
import { isDesktopRuntime, openWorkspaceFile, type WorkspaceDocument, type WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceTopbarActionsOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  ensureActiveDocumentSaved: () => Promise<boolean>
  hasPendingRevision: boolean
  /** Puts the active document back to its saved file text, as an undoable edit. */
  restoreSavedVersion: () => boolean
  /** Replaces the active document's text as one undoable edit (its session saves it). */
  replaceActiveDocumentText: (text: string, label: string) => boolean
  editorLocked: boolean
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
  restoreSavedVersion,
  replaceActiveDocumentText,
  editorLocked,
  importInputRef,
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
    // The editors of each mode bind to the same replica: switching keeps the text and its undo history.
    setEditorView((current) => ({ ...current, editorMode: mode }))
    setItemMenuOpen(false)
  }, [setEditorView, setItemMenuOpen])

  const restoreSavedDraft = useCallback(() => {
    if (!activeDocument) {
      return
    }

    restoreSavedVersion()
    setFeedback(t('feedback.restoredSavedVersion'))
    setItemMenuOpen(false)
  }, [activeDocument, restoreSavedVersion, setFeedback, setItemMenuOpen, t])

  const importMarkdownFile = useCallback(async (file?: File) => {
    if (!file || editorLocked) {
      return
    }

    try {
      const content = await file.text()
      replaceActiveDocumentText(content, 'import')
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
    editorLocked,
    importInputRef,
    replaceActiveDocumentText,
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
    setEditorMode,
  }
}
