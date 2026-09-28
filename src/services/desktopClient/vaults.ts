/**
 * Workspace roots: choosing and revealing folders, the vault registry, and opening workspace windows.
 */
import { flushWorkspaceEditSessions } from '../workspaceEditSessions'
import type { AgentLocalSource } from '@/types/agentLocalSource'
import { type ChooseDirectoryResponse, type OpenWorkspaceWindowResponse, type SetActiveVaultResponse, type VaultAddRequest, type VaultListResponse, type VaultMutationResponse, getDesktopBridge } from './bridge'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'

export async function revealWorkspaceFolder(path?: string) {
  const bridge = getDesktopBridge()
  if (bridge?.RevealWorkspaceFolder) {
    return bridge.RevealWorkspaceFolder(path ? { path: normalizeWorkspaceDocumentPath(path) } : undefined)
  }
  return ''
}

export async function chooseWorkspaceFolder() {
  await flushWorkspaceEditSessions()
  const bridge = getDesktopBridge()
  if (bridge?.ChooseWorkspaceFolder) {
    return bridge.ChooseWorkspaceFolder()
  }
  return null
}

export async function setWorkspaceFolder(path: string) {
  await flushWorkspaceEditSessions()
  const bridge = getDesktopBridge()
  if (bridge?.SetWorkspaceFolder) {
    return bridge.SetWorkspaceFolder({ path })
  }

  throw new Error('desktop workspace switching is unavailable')
}

export async function listVaults(): Promise<VaultListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ListVaults) {
    return bridge.ListVaults()
  }
  const now = new Date().toISOString()
  return {
    vaults: [{
      path: 'browser-local-workspace',
      name: 'Browser local workspace',
      added_at: now,
      last_opened_at: now,
    }],
    active_vault_path: 'browser-local-workspace',
  }
}

export async function addVault(request: VaultAddRequest): Promise<VaultMutationResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.AddVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.AddVault(request)
}

export async function removeVault(path: string): Promise<VaultListResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.RemoveVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.RemoveVault({ path })
}

export async function renameVault(path: string, name: string): Promise<VaultMutationResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.RenameVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.RenameVault({ path, name })
}

export async function setActiveVault(path: string): Promise<SetActiveVaultResponse> {
  await flushWorkspaceEditSessions()
  const bridge = getDesktopBridge()
  if (!bridge?.SetActiveVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.SetActiveVault({ path })
}

export async function chooseDirectory(title?: string): Promise<ChooseDirectoryResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseDirectory) {
    return { canceled: true, path: '' }
  }
  return bridge.ChooseDirectory({ title })
}

export async function openWorkspaceWindow(path: string): Promise<OpenWorkspaceWindowResponse> {
  const normalizedPath = String(path || '').trim()
  if (!normalizedPath) {
    throw new Error('workspace path is required')
  }
  const bridge = getDesktopBridge()
  if (!bridge?.OpenWorkspaceWindow) {
    throw new Error('opening a workspace in a new window is available in the desktop app')
  }
  return bridge.OpenWorkspaceWindow({ path: normalizedPath })
}

export async function chooseAgentAnalysisDirectory(suggestedPath = ''): Promise<AgentLocalSource | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseAgentAnalysisDirectory) {
    throw new Error('local analysis folders are available in the desktop app')
  }
  return bridge.ChooseAgentAnalysisDirectory({ suggested_path: suggestedPath })
}
