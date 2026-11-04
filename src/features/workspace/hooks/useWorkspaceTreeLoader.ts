import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getWorkspaceDisplayName,
  readLastActiveDocumentPath,
  rememberRecentWorkspacePath,
} from '@/features/workspace/lib/workspacePersistence'
import {
  flattenWorkspaceDocumentItems,
} from '@/features/workspace/lib/workspaceTree'
import { resolveInitialDocumentPath } from '@/features/workspace/lib/initialDocument'
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

type DocumentListOptions = { treeOnly?: boolean; onlyWhenEmpty?: boolean }

export function useWorkspaceTreeLoader({
  activeDocumentPath,
  applyWorkspaceDocument,
  clearActiveDocumentSession,
  setError,
  setFeedback,
  treeState,
}: UseWorkspaceTreeLoaderOptions) {
  const { t } = useTranslation('workspace')
  const activeDocumentPathRef = useRef(activeDocumentPath)
  useLayoutEffect(() => {
    activeDocumentPathRef.current = activeDocumentPath
  }, [activeDocumentPath])
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
    options?: DocumentListOptions,
  ) => {
    setTreeItems(response.items || [])
    setRootPath(response.root_path || '')

    if (response.root_path) {
      setRecentWorkspacePaths(rememberRecentWorkspacePath(response.root_path))
    }

    // A plain tree refresh should only reconcile the file list, leaving the
    // currently open document untouched.
    if (options?.treeOnly || (options?.onlyWhenEmpty && activeDocumentPathRef.current)) {
      return
    }

    // Loaded on the workflow view (`/workflow…`, a reload there): opening the
    // last document would close it, so keep it until the person leaves it.
    if (!preferredPath && !activeDocumentPath && window.location.pathname.startsWith('/workflow')) {
      return
    }

    const nextPath = resolveInitialDocumentPath(flattenWorkspaceDocumentItems(response.items || []), {
      preferredPath,
      activeDocumentPath,
      lastActivePath: readLastActiveDocumentPath(),
    })

    if (!nextPath) {
      clearActiveDocumentSession()
      return
    }

    const nextDocument = await readWorkspaceDocument(nextPath)
    // Background onboarding must not replace a document selected during the read.
    if (options?.onlyWhenEmpty && activeDocumentPathRef.current) return
    void applyWorkspaceDocument(nextDocument)
  }, [
    activeDocumentPath,
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    setRecentWorkspacePaths,
    setRootPath,
    setTreeItems,
  ])

  const refreshWorkspaceDocuments = useCallback(async (
    preferredPath?: string,
    options?: DocumentListOptions & { silent?: boolean },
  ) => {
    const silent = options?.silent === true
    if (!silent) setLoading(true)
    setError('')

    try {
      const response = await listWorkspaceDocuments()
      await applyWorkspaceDocumentList(response, preferredPath, options)
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
      const detail = (e as CustomEvent<DocumentListOptions & { preferredPath?: string }>).detail
      void refreshWorkspaceDocuments(detail?.preferredPath, {
        treeOnly: detail?.treeOnly === true,
        onlyWhenEmpty: detail?.onlyWhenEmpty === true,
      })
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
