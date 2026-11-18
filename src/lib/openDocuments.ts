/**
 * A registry of the documents of one kind open in this window, by workspace path, that other
 * parts of the app can follow (co-editing follows open boards, documents, and tables). A path
 * registered more than once (two tabs on one file) is announced once, on its first
 * registration, and withdrawn when its last registration goes.
 */

type Listener<T> = (document: T) => (() => void) | void

export type OpenDocumentRegistry<T extends { path: string }> = {
  /** Announces `document` as open; answers its withdrawal. */
  register: (document: T) => () => void
  /**
   * Hears every document open now and every one opened later; the listener may answer a cleanup
   * for when that document closes (or when this subscription ends). Answers an unsubscribe.
   */
  follow: (listener: Listener<T>) => () => void
  /** The document open at `path`, if any. */
  find: (path: string) => T | null
}

export function createOpenDocumentRegistry<T extends { path: string }>(): OpenDocumentRegistry<T> {
  /** Each open path's registrations, oldest first; the first one is the announced document. */
  const open = new Map<string, T[]>()
  const listeners = new Set<Listener<T>>()
  /** Each listener's cleanup for each announced document. */
  const cleanups = new Map<T, Map<Listener<T>, () => void>>()

  const attach = (document: T, listener: Listener<T>) => {
    const cleanup = listener(document)
    if (!cleanup) return
    let byListener = cleanups.get(document)
    if (!byListener) cleanups.set(document, (byListener = new Map()))
    byListener.set(listener, cleanup)
  }

  const detach = (document: T) => {
    for (const cleanup of cleanups.get(document)?.values() ?? []) cleanup()
    cleanups.delete(document)
  }

  return {
    register: (document) => {
      const entries = open.get(document.path) ?? []
      entries.push(document)
      open.set(document.path, entries)
      if (entries.length === 1) for (const listener of listeners) attach(document, listener)
      let withdrawn = false
      return () => {
        if (withdrawn) return
        withdrawn = true
        const current = open.get(document.path) ?? []
        const index = current.indexOf(document)
        if (index < 0) return
        current.splice(index, 1)
        if (index === 0) {
          detach(document)
          // The next registration of the path, if any, is announced in its place.
          const next = current[0]
          if (next) for (const listener of listeners) attach(next, listener)
        }
        if (!current.length) open.delete(document.path)
      }
    },
    follow: (listener) => {
      listeners.add(listener)
      for (const [document] of open.values()) attach(document, listener)
      return () => {
        listeners.delete(listener)
        for (const byListener of cleanups.values()) {
          byListener.get(listener)?.()
          byListener.delete(listener)
        }
      }
    },
    find: (path) => open.get(path)?.[0] ?? null,
  }
}
