   
                   
  
                                      
                    
                  
  
                                                     
         
   

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'kition.document.recentFiles'
const MAX = 50
const BROADCAST_EVENT = 'kition:document:recent-files-changed'

export type RecentEntry = {
  path: string
                
  visitedAt: string
}

function read(): RecentEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is RecentEntry =>
        x && typeof x === 'object' && typeof x.path === 'string' && typeof x.visitedAt === 'string',
    )
  } catch {
    return []
  }
}

function write(entries: RecentEntry[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    window.dispatchEvent(new CustomEvent(BROADCAST_EVENT))
  } catch {
    /* quota / disabled */
  }
}

export function pushRecentFile(path: string): void {
  if (!path) return
  const list = read().filter((e) => e.path !== path)
  list.unshift({ path, visitedAt: new Date().toISOString() })
  write(list.slice(0, MAX))
}

export function listRecentFiles(): RecentEntry[] {
  return read()
}

export function clearRecentFiles(): void {
  write([])
}

export function useRecentFiles(): RecentEntry[] {
  const [items, setItems] = useState<RecentEntry[]>(() => read())
  useEffect(() => {
    function onChange() {
      setItems(read())
    }
    window.addEventListener(BROADCAST_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(BROADCAST_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return items
}

export function useRecentFilesActions(): {
  push: (path: string) => void
  clear: () => void
} {
  return {
    push: useCallback((path: string) => pushRecentFile(path), []),
    clear: useCallback(() => clearRecentFiles(), []),
  }
}
