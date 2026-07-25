import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getWorkspaceDisplayName,
  readLastActiveDocumentPath,
  rememberRecentWorkspacePath,
} from '@/features/workspace/lib/workspacePersistence'
import {
  flattenWorkspaceDocumentItems,
} from '@/features/workspace/lib/workspaceTree'
import {
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
} from '@/features/workspace/lib/workspace'
import type { ApplyWorkspaceDocument } from '@/features/workspace/hooks/workspaceTreeActionShared'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import {
  chooseWorkspaceFolder,
  isDesktopRuntime,
  listWorkspaceDocuments,
  readWorkspaceDocument,
  revealWorkspaceFolder,
  setWorkspaceFolder,
  type WorkspaceDocument,
  type WorkspaceDocumentListResponse,
} from '@/services/desktop'

type UseWorkspaceTreeLoaderOptions = {
  activeDocumentPath: string
  applyWorkspaceDocument: ApplyWorkspaceDocument
  clearActiveDocumentSession: () => void
  hasDocumentSnapshot: (path: string) => boolean
  rememberDocumentSnapshot: (document: WorkspaceDocument, content: string, reason: string) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
  treeState: Pick<
    UseWorkspaceTreeStateResult,
    | 'setLoading'
    | 'setRecentWorkspacePaths'
    | 'setRootPath'
    | 'setTreeItems'
    | 'rootPath'
  >
}

export function useWorkspaceTreeLoader({
  activeDocumentPath,
  applyWorkspaceDocument,
  clearActiveDocumentSession,
  hasDocumentSnapshot,
  rememberDocumentSnapshot,
  setError,
  setFeedback,
  treeState,
}: UseWorkspaceTreeLoaderOptions) {
  const { t } = useTranslation('workspace')
  const {
    rootPath,
    setLoading,
    setRecentWorkspacePaths,
    setRootPath,
    setTreeItems,
  } = treeState

  const applyWorkspaceDocumentList = useCallback(async (
    response: WorkspaceDocumentListResponse,
    preferredPath?: string,
    options?: { treeOnly?: boolean },
  ) => {
    setTreeItems(response.items || [])
    setRootPath(response.root_path || '')

    if (response.root_path) {
      setRecentWorkspacePaths(rememberRecentWorkspacePath(response.root_path))
    }

    // A plain tree refresh should only reconcile the file list, leaving the
    // currently open document untouched.
    if (options?.treeOnly) {
      return
    }

    const nextFiles = flattenWorkspaceDocumentItems(response.items || [])
    const editableFiles = nextFiles.filter((item) => (
      isEditableWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path))
    ))
    const lastActivePath = readLastActiveDocumentPath()
    const homePath = editableFiles.find((item) => item.path === 'Home.md')?.path || ''
    const candidatePath = preferredPath || activeDocumentPath || lastActivePath || homePath || ''
    const nextPath = candidatePath && editableFiles.some((item) => item.path === candidatePath)
      ? candidatePath
      : editableFiles[0]?.path || ''

    if (!nextPath) {
      clearActiveDocumentSession()
      return
    }

    const nextDocument = await readWorkspaceDocument(nextPath)
    applyWorkspaceDocument(nextDocument)
    if (!hasDocumentSnapshot(nextDocument.path)) {
      rememberDocumentSnapshot(nextDocument, nextDocument.content, 'Initial version')
    }
  }, [
    activeDocumentPath,
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    hasDocumentSnapshot,
    rememberDocumentSnapshot,
    setRecentWorkspacePaths,
    setRootPath,
    setTreeItems,
  ])

  const refreshWorkspaceDocuments = useCallback(async (
    preferredPath?: string,
    options?: { silent?: boolean; treeOnly?: boolean },
  ) => {
    const silent = options?.silent === true
    if (!silent) setLoading(true)
    setError('')

    try {
      const response = await listWorkspaceDocuments()
      await applyWorkspaceDocumentList(response, preferredPath, { treeOnly: options?.treeOnly })
      return true
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to load local document library')
      return false
    } finally {
      if (!silent) setLoading(false)
    }
  }, [applyWorkspaceDocumentList, setError, setLoading])

  useEffect(() => {
    void refreshWorkspaceDocuments()
    // Only load the local workspace once when entering the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ preferredPath?: string; treeOnly?: boolean }>).detail
      void refreshWorkspaceDocuments(detail?.preferredPath, { treeOnly: detail?.treeOnly === true })
    }
    window.addEventListener('kition:workspace-reload', handler)
    return () => window.removeEventListener('kition:workspace-reload', handler)
  }, [refreshWorkspaceDocuments])

  const openWorkspaceFolder = useCallback(async (path?: string) => {
    setError('')
    setFeedback('')

    if (!isDesktopRuntime()) {
      setError(t('errors.browserDevModeOpenDirectory'))
      return
    }

    try {
      const openError = await revealWorkspaceFolder(path)
      if (openError) {
        setError(`Failed to open folder: ${openError}`)
        return
      }
      setFeedback(path ? 'Requested system to reveal the folder' : 'Requested system to open the local document folder')
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to open folder')
    }
  }, [setError, setFeedback, t])

  const chooseWorkspaceRoot = useCallback(async () => {
    setError('')
    setFeedback('')
    setLoading(true)

    if (!isDesktopRuntime()) {
      setError(t('errors.browserDevModePickDirectory'))
      setLoading(false)
      return
    }

    try {
      const response = await chooseWorkspaceFolder()
      if (!response) {
        return
      }
      await applyWorkspaceDocumentList(response)
      setFeedback(`Switched to ${getWorkspaceDisplayName(response.root_path)}`)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to switch folder')
    } finally {
      setLoading(false)
    }
  }, [applyWorkspaceDocumentList, setError, setFeedback, setLoading, t])

  const switchWorkspaceRoot = useCallback(async (path: string) => {
    setError('')
    setFeedback('')

    if (path === rootPath) {
      return
    }

    if (!isDesktopRuntime()) {
      setError(t('errors.browserDevModeSwitchDirectory'))
      return
    }

    setLoading(true)
    try {
      const response = await setWorkspaceFolder(path)
      await applyWorkspaceDocumentList(response)
      setFeedback(`Switched to ${getWorkspaceDisplayName(response.root_path)}`)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to switch folder')
    } finally {
      setLoading(false)
    }
  }, [applyWorkspaceDocumentList, rootPath, setError, setFeedback, setLoading, t])

  return {
    applyWorkspaceDocumentList,
    chooseWorkspaceRoot,
    openWorkspaceFolder,
    refreshWorkspaceDocuments,
    switchWorkspaceRoot,
  }
}
