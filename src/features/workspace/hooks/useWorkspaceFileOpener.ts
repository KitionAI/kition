import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { noteWorkspaceFiles, pruneDocumentStoreOnOpen } from '@/lib/docstore/documentIndex'
import { inferWorkspaceItemFormat, isPreviewableWorkspaceFormat } from '@/features/workspace/lib/workspace'
import { writeLastActiveDocumentPath } from '@/features/workspace/lib/workspacePersistence'
import {
  listWorkspaceDocuments,
  openWorkspaceFile,
  subscribeWorkspaceDocumentExternalChanges,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

type UseWorkspaceFileOpenerOptions = {
  files: WorkspaceDocumentTreeItem[]
  /** The workspace root; empty until the workspace is listed. */
  rootPath?: string
  onError: (message: string) => void
  onFeedback: (message: string) => void
  onOpenFileViewerTab: (path: string, format: WorkspaceDocumentFormat) => void
  setTreeItems: Dispatch<SetStateAction<WorkspaceDocumentTreeItem[]>>
}

const errorMessage = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason ?? ''))

/**
 * Opens the workspace's files: a file a kit edits or Kition previews (notes among them) opens in
 * its file tab, any other one in the system's app. Keeps the tree in step with files added or
 * removed on disk, and the document store's index in step with the workspace.
 */
export function useWorkspaceFileOpener({
  files,
  rootPath = '',
  onError,
  onFeedback,
  onOpenFileViewerTab,
  setTreeItems,
}: UseWorkspaceFileOpenerOptions) {
  /** The file the tree shows as selected. */
  const [activeResourcePath, setActiveResourcePath] = useState('')

  /** Shows a file read or made elsewhere (a new file, the last one open at startup) in its tab. */
  function applyWorkspaceDocument(document: WorkspaceDocument) {
    const format = document.format || inferWorkspaceItemFormat(document.path)
    writeLastActiveDocumentPath(document.path)
    setActiveResourcePath(document.path)
    onOpenFileViewerTab(document.path, format)
    return Promise.resolve()
  }

  async function openDocument(path: string) {
    const previousActivePath = activeResourcePath
    flushSync(() => {
      setActiveResourcePath(path)
    })
    onError('')
    onFeedback('')
    try {
      const format = files.find((item) => item.path === path)?.format || inferWorkspaceItemFormat(path)
      if (isPreviewableWorkspaceFormat(format)) {
        writeLastActiveDocumentPath(path)
        onOpenFileViewerTab(path, format)
        return
      }
      const openError = await openWorkspaceFile(path)
      if (openError) {
        setActiveResourcePath(previousActivePath)
        onError(`Failed to open file: ${openError}`)
        return
      }
      onFeedback(`Requested system to open ${path}`)
    } catch (requestError: unknown) {
      setActiveResourcePath(previousActivePath)
      onError(errorMessage(requestError) || 'Failed to open file')
    }
  }

  // A file the tree should show appeared or went away.
  useEffect(() => subscribeWorkspaceDocumentExternalChanges((change) => {
    if (change.eventType === 'add' || change.eventType === 'unlink') {
      void listWorkspaceDocuments()
        .then((workspace) => setTreeItems(workspace.items || []))
        .catch(() => {})
    }
  }), [setTreeItems])

  // The workspace opened: drop the replicas of documents deleted before (once per window). The tree's files
  // spare the store a listing of the workspace each time a document opens.
  useEffect(() => {
    void pruneDocumentStoreOnOpen(rootPath)
  }, [rootPath])
  useEffect(() => {
    noteWorkspaceFiles(rootPath, files)
  }, [rootPath, files])

  return { activeResourcePath, setActiveResourcePath, applyWorkspaceDocument, openDocument }
}
