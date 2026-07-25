import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  inferWorkspaceItemFormat,
  isImageWorkspaceFormat,
  isVideoWorkspaceFormat,
} from '@/features/workspace/lib/workspace'
import type { EditorMode } from '@/features/workspace/hooks/useWorkspaceChrome'
import type { WorkspaceDocument, WorkspaceDocumentFormat, WorkspaceDocumentTreeItem } from '@/services/desktop'
import { resolveWorkspaceImageSources } from '@/services/workspaceFiles'

type UseWorkspaceDerivedStateOptions = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  draftContent: string
  editorLocked: boolean
  editorMode: EditorMode
  files: WorkspaceDocumentTreeItem[]
  itemMenuOpen: boolean
}

export function useWorkspaceDerivedState({
  activeDocument,
  activeDocumentFormat,
  draftContent,
  editorLocked,
  editorMode,
  files,
  itemMenuOpen,
}: UseWorkspaceDerivedStateOptions) {
  const imageFiles = useMemo(
    () => files.filter((item) => isImageWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path))),
    [files],
  )
  const videoFiles = useMemo(
    () => files.filter((item) => isVideoWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path))),
    [files],
  )
  const deferredDraftContent = useDeferredValue(draftContent)
  const [editorPreviewHtml, setEditorPreviewHtml] = useState('')

  useEffect(() => {
    if (editorMode !== 'split' && editorMode !== 'preview') {
      setEditorPreviewHtml('')
      return
    }

    let cancelled = false
    setEditorPreviewHtml('')
    void import('@/services/markdownRenderer').then(({ markdownToHtml }) => {
      if (cancelled) return
      setEditorPreviewHtml(
        resolveWorkspaceImageSources(markdownToHtml(deferredDraftContent), activeDocument?.path || ''),
      )
    }).catch(() => {
      if (!cancelled) setEditorPreviewHtml('')
    })
    return () => {
      cancelled = true
    }
  }, [activeDocument?.path, deferredDraftContent, editorMode])

  const activeItemWordCount = useMemo(
    () => itemMenuOpen ? draftContent.replace(/\s+/g, '').length : 0,
    [draftContent, itemMenuOpen],
  )

  return {
    activeItemWordCount,
    canImportSource: Boolean(activeDocument && !editorLocked && activeDocumentFormat !== 'html'),
    editorPreviewHtml,
    imageFiles,
    videoFiles,
  }
}
