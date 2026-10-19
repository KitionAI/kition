import { useSyncExternalStore } from 'react'
import type { DraftInfo } from '../host/mountKit'

/**
 * The agent's drafts of the kit documents open in this window (Kit Standard 2.0 A12, Kit UI
 * protocol section 7d), by workspace path, as each kit reports them (`draft/changed`). A draft
 * lives in its kit editor; this is what the tab strip and the editor's banner show.
 */
const drafts = new Map<string, DraftInfo>()
const listeners = new Set<() => void>()
const NONE: DraftInfo = { state: 'none', revision: null }

function emit() {
  for (const listener of listeners) listener()
}

/** Records the draft of `path` as its kit reported it; `none` forgets it. */
export function setKitDraft(path: string, info: DraftInfo) {
  const known = drafts.get(path) ?? NONE
  if (known.state === info.state && known.revision === info.revision) return
  if (info.state === 'none') drafts.delete(path)
  else drafts.set(path, info)
  emit()
}

/** The draft of `path` now. */
export function kitDraft(path: string): DraftInfo {
  return drafts.get(path) ?? NONE
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The draft of `path`, following its changes. */
export function useKitDraft(path: string | null): DraftInfo {
  return useSyncExternalStore(
    subscribe,
    () => (path ? kitDraft(path) : NONE),
    () => NONE,
  )
}
