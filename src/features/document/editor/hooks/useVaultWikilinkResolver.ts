   
                                  
  
                                                             
                                                        
                                                                    
                                                             
                                                     
   

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import {
  clearVaultFileCache,
  loadVaultLinkableFiles,
} from '@/features/document/editor/vault/vault-files'
import type { VaultTreeItem } from '@/features/document/editor/vault/vault-client'

type FileLike = Pick<VaultTreeItem, 'path'>

function normalizeWorkspacePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.trim().replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

function stripLinkExt(p: string): string {
  return p.replace(/\.(md|kitable)$/i, '')
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

                                  
export function matchWikilinkTarget(
  files: readonly FileLike[],
  target: string,
  sourcePath?: string,
): string | null {
  const rawTarget = target.trim().replace(/\\/g, '/')
  const targetPath = normalizeWorkspacePath(rawTarget)
  const targetKey = stripLinkExt(targetPath).toLowerCase()
  const findExactPath = (path: string): string | null => {
    const key = stripLinkExt(normalizeWorkspacePath(path)).toLowerCase()
    for (const file of files) {
      if (stripLinkExt(normalizeWorkspacePath(file.path)).toLowerCase() === key) return file.path
    }
    return null
  }

  if (rawTarget.startsWith('/')) {
    return findExactPath(rawTarget.slice(1))
  }

  const sourceDirectory = sourcePath
    ? normalizeWorkspacePath(sourcePath).split('/').slice(0, -1).join('/')
    : ''

  if (rawTarget.includes('/')) {
    if (!rawTarget.startsWith('./') && !rawTarget.startsWith('../')) {
      const rootMatch = findExactPath(targetPath)
      if (rootMatch) return rootMatch
    }
    if (sourceDirectory) {
      const relativeMatch = findExactPath(`${sourceDirectory}/${rawTarget}`)
      if (relativeMatch) return relativeMatch
    }
    return null
  }

  if (sourceDirectory) {
    const siblingMatch = findExactPath(`${sourceDirectory}/${targetPath}`)
    if (siblingMatch) return siblingMatch
  }

                                     
  for (const f of files) {
    if (stripLinkExt(basename(f.path)).toLowerCase() === targetKey) return f.path
  }
  return null
}

type StoreState = { files: VaultTreeItem[]; version: number }

let storeState: StoreState = { files: [], version: 0 }
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot(): StoreState {
  return storeState
}

async function refresh() {
  try {
    const files = await loadVaultLinkableFiles()
    storeState = { files, version: storeState.version + 1 }
    emit()
  } catch {
    /* swallow; resolver returns null on miss anyway */
  }
}

export function invalidateVaultWikilinkResolver(): void {
  clearVaultFileCache()
  void refresh()
}

                                                                      
                                                                   
                                              
                                   
if (typeof window !== 'undefined') {
  window.addEventListener('kition:workspace-reload', () => {
    invalidateVaultWikilinkResolver()
  })
}

export function useVaultWikilinkResolver() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (state.version === 0) void refresh()
  }, [state.version])

  const resolvePath = useCallback(
    (target: string, sourcePath?: string): string | null => (
      matchWikilinkTarget(state.files, target, sourcePath)
    ),
    [state.files],
  )

  const resolve = useCallback(
    (target: string, sourcePath?: string): boolean => resolvePath(target, sourcePath) != null,
    [resolvePath],
  )

  return useMemo(
    () => ({ resolve, resolvePath, snapshotVersion: state.version }),
    [resolve, resolvePath, state.version],
  )
}
