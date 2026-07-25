   
                       
  
                                                
                                  
  
                                                             
                                                              
                                  
   

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'kition.document.pinnedTabs.v2'
const LEGACY_STORAGE_KEY = 'kition.document.pinnedTabs'
const EVENT = 'kition:document:pinned-tabs-changed'
const MAX_PINNED = 12

let currentRoot = ''

type PinnedTabsMap = Record<string, string[]>

function readMap(): PinnedTabsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: PinnedTabsMap = {}
    for (const [rootPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rootPath !== 'string' || !rootPath) continue
      if (!Array.isArray(value)) continue
      result[rootPath] = value
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, MAX_PINNED)
    }
    return result
  } catch {
    return {}
  }
}

function writeMap(map: PinnedTabsMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

function readLegacyArray(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, MAX_PINNED)
  } catch {
    return []
  }
}

function readListFor(root: string): string[] {
  if (!root) return []
  const map = readMap()
  if (map[root]) return map[root]

  const legacy = readLegacyArray()
  if (legacy.length) {
    writeMap({ ...map, [root]: legacy })
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    return legacy
  }
  if (localStorage.getItem(LEGACY_STORAGE_KEY) !== null) {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
  return []
}

function writeListFor(root: string, items: string[]) {
  if (!root) return
  const map = readMap()
  if (items.length === 0) {
    if (!(root in map)) return
    const { [root]: _omit, ...rest } = map
    writeMap(rest)
    return
  }
  writeMap({ ...map, [root]: items.slice(0, MAX_PINNED) })
}

export function setPinnedTabsWorkspace(rootPath: string) {
  const next = String(rootPath || '').trim()
  if (next === currentRoot) return
  currentRoot = next
  // Notify subscribers so usePinnedTabs re-reads with the new workspace's list.
  try {
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

export function listPinnedTabs(): string[] {
  return readListFor(currentRoot)
}

export function pinTab(path: string) {
  if (!path || !currentRoot) return
  const list = readListFor(currentRoot).filter((p) => p !== path)
  list.unshift(path)
  writeListFor(currentRoot, list)
}

export function unpinTab(path: string) {
  if (!currentRoot) return
  const list = readListFor(currentRoot).filter((p) => p !== path)
  writeListFor(currentRoot, list)
}

export function togglePinTab(path: string) {
  if (!currentRoot) return
  const list = readListFor(currentRoot)
  if (list.includes(path)) unpinTab(path)
  else pinTab(path)
}

export function isTabPinned(path: string): boolean {
  return readListFor(currentRoot).includes(path)
}

export function reorderPinnedTabs(items: string[]) {
  writeListFor(currentRoot, items)
}

export function usePinnedTabs(): string[] {
  const [items, setItems] = useState<string[]>(() => readListFor(currentRoot))
  useEffect(() => {
    const handler = () => setItems(readListFor(currentRoot))
    window.addEventListener(EVENT, handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])
  return items
}

export function usePinnedTabsActions() {
  const pin = useCallback((path: string) => pinTab(path), [])
  const unpin = useCallback((path: string) => unpinTab(path), [])
  const toggle = useCallback((path: string) => togglePinTab(path), [])
  return { pin, unpin, toggle }
}
