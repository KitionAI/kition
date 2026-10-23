import { useEffect, useSyncExternalStore } from 'react'
import type { KitConnection } from '../host/mountKit'
import type { KitView } from '../host/protocol'

/**
 * Where in a document Kition asked a kit editor to show (Kit UI protocol `document.view` and
 * `document/reveal`, KitLinks OP3): the workspace tree opens a table file at one of its tables or
 * dashboards this way. One request per path, taken by the editor that shows it.
 */
type Requested = { view: KitView; seq: number }

const requested = new Map<string, Requested>()
const listeners = new Set<() => void>()
let next = 0

/** Shows `view` in the editor of `path`: an editor opened next opens there, an open one reveals it. */
export function revealInKit(path: string, view: KitView) {
  next += 1
  requested.set(path, { view, seq: next })
  for (const listener of listeners) listener()
}

/** Takes the view requested for `path`, if any. */
function takeKitView(path: string): KitView | undefined {
  const found = requested.get(path)
  requested.delete(path)
  return found?.view
}

/** `document.view` for an editor opening `path`: where Kition asked to show (the tree does), if anywhere. */
export function openingView(path: string): { view?: KitView } {
  const view = takeKitView(path)
  return view ? { view } : {}
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The view requested for `path` and not taken yet; re-renders on each new request. */
function useRequestedKitView(path: string): Requested | null {
  return useSyncExternalStore(subscribe, () => requested.get(path) ?? null, () => null)
}

/** Shows each view requested for `path` in its open editor (`document/reveal`). */
export function useKitReveal(path: string, connection: KitConnection | null) {
  const request = useRequestedKitView(path)
  useEffect(() => {
    if (!connection || !request) return
    const view = takeKitView(path)
    if (view) connection.reveal(view)
  }, [connection, path, request])
}
