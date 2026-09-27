import { useCallback, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { createDataDashboardByPath } from '@/api/dashboards'
import type { FormSyncWorkflow } from '@/api/formSync'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { buildKitableWorkspaceTabId, getKitableWorkspaceTabTitle } from '@/features/workspace/lib/workspace'
import type { WorkspaceTreeMetadata } from '@/features/workspace/lib/workspacePersistence'
import { notify } from '@/lib/notify'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

export type FormSyncCreateState = {
  kitablePath: string
  documentId: string
  initialTableId?: number
}

export type TableFileImportState = {
  file: File
  folder?: string
}

type UseWorkspaceCreateFlowsOptions = {
  activeWorkspaceTab: WorkspaceTab | undefined
  kitableChildrenIndex: Pick<KitableChildrenIndex, 'docIdByKitablePath' | 'tablesByKitablePath' | 'refresh'>
  /** Folder the create menu was opened for; new items land there. */
  createMenuFolder: string
  createFolder: TreeActions['createFolder']
  createTableInsideKitable: TreeActions['createTableInsideKitable']
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  updateTreeMetadata: (updater: (metadata: WorkspaceTreeMetadata) => WorkspaceTreeMetadata) => void
  openKitableDashboard: (kitablePath: string, dashboardId: string) => void
  openKitableWorkflow: (kitablePath: string, workflowId?: string) => void
  setError: (message: string) => void
}

function tableTab(kitablePath: string, tableId: number): WorkspaceTab {
  return {
    id: buildKitableWorkspaceTabId(kitablePath),
    type: 'table',
    title: getKitableWorkspaceTabTitle(kitablePath),
    kitablePath,
    tableId,
    format: 'data',
  }
}

/**
 * The create entry points that are not template pickers: the new-folder
 * dialog, the table file import (hidden file input plus dialog), the
 * create menu opened on a .kitable container, and the sidebar actions that
 * add a table, dashboard, or form to a kitable.
 */
export function useWorkspaceCreateFlows({
  activeWorkspaceTab,
  kitableChildrenIndex,
  createMenuFolder,
  createFolder,
  createTableInsideKitable,
  upsertWorkspaceTab,
  setActiveResourcePath,
  updateTreeMetadata,
  openKitableDashboard,
  openKitableWorkflow,
  setError,
}: UseWorkspaceCreateFlowsOptions) {
  const { t } = useTranslation('workspace')

  // New folder dialog.
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const openFolderDialog = useCallback(() => {
    setFolderName('')
    setFolderDialogOpen(true)
  }, [])
  const setFolderDialogVisible = useCallback((open: boolean) => {
    setFolderDialogOpen(open)
    if (!open) setFolderName('')
  }, [])
  const submitFolderDialog = useCallback(async () => {
    const created = await createFolder(createMenuFolder, folderName)
    if (!created) return
    setFolderDialogOpen(false)
    setFolderName('')
  }, [createFolder, createMenuFolder, folderName])

  // Table file import: a hidden input picks the file, then the dialog runs the import.
  const [tableFileImportState, setTableFileImportState] = useState<TableFileImportState | null>(null)
  const tableFileImportFolderRef = useRef('')
  const tableFileImportInputRef = useRef<HTMLInputElement | null>(null)
  const requestTableFileImport = useCallback((folder: string) => {
    tableFileImportFolderRef.current = folder
    tableFileImportInputRef.current?.click()
  }, [])
  const handleTableFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      setTableFileImportState({ file, folder: tableFileImportFolderRef.current || undefined })
    }
    event.currentTarget.value = ''
  }, [])
  const closeTableFileImport = useCallback(() => setTableFileImportState(null), [])

  // Create menu opened on a .kitable container: "New table" creates inside it.
  const [kitableCreateContext, setKitableCreateContext] = useState<string | null>(null)
  const createMenuVariant: 'workspace' | 'kitable' = kitableCreateContext ? 'kitable' : 'workspace'
  const createTableFromCreateMenu = useCallback(async () => {
    const captured = kitableCreateContext
    if (!captured) return false
    const result = await createTableInsideKitable(captured)
    setKitableCreateContext(null)
    if (result) {
      updateTreeMetadata((current) => (
        current.collapsed.includes(captured) ? current : { ...current, collapsed: [...current.collapsed, captured] }
      ))
      upsertWorkspaceTab(tableTab(captured, result.tableId))
      void kitableChildrenIndex.refresh()
    }
    return true
  }, [createTableInsideKitable, kitableChildrenIndex, kitableCreateContext, updateTreeMetadata, upsertWorkspaceTab])

  // Sidebar actions on a kitable.
  const createTableFromKitableSidebar = useCallback(async (kitablePath: string) => {
    const result = await createTableInsideKitable(kitablePath)
    if (!result || result.tableId == null) return
    upsertWorkspaceTab(tableTab(kitablePath, result.tableId))
    setActiveResourcePath(kitablePath)
    void kitableChildrenIndex.refresh()
  }, [createTableInsideKitable, kitableChildrenIndex, setActiveResourcePath, upsertWorkspaceTab])

  const currentTableIdFor = useCallback((kitablePath: string) => (
    activeWorkspaceTab?.type === 'table' && activeWorkspaceTab.kitablePath === kitablePath
      ? activeWorkspaceTab.tableId
      : undefined
  ), [activeWorkspaceTab])

  const createDashboardFromKitableSidebar = useCallback(async (kitablePath: string) => {
    try {
      const created = await createDataDashboardByPath(kitablePath, currentTableIdFor(kitablePath))
      await kitableChildrenIndex.refresh()
      openKitableDashboard(kitablePath, created.dashboard.id)
      notify.success(t('feedback.dashboardCreated'))
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('errors.createDashboardFailed'))
    }
  }, [currentTableIdFor, kitableChildrenIndex, openKitableDashboard, setError, t])

  const [formSyncCreateState, setFormSyncCreateState] = useState<FormSyncCreateState | null>(null)
  const createFormFromKitableSidebar = useCallback((kitablePath: string) => {
    const documentId = kitableChildrenIndex.docIdByKitablePath[kitablePath]
    if (!documentId) {
      setError(t('errors.kitableNotFound'))
      return
    }
    const initialTableId = currentTableIdFor(kitablePath) ?? kitableChildrenIndex.tablesByKitablePath[kitablePath]?.[0]?.id
    setFormSyncCreateState({ kitablePath, documentId, initialTableId })
  }, [currentTableIdFor, kitableChildrenIndex, setError, t])
  const closeFormSyncCreate = useCallback(() => setFormSyncCreateState(null), [])
  const handleFormSyncCreated = useCallback((workflow: FormSyncWorkflow) => {
    const state = formSyncCreateState
    if (!state) return
    void kitableChildrenIndex.refresh()
    openKitableWorkflow(state.kitablePath, workflow.id)
    setFormSyncCreateState(null)
  }, [formSyncCreateState, kitableChildrenIndex, openKitableWorkflow])

  return {
    folderDialogOpen,
    folderName,
    setFolderName,
    openFolderDialog,
    setFolderDialogVisible,
    submitFolderDialog,
    tableFileImportState,
    tableFileImportInputRef,
    requestTableFileImport,
    handleTableFileInputChange,
    closeTableFileImport,
    kitableCreateContext,
    setKitableCreateContext,
    createMenuVariant,
    createTableFromCreateMenu,
    createTableFromKitableSidebar,
    createDashboardFromKitableSidebar,
    createFormFromKitableSidebar,
    formSyncCreateState,
    closeFormSyncCreate,
    handleFormSyncCreated,
  }
}
