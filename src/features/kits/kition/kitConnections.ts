import type { KitConnection } from '../host/mountKit'

/**
 * A kit editor open in this window: the workspace file it shows, its kit, its connection, and
 * whether it was opened read-only.
 */
export type MountedKitDocument = { path: string; kitId: string; connection: KitConnection; readOnly?: boolean }

type Listener = (document: MountedKitDocument) => (() => void) | void

const mounted = new Map<string, MountedKitDocument>()
/** The paths of kit editors in the order they were last shown, the latest last. */
const shown: string[] = []
const listeners = new Set<Listener>()
/** Each listener's cleanup for each mounted document, run when that editor closes. */
const cleanups = new Map<MountedKitDocument, Map<Listener, () => void>>()

function attach(document: MountedKitDocument, listener: Listener) {
  const cleanup = listener(document)
  if (!cleanup) return
  let byListener = cleanups.get(document)
  if (!byListener) cleanups.set(document, (byListener = new Map()))
  byListener.set(listener, cleanup)
}

/**
 * Offers a mounted kit editor to whatever follows the open documents (collaboration); answers its
 * withdrawal, which runs every follower's cleanup for it.
 */
export function registerKitConnection(document: MountedKitDocument) {
  mounted.set(document.path, document)
  for (const listener of listeners) attach(document, listener)
  return () => {
    if (mounted.get(document.path) === document) mounted.delete(document.path)
    for (const cleanup of cleanups.get(document)?.values() ?? []) cleanup()
    cleanups.delete(document)
  }
}

/**
 * Hears every kit editor open now and every one opened later; the listener may answer a cleanup
 * for when that editor closes (or when this subscription ends). Answers an unsubscribe.
 */
export function followKitConnections(listener: Listener) {
  listeners.add(listener)
  for (const document of mounted.values()) attach(document, listener)
  return () => {
    listeners.delete(listener)
    for (const byListener of cleanups.values()) {
      byListener.get(listener)?.()
      byListener.delete(listener)
    }
  }
}

/** The kit editor showing the workspace file `path`, if one is open in this window. */
export function mountedKitDocument(path: string) {
  return mounted.get(path) ?? null
}

/** Records that the kit editor of `path` is the one shown now (its tab became active). */
export function markKitDocumentShown(path: string) {
  const index = shown.indexOf(path)
  if (index >= 0) shown.splice(index, 1)
  shown.push(path)
}

/** The kit editor shown last that is still open, if any: what commands for "this document" act on. */
export function activeKitDocument(): MountedKitDocument | null {
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const document = mounted.get(shown[index])
    if (document) return document
  }
  return null
}
