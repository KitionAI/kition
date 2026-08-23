import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceMediaKind, WorkspaceTab } from '@/features/workspace/lib/workspace'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  getWorkspaceItemTitle,
  remapWorkspaceBranchPath,
} from '@/features/workspace/lib/workspace'
import { readWorkspaceTabs, writeWorkspaceTabs } from '@/features/workspace/lib/workspacePersistence'

type UseWorkspaceTabsOptions = {
  rootPath: string
  activeDocumentPath: string
  onOpenDocument: (path: string) => Promise<void>
  onActivateGallery: (kind: WorkspaceMediaKind) => void
  onCloseDocumentTab?: (tab: Extract<WorkspaceTab, { type: 'document' }>) => void
}

function getTabKitablePath(tab: WorkspaceTab) {
  if (tab.type === 'table') return tab.kitablePath
  if (tab.type === 'dashboard') return tab.kitablePath
  if (tab.type === 'workflow') return tab.kitablePath || ''
  if (tab.type === 'document' && tab.path.toLowerCase().endsWith('.kitable')) return tab.path
  return ''
}

export function useWorkspaceTabs({
  rootPath,
  activeDocumentPath,
  onOpenDocument,
  onActivateGallery,
  onCloseDocumentTab,
}: UseWorkspaceTabsOptions) {
  const initialTabsRef = useRef<WorkspaceTab[] | null>(null)
  if (initialTabsRef.current === null) {
    initialTabsRef.current = readWorkspaceTabs(rootPath)
  }
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>(() => initialTabsRef.current || [])
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(() => initialTabsRef.current?.[0]?.id || '')
  const [tabsRoot, setTabsRoot] = useState(rootPath)

  // Snapshot of the workspaceTabs / active id at the last COMMITTED render.
  // The atomic switch below uses it to tell apart tabs that came from the old
  // workspace's state (drop) versus tabs upserted in the same React batch as
  // the rootPath change (keep). Updated in an effect so it always reflects
  // what React has actually committed, never an in-flight intermediate render.
  const lastCommittedTabsRef = useRef<WorkspaceTab[]>([])
  const lastCommittedActiveIdRef = useRef('')

  // Atomic workspace switch: when rootPath changes between two real workspaces
  // we synchronously swap the open tab list. Calling setState during render
  // makes React discard the in-progress render and re-render with the new
  // values, so the persistence effect below never sees a stale-tabs/new-root
  // combination.
  //
  // We CANNOT replace workspaceTabs with `readWorkspaceTabs(rootPath)` outright:
  // the production flow batches `setRootPath(B)` with `upsertWorkspaceTab(B-home)`
  // (refreshWorkspaceDocuments calls both inside the same async function), so
  // by the time the atomic switch runs, `current` already contains the upserted
  // B-tab queued behind the rootPath change. Anything in `current` that wasn't
  // in the LAST committed state was added by such an upsert — those are tabs
  // for the new workspace and must be preserved.
  //
  // The empty→real transition (initial mount, before the vault registry has
  // loaded) is NOT a workspace switch — keep the existing merge logic so an
  // active document opened before the registry resolved survives.
  if (tabsRoot && tabsRoot !== rootPath) {
    setTabsRoot(rootPath)
    setWorkspaceTabs((current) => {
      const stored = readWorkspaceTabs(rootPath)
      const lastCommittedIds = new Set(lastCommittedTabsRef.current.map((tab) => tab.id))
      const inBatchAdditions = current.filter((tab) => !lastCommittedIds.has(tab.id))
      if (inBatchAdditions.length === 0) {
        return stored
      }
      const additionIds = new Set(inBatchAdditions.map((tab) => tab.id))
      return [...stored.filter((tab) => !additionIds.has(tab.id)), ...inBatchAdditions]
    })
    setActiveWorkspaceTabId((currentActive) => {
      if (!currentActive) return readWorkspaceTabs(rootPath)[0]?.id || ''
      // If the currently-active id matches what was committed before the
      // switch, it points at a stale tab from the previous workspace — select
      // the first restored tab for the new workspace instead. Otherwise it was
      // set by an in-batch upsert for the new workspace; keep it.
      return currentActive === lastCommittedActiveIdRef.current
        ? readWorkspaceTabs(rootPath)[0]?.id || ''
        : currentActive
    })
  } else if (!tabsRoot && rootPath) {
    // First real rootPath arrives: record it without resetting state. Any tabs
    // that were already added (e.g. the auto-opened active document) stay.
    setTabsRoot(rootPath)
    setWorkspaceTabs((current) => {
      const stored = readWorkspaceTabs(rootPath)
      if (current.length === 0) return stored
      const existingIds = new Set(current.map((tab) => tab.id))
      return [...stored.filter((tab) => !existingIds.has(tab.id)), ...current]
    })
    setActiveWorkspaceTabId((current) => current || readWorkspaceTabs(rootPath)[0]?.id || '')
  }

  useEffect(() => {
    lastCommittedTabsRef.current = workspaceTabs
    lastCommittedActiveIdRef.current = activeWorkspaceTabId
  })

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((item) => item.id === activeWorkspaceTabId) || workspaceTabs[0],
    [activeWorkspaceTabId, workspaceTabs],
  )

  const upsertWorkspaceTab = useCallback((
    tab: WorkspaceTab,
    options: {
      activate?: boolean
      insertAfterActive?: boolean
    } = {},
  ) => {
    setWorkspaceTabs((current) => {
      const kitablePath = getTabKitablePath(tab)
      const existingIndex = current.findIndex((item) => (
        item.id === tab.id || (kitablePath && getTabKitablePath(item) === kitablePath)
      ))
      const exists = existingIndex >= 0
      if (exists) {
                                                       
                                                           
        const existing = current[existingIndex]
        const merged = existing.type === 'document' && tab.type === 'document'
          ? { ...tab, uid: tab.uid || existing.uid }
          : tab
        return current.flatMap((item, index) => {
          const sameLogicalTab = item.id === tab.id
            || (kitablePath && getTabKitablePath(item) === kitablePath)
          if (!sameLogicalTab) return [item]
          return index === existingIndex ? [merged] : []
        })
      }
      if (options.insertAfterActive && activeWorkspaceTabId) {
        const activeIndex = current.findIndex((item) => item.id === activeWorkspaceTabId)
        if (activeIndex >= 0) {
          return [
            ...current.slice(0, activeIndex + 1),
            tab,
            ...current.slice(activeIndex + 1),
          ]
        }
      }
      return [...current, tab]
    })
    if (options.activate !== false) {
      setActiveWorkspaceTabId(tab.id)
    }
  }, [activeWorkspaceTabId])

  const updateWorkspaceTab = useCallback((
    tabId: string,
    updater: (tab: WorkspaceTab) => WorkspaceTab,
  ) => {
    setWorkspaceTabs((current) =>
      current.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    )
  }, [])

  const closeWorkspaceTab = useCallback((tabId: string) => {
    setWorkspaceTabs((current) => {
      const index = current.findIndex((item) => item.id === tabId)
      const closingTab = current[index]
      if (closingTab?.type === 'document') {
        onCloseDocumentTab?.(closingTab)
      }

      const next = current.filter((item) => item.id !== tabId)
      if (activeWorkspaceTabId === tabId) {
        const fallback = next[Math.max(0, index - 1)] || next[0]
        setActiveWorkspaceTabId(fallback?.id || '')
      }
      return next
    })
  }, [activeWorkspaceTabId, onCloseDocumentTab])

  const filterWorkspaceTabs = useCallback((predicate: (tab: WorkspaceTab) => boolean) => {
    setWorkspaceTabs((current) => {
      const activeIndex = current.findIndex((tab) => tab.id === activeWorkspaceTabId)
      const next = current.filter(predicate)
      if (activeWorkspaceTabId && !next.some((tab) => tab.id === activeWorkspaceTabId)) {
        const fallback = next[Math.max(0, activeIndex - 1)] || next[0]
        setActiveWorkspaceTabId(fallback?.id || '')
      }
      return next
    })
  }, [activeWorkspaceTabId])

  // After a move/rename, the on-disk path changes: remap any open tabs still
  // pointing at the old path to the new one. Otherwise clicking those tabs
  // would try to read the old path and fail with ENOENT.
  const remapWorkspaceTabPaths = useCallback((sourcePath: string, targetPath: string) => {
    if (!sourcePath || !targetPath || sourcePath === targetPath) {
      return
    }
    setWorkspaceTabs((current) => {
      let changed = false
      const next = current.map((tab) => {
        if (tab.type === 'document' || tab.type === 'board') {
          const nextPath = remapWorkspaceBranchPath(tab.path, sourcePath, targetPath)
          if (nextPath === tab.path) {
            return tab
          }
          changed = true
          const prefix = tab.type === 'board' ? 'board' : 'document'
          const filename = nextPath.split('/').pop() || nextPath
          return {
            ...tab,
            id: `${prefix}:${nextPath}`,
            path: nextPath,
            ...(tab.type === 'board' ? { title: getWorkspaceItemTitle(filename) } : {}),
          }
        }
        if (tab.type === 'browser' && tab.originDocumentPath) {
          const nextOrigin = remapWorkspaceBranchPath(tab.originDocumentPath, sourcePath, targetPath)
          if (nextOrigin === tab.originDocumentPath) {
            return tab
          }
          changed = true
          return {
            ...tab,
            originDocumentPath: nextOrigin,
            originTabId: tab.originTabId === `document:${tab.originDocumentPath}`
              ? `document:${nextOrigin}`
              : tab.originTabId,
          }
        }
        return tab
      })
      return changed ? next : current
    })
    setActiveWorkspaceTabId((activeId) => {
      const prefix = activeId.startsWith('board:')
        ? 'board:'
        : activeId.startsWith('document:')
          ? 'document:'
          : ''
      if (!prefix) {
        return activeId
      }
      const activePath = activeId.slice(prefix.length)
      const nextPath = remapWorkspaceBranchPath(activePath, sourcePath, targetPath)
      return nextPath === activePath ? activeId : `${prefix}${nextPath}`
    })
  }, [])

  // Remap the single file-level kitable tab when its file is renamed.
  const renameWorkspaceTabPath = useCallback((fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) {
      return
    }
    setWorkspaceTabs((current) => {
      let changed = false
      const remapped = current.map((tab) => {
        if (tab.type === 'table' && tab.kitablePath === fromPath) {
          changed = true
          return {
            ...tab,
            kitablePath: toPath,
            id: buildKitableWorkspaceTabId(toPath),
            title: getKitableWorkspaceTabTitle(toPath),
          }
        }
        if (tab.type === 'dashboard' && tab.kitablePath === fromPath) {
          changed = true
          return {
            ...tab,
            kitablePath: toPath,
            id: buildKitableWorkspaceTabId(toPath),
            title: getKitableWorkspaceTabTitle(toPath),
          }
        }
        if (tab.type === 'workflow' && tab.kitablePath === fromPath) {
          changed = true
          return {
            ...tab,
            kitablePath: toPath,
            id: buildKitableWorkspaceTabId(toPath),
            title: getKitableWorkspaceTabTitle(toPath),
          }
        }
        if (tab.type === 'document' && tab.path === fromPath) {
          changed = true
          return { ...tab, path: toPath, id: `document:${toPath}` }
        }
        return tab
      })
      if (!changed) return current
      const seen = new Set<string>()
      return remapped.filter((tab) => {
        if (seen.has(tab.id)) return false
        seen.add(tab.id)
        return true
      })
    })
    setActiveWorkspaceTabId((activeId) => {
      if (activeId === buildKitableWorkspaceTabId(fromPath)) return buildKitableWorkspaceTabId(toPath)
      if (activeId === `workflow:${fromPath}`) return buildKitableWorkspaceTabId(toPath)
      if (activeId.startsWith(`workflow:${fromPath}:`)) return buildKitableWorkspaceTabId(toPath)
      if (activeId === `document:${fromPath}`) return `document:${toPath}`
      if (activeId.startsWith(`table:${fromPath}#`)) {
        return buildKitableWorkspaceTabId(toPath)
      }
      return activeId
    })
  }, [])

  const activateWorkspaceTab = useCallback(async (tab: WorkspaceTab) => {
    setActiveWorkspaceTabId(tab.id)

    if (tab.type === 'document' && activeDocumentPath !== tab.path) {
      await onOpenDocument(tab.path)
      return
    }

    if (tab.type === 'browser') {
      return
    }

    if (tab.type === 'browser-sites') {
      return
    }

    if (tab.type === 'gallery') {
      onActivateGallery(tab.kind)
    }
  }, [activeDocumentPath, onActivateGallery, onOpenDocument])

  useEffect(() => {
    if (!rootPath || tabsRoot !== rootPath) {
      // Either no workspace yet, or we're mid-switch and workspaceTabs still
      // holds the previous workspace's data. Skip writing to avoid clobbering
      // the new workspace's storage slot with stale tabs.
      return
    }
    writeWorkspaceTabs(rootPath, workspaceTabs)
  }, [workspaceTabs, rootPath, tabsRoot])

  return {
    activeWorkspaceTab,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    filterWorkspaceTabs,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    setActiveWorkspaceTabId,
    updateWorkspaceTab,
    upsertWorkspaceTab,
    workspaceTabs,
  }
}
