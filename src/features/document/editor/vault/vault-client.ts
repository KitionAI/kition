   
               
  
                                                            
                                                             
  
                         
   

import {
  createWorkspaceDocument,
  deleteWorkspaceDocument,
  listWorkspaceDocuments,
  moveWorkspaceDocument,
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentListResponse,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'

export type VaultFile = WorkspaceDocument
export type VaultTreeItem = WorkspaceDocumentTreeItem
export type VaultListResponse = WorkspaceDocumentListResponse

export const vaultClient = {
  list: (): Promise<VaultListResponse> => listWorkspaceDocuments(),

  read: (path: string): Promise<VaultFile> => readWorkspaceDocument(path),

  write: (path: string, content: string): Promise<VaultFile> =>
    writeWorkspaceDocument(path, content),

  create: (params: { title?: string; folder?: string; format?: 'markdown' }): Promise<VaultFile> =>
    createWorkspaceDocument({
      title: params.title,
      folder: params.folder,
      format: params.format ?? 'markdown',
    }),

  move: (path: string, target: { folder?: string; name?: string }): Promise<VaultFile> =>
    moveWorkspaceDocument({ path, target_folder: target.folder, target_name: target.name }),

  delete: (path: string): Promise<VaultListResponse> => deleteWorkspaceDocument(path),
}
