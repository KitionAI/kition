import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { DATA_TABLE_ACTION_EVENT, type TableAction } from '@/features/table/lib/tableActions'
import type { EditorMode, EditorViewPreferences } from '@/features/workspace/hooks/useWorkspaceChrome'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceTopbarActionsOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
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
    importMarkdownFile,
    restoreSavedDraft,
    runActiveDataTableAction,
    setEditorMode,
  }
}
