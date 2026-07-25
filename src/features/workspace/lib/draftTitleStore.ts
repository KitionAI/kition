import { useSyncExternalStore } from 'react'

type DraftTitleSnapshot = { path: string; draft: string } | null

let snapshot: DraftTitleSnapshot = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeDraftTitle(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDraftTitleSnapshot(): DraftTitleSnapshot {
  return snapshot
}

export function setDraftTitle(path: string, draft: string): void {
  if (snapshot && snapshot.path === path && snapshot.draft === draft) return
  snapshot = { path, draft }
  notify()
}

export function clearDraftTitle(): void {
  if (snapshot === null) return
  snapshot = null
  notify()
}

                                                       
                                 
if (typeof window !== 'undefined') {
  window.addEventListener('kition:workspace-reload', () => {
    clearDraftTitle()
  })
}

export function useDraftTitleForPath(path: string): string | null {
  const current = useSyncExternalStore(subscribeDraftTitle, getDraftTitleSnapshot)
  return current && current.path === path ? current.draft : null
}
