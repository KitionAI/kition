   
                            
  
                                        
                                                             
   

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'kition.document.bookmarks'
const BROADCAST_EVENT = 'kition:document:bookmarks-changed'

export type BookmarkEntry = {
  path: string
                
  addedAt: string
                    
  alias?: string
}

function read(): BookmarkEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is BookmarkEntry =>
        x && typeof x === 'object' && typeof x.path === 'string' && typeof x.addedAt === 'string',
    )
  } catch {
    return []
  }
}

function write(entries: BookmarkEntry[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    window.dispatchEvent(new CustomEvent(BROADCAST_EVENT))
  } catch {
    /* quota / disabled */
  }
}

export function addBookmark(path: string, alias?: string): void {
  if (!path) return
  const list = read().filter((e) => e.path !== path)
  list.unshift({ path, addedAt: new Date().toISOString(), alias })
  write(list)
}

export function removeBookmark(path: string): void {
  write(read().filter((e) => e.path !== path))
}

export function toggleBookmark(path: string): boolean {
  const list = read()
  const has = list.some((e) => e.path === path)
  if (has) {
    removeBookmark(path)
    return false
  }
  addBookmark(path)
  return true
}

export function isBookmarked(path: string): boolean {
  return read().some((e) => e.path === path)
}

export function useBookmarks(): BookmarkEntry[] {
  const [items, setItems] = useState<BookmarkEntry[]>(() => read())
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

export function useIsBookmarked(path: string | undefined): boolean {
  const list = useBookmarks()
  if (!path) return false
  return list.some((e) => e.path === path)
}

export function useBookmarksActions(): {
  add: (path: string, alias?: string) => void
  remove: (path: string) => void
  toggle: (path: string) => boolean
} {
  return {
    add: useCallback((path: string, alias?: string) => addBookmark(path, alias), []),
    remove: useCallback((path: string) => removeBookmark(path), []),
    toggle: useCallback((path: string) => toggleBookmark(path), []),
  }
}
