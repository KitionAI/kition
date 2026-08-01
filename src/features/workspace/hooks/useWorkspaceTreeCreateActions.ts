import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createDocumentWorkspaceEntry,
  type DocumentCreationPreset,
  type DocumentPlatform,
} from '@/features/document/lib/documentCreation'
import { createTableWorkspaceEntry, DEFAULT_NEW_TABLE_FIELDS, DEFAULT_NEW_TABLE_VIEWS, seedDefaultEmptyRows } from '@/features/table/lib/tableCreation'
import type { KitableTemplateDefinition } from '@/features/table/templates/kitableTemplates'
import type { ApplyWorkspaceDocument } from '@/features/workspace/hooks/workspaceTreeActionShared'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import { getChildFolderPathForNode, insertWorkspaceTreeDocumentItem } from '@/features/workspace/lib/workspaceTree'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { createWorkspaceFolder, importWorkspaceFile, type WorkspaceDocument } from '@/services/desktop'
import { listDataDocuments, createDataTable } from '@/api/dataDocuments'

type UseWorkspaceTreeCreateActionsOptions = {
  activeDocumentPath: string
  applyWorkspaceDocument: ApplyWorkspaceDocument
  refreshWorkspaceDocuments: (preferredPath?: string, options?: { silent?: boolean; treeOnly?: boolean }) => Promise<boolean>
  rememberDocumentSnapshot: (document: WorkspaceDocument, content: string, reason: string) => void
  rootPath: string
  setEditorMode: (mode: 'rich' | 'split') => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setSaving: (value: boolean) => void
  setSelectedPlatform: (platform: DocumentPlatform) => void
  treeState: Pick<
    UseWorkspaceTreeStateResult,
    'expandFolders' | 'openCreateFormatMenu' | 'setCreateMenuOpen' | 'setTreeItems'
  >
}

export function useWorkspaceTreeCreateActions({
  activeDocumentPath,
  applyWorkspaceDocument,
  refreshWorkspaceDocuments,
  rememberDocumentSnapshot,
  rootPath,
  setEditorMode,
  setError,
  setFeedback,
  setSaving,
  setSelectedPlatform,
  treeState,
}: UseWorkspaceTreeCreateActionsOptions) {
  const { t } = useTranslation('workspace')
  const { expandFolders, openCreateFormatMenu, setCreateMenuOpen, setTreeItems } = treeState

  const createDocument = useCallback(async (
    platform: DocumentPlatform,
    folderOverride?: string,
    preset?: DocumentCreationPreset,
  ): Promise<boolean> => {
    setSaving(true)
    setError('')
    setFeedback('')
    setCreateMenuOpen(false)

    try {
      const { document } = await createDocumentWorkspaceEntry({
        activeDocumentPath,
        folderOverride,
        platform,
        preset,
      })
      setSelectedPlatform(platform)
      applyWorkspaceDocument(document)
      expandFolders(getAncestorFolderPaths(document.path))
      setEditorMode('rich')
      rememberDocumentSnapshot(document, document.content, 'New document')
      setFeedback(t('workspace:feedback.documentCreated'))
                                                             
                                                   
                                                        
      setTreeItems((current) => insertWorkspaceTreeDocumentItem(current, document))
      return true
    } catch (requestError: any) {
      setError(requestError?.message || t('errors.createDocumentFailed'))
      return false
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    applyWorkspaceDocument,
    expandFolders,
    rememberDocumentSnapshot,
    setCreateMenuOpen,
    setEditorMode,
    setError,
    setFeedback,
    setSaving,
    setSelectedPlatform,
    setTreeItems,
    t,
  ])

  const createTable = useCallback(async (
    folderOverride?: string,
    template?: KitableTemplateDefinition,
  ): Promise<
    { documentId: number; kitablePath: string; tableId: number | null; tableIdsByTitle: Record<string, number>; tableTitle: string } | null
  > => {
    setSaving(true)
    setError('')
    setFeedback('')
    setCreateMenuOpen(false)

    try {
      const { document, documentId, tableId, tableIdsByTitle, tableTitle } = await createTableWorkspaceEntry({
        activeDocumentPath,
        folderOverride,
        rootPath,
        template,
      })
      setFeedback(t('workspace:feedback.tableCreated'))
      expandFolders(getAncestorFolderPaths(document.path))
                                             
                                                           
                               
                                                               
                                                               
      await refreshWorkspaceDocuments(activeDocumentPath || undefined, { silent: true, treeOnly: true })
      if (tableId != null) {
        window.dispatchEvent(new CustomEvent('kition:data-document:table:create', {
          detail: { vaultPath: document.path, tableId },
        }))
      }
      return { documentId, kitablePath: document.path, tableId, tableIdsByTitle, tableTitle }
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to create table document')
      return null
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    expandFolders,
    refreshWorkspaceDocuments,
    rootPath,
    setCreateMenuOpen,
    setError,
    setFeedback,
    setSaving,
    t,
  ])

  const createFolder = useCallback(async (folderOverride?: string, name?: string) => {
    const defaultName = 'Untitled folder'
    const nextName = String(name || '').trim() || defaultName
    setSaving(true)
    setError('')
    setFeedback('')
    setCreateMenuOpen(false)

    try {
      const response = await createWorkspaceFolder({
        parent_folder: folderOverride || '',
        name: nextName,
      })
      expandFolders([folderOverride, response.created_path].filter((p): p is string => Boolean(p)))
      setFeedback(t('feedback.folderCreated'))
                                                                
                                         
      await refreshWorkspaceDocuments(activeDocumentPath || undefined, { silent: true, treeOnly: true })
      return true
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to create folder')
      return false
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    expandFolders,
    refreshWorkspaceDocuments,
    setCreateMenuOpen,
    setError,
    setFeedback,
    setSaving,
    t,
  ])

  const createDocumentInside = useCallback(async (node: WorkspaceTreeNode) => {
    const folder = getChildFolderPathForNode(node)
    expandFolders([node.path, folder])
    openCreateFormatMenu(folder, node.path)
  }, [expandFolders, openCreateFormatMenu])

  const createTableInsideKitable = useCallback(async (kitablePath: string) => {
    setSaving(true)
    setError('')
    setFeedback('')
    setCreateMenuOpen(false)
    try {
      const docs = await listDataDocuments({ workspace_root: rootPath })
      const doc = (docs.items || []).find((d) => d.path === kitablePath)
      if (!doc) throw new Error(t('errors.kitableNotFound'))
      const created = await createDataTable(doc.id, {
        title: 'Untitled table',
        fields: DEFAULT_NEW_TABLE_FIELDS,
        views: DEFAULT_NEW_TABLE_VIEWS,
      })
      if (created?.id != null) {
        await seedDefaultEmptyRows(doc.id, created.id)
      }
      setFeedback(t('feedback.tableCreated'))
                                                          
                                                              
                                                              
                                                                   
                                   
      if (created?.id != null) {
        window.dispatchEvent(new CustomEvent('kition:data-document:table:create', {
          detail: { vaultPath: kitablePath, tableId: created.id },
        }))
      }
      return { docId: doc.id, tableId: created.id }
    } catch (requestError: any) {
      setError(requestError?.message || t('errors.createTableFailed'))
      return null
    } finally {
      setSaving(false)
    }
  }, [rootPath, setCreateMenuOpen, setError, setFeedback, setSaving, t])

  const importBrowserFiles = useCallback(async (
    inputs: WorkspaceImportInput[],
    folder?: string,
  ): Promise<string[]> => {
    const entries = inputs
      .map(toImportEntry)
      .filter((entry): entry is WorkspaceImportEntry => Boolean(entry && entry.file && entry.relativePath))
    if (!entries.length) {
      return []
    }
    setSaving(true)
    setError('')
    setFeedback('')
    setCreateMenuOpen(false)

    const importedPaths: string[] = []
    const expandedFolders = new Set<string>()
    try {
      for (const entry of entries) {
        const destFolder = joinWorkspaceFolderPath(folder, getRelativeDir(entry.relativePath))
        const filename = getRelativeBase(entry.relativePath)
        const base64 = await readFileAsBase64(entry.file)
        const response = await importWorkspaceFile({
          folder: destFolder,
          filename,
          base64_content: base64,
        })
        if (response?.imported_path) {
          importedPaths.push(response.imported_path)
          if (destFolder) {
            expandedFolders.add(destFolder)
          }
        }
      }
      if (importedPaths.length) {
        setFeedback(`Imported ${importedPaths.length} ${importedPaths.length === 1 ? 'file' : 'files'}`)
        if (folder) {
          expandedFolders.add(folder)
        }
        if (expandedFolders.size) {
          expandFolders([...expandedFolders])
        }
        await refreshWorkspaceDocuments(undefined, { silent: true })
      }
      return importedPaths
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to import files')
      return importedPaths
    } finally {
      setSaving(false)
    }
  }, [
    expandFolders,
    refreshWorkspaceDocuments,
    setCreateMenuOpen,
    setError,
    setFeedback,
    setSaving,
  ])

  return {
    createDocument,
    createDocumentInside,
    createFolder,
    createTable,
    createTableInsideKitable,
    importBrowserFiles,
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Unexpected file read result'))
        return
      }
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export type WorkspaceImportEntry = {
  file: File
  relativePath: string
}

export type WorkspaceImportInput = File | WorkspaceImportEntry

function toImportEntry(input: WorkspaceImportInput): WorkspaceImportEntry | null {
  if (!input) {
    return null
  }
  if (input instanceof File) {
    if (!input.name) {
      return null
    }
    return { file: input, relativePath: input.name }
  }
  if (!input.file || !input.file.name) {
    return null
  }
  const relativePath = sanitizeRelativePath(input.relativePath) || input.file.name
  return { file: input.file, relativePath }
}

function sanitizeRelativePath(relativePath: string | undefined): string {
  if (!relativePath) {
    return ''
  }
  return String(relativePath)
    .replace(/\\+/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function getRelativeDir(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/')
  return idx >= 0 ? relativePath.slice(0, idx) : ''
}

function getRelativeBase(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/')
  return idx >= 0 ? relativePath.slice(idx + 1) : relativePath
}

function joinWorkspaceFolderPath(base: string | undefined, sub: string): string {
  const baseSegments = (base || '')
    .replace(/\\+/g, '/')
    .split('/')
    .filter(Boolean)
  const subSegments = sub
    .split('/')
    .filter(Boolean)
  return [...baseSegments, ...subSegments].join('/')
}

function getAncestorFolderPaths(filePath: string): string[] {
  const segments = String(filePath || '').replace(/\\+/g, '/').split('/').filter(Boolean)
  if (segments.length <= 1) return []
  const result: string[] = []
  for (let i = 1; i < segments.length; i++) {
    result.push(segments.slice(0, i).join('/'))
  }
  return result
}
