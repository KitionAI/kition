import { useCallback, useEffect, useState } from 'react'
import {
  addVault as addVaultApi,
  chooseDirectory,
  listVaults,
  removeVault as removeVaultApi,
  renameVault as renameVaultApi,
  setActiveVault as setActiveVaultApi,
  type VaultAddRequest,
  type VaultEntry,
  type VaultListResponse,
} from '@/services/desktop'

export type UseWorkspaceVaultsResult = {
  vaults: VaultEntry[]
  activeVaultPath: string
  loaded: boolean
  error: string
  refresh: () => Promise<VaultListResponse>
  addVault: (request: VaultAddRequest) => Promise<VaultEntry>
  removeVault: (path: string) => Promise<void>
  renameVault: (path: string, name: string) => Promise<VaultEntry>
  setActiveVault: (path: string) => Promise<VaultListResponse>
  chooseParentDirectory: (title?: string) => Promise<string>
}

function applyRegistry(
  registry: VaultListResponse,
  setVaults: (vaults: VaultEntry[]) => void,
  setActiveVaultPath: (path: string) => void,
) {
  setVaults(registry.vaults || [])
  setActiveVaultPath(registry.active_vault_path || '')
}

export function useWorkspaceVaults(): UseWorkspaceVaultsResult {
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [activeVaultPath, setActiveVaultPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const registry = await listVaults()
      applyRegistry(registry, setVaults, setActiveVaultPath)
      setError('')
      return registry
    } catch (requestError: any) {
      setError(requestError?.message || 'failed to load workspace registry')
      return { vaults: [], active_vault_path: '' }
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addVault = useCallback(async (request: VaultAddRequest) => {
    const response = await addVaultApi(request)
    applyRegistry(response.registry, setVaults, setActiveVaultPath)
    return response.vault
  }, [])

  const removeVault = useCallback(async (path: string) => {
    const registry = await removeVaultApi(path)
    applyRegistry(registry, setVaults, setActiveVaultPath)
  }, [])

  const renameVault = useCallback(async (path: string, name: string) => {
    const response = await renameVaultApi(path, name)
    applyRegistry(response.registry, setVaults, setActiveVaultPath)
    return response.vault
  }, [])

  const setActiveVault = useCallback(async (path: string) => {
    const response = await setActiveVaultApi(path)
    applyRegistry(response.registry, setVaults, setActiveVaultPath)
    return response.registry
  }, [])

  const chooseParentDirectory = useCallback(async (title?: string) => {
    const response = await chooseDirectory(title)
    if (response.canceled) {
      return ''
    }
    return response.path
  }, [])

  return {
    vaults,
    activeVaultPath,
    loaded,
    error,
    refresh,
    addVault,
    removeVault,
    renameVault,
    setActiveVault,
    chooseParentDirectory,
  }
}
