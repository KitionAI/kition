import { useCallback, useEffect, useRef, useState } from 'react'
import { writeKitFile } from '@/api/kits'
import { resolveWorkspaceFileURL } from '@/services/workspaceFiles'
import { inspectPhotoDocument, loadPhotoSdk, photoSdkCommands, type PhotoSdkDocument, type PhotoSdkState } from './photoSdk'

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One workspace image opened in the in-page Photo engine: loads the engine
 * and the file's bytes, runs commands, and saves the file back in place.
 * `revision` moves with every change so the canvas knows to repaint.
 */
export function usePhotoDocument(path: string) {
  const docRef = useRef<PhotoSdkDocument | null>(null)
  const [doc, setDoc] = useState<PhotoSdkDocument | null>(null)
  const [state, setState] = useState<PhotoSdkState | null>(null)
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [openMs, setOpenMs] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const refresh = useCallback(() => {
    const doc = docRef.current
    if (!doc) return
    setState(inspectPhotoDocument(doc))
    setDirty(doc.dirty)
    setRevision(Number(doc.revision))
  }, [])

  useEffect(() => {
    let cancelled = false
    setFailure(null)
    setState(null)
    void (async () => {
      try {
        const [sdk, response] = await Promise.all([loadPhotoSdk(), fetch(resolveWorkspaceFileURL(path), { cache: 'no-store' })])
        if (!response.ok) throw new Error(`could not read ${path} (${response.status})`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        // Let the loading state paint before the engine decodes on this thread.
        await nextFrame()
        if (cancelled) return
        const started = performance.now()
        const name = path.split('/').filter(Boolean).pop() || path
        const doc = sdk.PhotoDocument.open(name, bytes)
        setOpenMs(Math.round(performance.now() - started))
        if (cancelled) {
          doc.free()
          return
        }
        docRef.current = doc
        setDoc(doc)
        refresh()
      } catch (error) {
        if (!cancelled) setFailure(errorText(error))
      }
    })()
    return () => {
      cancelled = true
      docRef.current?.free()
      docRef.current = null
      setDoc(null)
    }
  }, [attempt, path, refresh])

  /** Runs an engine command; throws when the engine refuses it. */
  const run = useCallback((command: string, params: Record<string, unknown> = {}) => {
    const doc = docRef.current
    if (!doc) return null
    const result = doc.execute(command, JSON.stringify(params))
    refresh()
    return result
  }, [refresh])

  const commands = useCallback(() => (docRef.current ? photoSdkCommands(docRef.current) : []), [])

  /** Writes the document back to its workspace file. */
  const save = useCallback(async () => {
    const doc = docRef.current
    if (!doc) return
    setSaving(true)
    try {
      await nextFrame()
      const revision = doc.revision
      await writeKitFile(path, doc.save())
      // Only a file that reached the disk counts as saved, and only if nothing changed meanwhile.
      if (doc.revision === revision) doc.markSaved()
      refresh()
    } finally {
      setSaving(false)
    }
  }, [path, refresh])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])

  return { doc, state, revision, dirty, failure, openMs, saving, run, commands, save, reopen }
}
