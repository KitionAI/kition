import { useEffect, useRef, useState } from 'react'
import { listTableFiles, onTableFilesChanged, type KitTablesFile } from '@/api/kitTables'
import { isWebPreviewMode } from '@/lib/runtimeMode'

/**
 * What each of `paths` (expanded table files in the tree) holds, read through the Table kit when
 * a file is first expanded and again when it is saved or a host feature writes it. Files never
 * expanded are not read.
 */
export function useTableFileChildren(paths: readonly string[]): Record<string, KitTablesFile> {
  const [files, setFiles] = useState<Record<string, KitTablesFile>>({})
  // Bumped when a table file changes, so that expanded files are read again.
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
      void listTableFiles({ path })
        .then(({ files: described }) => {
          if (!live.current) return
          const file = described.find((candidate) => candidate.path === path)
          setFiles((current) => {
            const next = { ...current }
            if (file) next[path] = file
            else delete next[path]
            return next
          })
        })
        .catch((error: unknown) => console.warn('[workspace] could not read a table file for the tree', path, error))
    }
  }, [changed, key])

  useEffect(() => onTableFilesChanged((path) => setChanged((current) => ({ path, count: current.count + 1 }))), [])

  return files
}
