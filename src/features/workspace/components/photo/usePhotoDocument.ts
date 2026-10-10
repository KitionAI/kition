import { useCallback, useEffect, useRef, useState } from 'react'
import { writeKitFile } from '@/api/kits'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import type { PhotoRect } from './photoViewport'
import { PhotoEngine } from './photoEngine'
import type { PhotoSdkState } from './photoSdk'

/** One edit: the canvas repaints `damage`, or everything when it is null. */
export type PhotoChange = { revision: number; damage: PhotoRect | null }

/** How often an active tab checks whether something else (the agent) replaced the file. */
const FILE_CHECK_MS = 2000

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Identifies one version of the file: its validator, or its time and size. */
function fileStamp(response: Response) {
  const headers = response.headers
  return headers.get('etag') || [headers.get('last-modified'), headers.get('content-length')].filter(Boolean).join('|') || null
}

async function readStamp(url: string) {
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
  return response.ok ? fileStamp(response) : null
}

/**
 * One workspace image opened in the in-page Photo engine: loads the engine
 * and the file's bytes, runs commands, and saves the file back in place.
 * `change` moves with every edit so the canvas knows what to repaint. While
 * the tab is active it follows the file: when the agent saves a new version
 * the image reloads, unless there are unsaved edits, which raise `conflict`.
 */
export function usePhotoDocument(path: string, active: boolean) {
  const docRef = useRef<PhotoEngine | null>(null)
  const stampRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const [doc, setDoc] = useState<PhotoEngine | null>(null)
  const [state, setState] = useState<PhotoSdkState | null>(null)
  const [change, setChange] = useState<PhotoChange>({ revision: 0, damage: null })
  const [dirty, setDirty] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [openMs, setOpenMs] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const url = resolveWorkspaceFileURL(path)

  const refresh = useCallback((damage: PhotoRect | null = null) => {
    const current = docRef.current
    if (!current) return
    setState(current.info.state)
    setDirty(current.info.dirty)
    setChange((previous) => ({ revision: previous.revision + 1, damage }))
  }, [])

  /** Reads the file into a new document and swaps it in; the old one stays on screen until then. */
  const load = useCallback(async (isCurrent: () => boolean) => {
    busyRef.current = true
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`could not read ${path} (${response.status})`)
      const stamp = fileStamp(response)
      const bytes = await response.arrayBuffer()
      if (!isCurrent()) return
      const started = performance.now()
      const name = path.split('/').filter(Boolean).pop() || path
      const next = await PhotoEngine.open(name, bytes)
      setOpenMs(Math.round(performance.now() - started))
      if (!isCurrent()) {
        next.dispose()
        return
      }
      const previous = docRef.current
      docRef.current = next
      stampRef.current = stamp
      setDoc(next)
      setConflict(false)
      setFailure(null)
      refresh()
      previous?.dispose()
    } finally {
      busyRef.current = false
    }
  }, [path, refresh, url])

  useEffect(() => {
    let current = true
    load(() => current).catch((error) => {
      if (current) setFailure(errorText(error))
    })
    return () => {
      current = false
    }
  }, [attempt, load])

  useEffect(() => () => {
    docRef.current?.dispose()
    docRef.current = null
  }, [path])

  useEffect(() => {
    if (!active) return undefined
    let current = true
    const timer = window.setInterval(async () => {
      const open = docRef.current
      if (!open || busyRef.current || !stampRef.current) return
      try {
        const stamp = await readStamp(url)
        if (!current || !stamp || stamp === stampRef.current || busyRef.current) return
        if (open.info.dirty) setConflict(true)
        else await load(() => current)
      } catch {
        // The next check tries again.
      }
    }, FILE_CHECK_MS)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [active, load, url])

  /** Runs an engine command; throws when the engine refuses it. `damage` limits the repaint. */
  const run = useCallback(async (command: string, params: Record<string, unknown> = {}, damage: PhotoRect | null = null) => {
    const open = docRef.current
    if (!open) return null
    const result = await open.execute(command, params)
    if (docRef.current === open) refresh(damage)
    return result
  }, [refresh])

  const commands = useCallback(async () => (docRef.current ? docRef.current.commands() : []), [])

  /** Writes the document back to its workspace file. */
  const save = useCallback(async () => {
    const open = docRef.current
    if (!open) return
    setSaving(true)
    busyRef.current = true
    try {
      const at = open.info.revision
      await writeKitFile(path, await open.save())
      stampRef.current = await readStamp(url).catch(() => null)
      // Only a file that reached the disk counts as saved, and only if nothing changed meanwhile.
      if (open.info.revision === at) await open.markSaved()
      setConflict(false)
      refresh()
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }, [path, refresh, url])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])

  /** Keeps the unsaved edits; the next save replaces the newer file. */
  const keepMine = useCallback(() => {
    setConflict(false)
    void readStamp(url).then((stamp) => {
      if (stamp) stampRef.current = stamp
    })
  }, [url])

  return { doc, state, change, dirty, failure, openMs, saving, conflict, run, commands, save, reopen, keepMine }
}
