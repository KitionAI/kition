import { useEffect, useRef, useState } from 'react'
import { fetchKitOutline, onKitFileChanged, type KitsOutlineItem } from '@/api/kits'
import { isWebPreviewMode } from '@/lib/runtimeMode'

/**
 * The outline of each of `paths` (expanded files in the tree whose kit has one), read through
 * the file's kit when a file is first expanded and again when it is saved or changes. Files never
 * expanded are not read.
 */
export function useKitOutlines(paths: readonly string[]): Record<string, KitsOutlineItem[]> {
  const [outlines, setOutlines] = useState<Record<string, KitsOutlineItem[]>>({})
  // Bumped when a kit's file changes, so that expanded files are read again.
  const [changed, setChanged] = useState<{ path?: string; count: number }>({ count: 0 })
  const read = useRef(new Map<string, number>())
  const live = useRef(true)
  const key = paths.join('\n')

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (isWebPreviewMode()) return
    for (const path of key ? key.split('\n') : []) {
      // Each file is read once per change that names it (or names no file).
      const due = changed.path === undefined || changed.path === path ? changed.count : (read.current.get(path) ?? -1)
      if (read.current.get(path) === due) continue
      read.current.set(path, due)
      void fetchKitOutline(path)
        .then((items) => {
          if (!live.current) return
          setOutlines((current) => {
            const next = { ...current }
            if (items) next[path] = items
            else delete next[path]
            return next
          })
        })
        .catch((error: unknown) => console.warn('[workspace] could not read a file\'s outline for the tree', path, error))
    }
  }, [changed, key])

  useEffect(() => onKitFileChanged((path) => setChanged((current) => ({ path, count: current.count + 1 }))), [])

  return outlines
}
