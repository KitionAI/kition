import { useCallback, useEffect, useRef, useState } from 'react'
import { KitEngine, type KitEngineInfo } from './kitEngine'
import type { KitSdkManifest } from './kitSdk'
import type { KitHost } from './kitHost'
import type { RasterRect } from './rasterViewport'

/** One edit: the canvas repaints `damage`, or everything when it is null. */
export type KitChange = { revision: number; damage: RasterRect | null }

/** How often an active tab checks whether something else (the agent) replaced the file. */
const FILE_CHECK_MS = 2000

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One workspace file opened in a kit's in-page engine: starts the engine
 * worker with the file's bytes, runs commands, and saves the file back in
 * place. `change` moves with every edit so the canvas knows what to repaint.
 * While the tab is active it follows the file: when the agent saves a new
 * version the document reloads, unless there are unsaved edits, which raise
 * `conflict`. `describe` turns the engine's `inspect()` JSON into what the
 * kit's editor shows; `host` reads and writes the file.
 */
export function useKitDocument<T>(host: KitHost, manifest: KitSdkManifest, path: string, active: boolean, describe: (info: KitEngineInfo) => T) {
  const docRef = useRef<KitEngine | null>(null)
  const describeRef = useRef(describe)
  describeRef.current = describe
  const stampRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const [doc, setDoc] = useState<KitEngine | null>(null)
  const [info, setInfo] = useState<KitEngineInfo | null>(null)
  const [state, setState] = useState<T | null>(null)
  const [change, setChange] = useState<KitChange>({ revision: 0, damage: null })
  const [dirty, setDirty] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [openMs, setOpenMs] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const refresh = useCallback((damage: RasterRect | null = null) => {
    const current = docRef.current
    if (!current) return
    setInfo(current.info)
    setState(describeRef.current(current.info))
    setDirty(current.info.dirty)
    setChange((previous) => ({ revision: previous.revision + 1, damage }))
  }, [])

  /** Reads the file into a new document and swaps it in; the old one stays on screen until then. */
  const load = useCallback(async (isCurrent: () => boolean) => {
    busyRef.current = true
    try {
      const { bytes, stamp } = await host.read(path)
      if (!isCurrent()) return
      const started = performance.now()
      const name = path.split('/').filter(Boolean).pop() || path
      const next = await KitEngine.open(manifest, name, bytes, host.lend?.(path) ?? null)
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
  }, [host, manifest, path, refresh])

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
        const stamp = await host.stamp(path)
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
  }, [active, host, load, path])

  /** Runs an engine command; throws when the engine refuses it. `damage` limits the repaint. */
  const run = useCallback(async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null) => {
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
      await host.write(path, await open.save())
      stampRef.current = await host.stamp(path).catch(() => null)
      // Only a file that reached the disk counts as saved, and only if nothing changed meanwhile.
      if (open.info.revision === at) await open.markSaved()
      setConflict(false)
      refresh()
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }, [host, path, refresh])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])

  /** Keeps the unsaved edits; the next save replaces the newer file. */
  const keepMine = useCallback(() => {
    setConflict(false)
    void host.stamp(path).then((stamp) => {
      if (stamp) stampRef.current = stamp
    })
  }, [host, path])

  return { doc, info, state, change, dirty, failure, openMs, saving, conflict, run, commands, save, reopen, keepMine }
}
