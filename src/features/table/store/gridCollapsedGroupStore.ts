import { useSyncExternalStore } from 'react'

export const COLLAPSED_GROUPS_STORAGE_KEY = 'kition.table.grid.collapsed-groups.v1'

type Persisted = Record<string, string[]>

const buckets = new Map<string, Set<string>>()
const subscribers = new Set<() => void>()
let hydrated = false

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Persisted
    }
    return {}
  } catch {
    return {}
  }
}

function hydrate() {
  if (hydrated) return
  hydrated = true
  const persisted = readPersisted()
  for (const [viewId, ids] of Object.entries(persisted)) {
    if (Array.isArray(ids)) buckets.set(viewId, new Set(ids))
  }
}

function writePersisted() {
  const out: Persisted = {}
  for (const [viewId, set] of buckets.entries()) {
    if (set.size > 0) out[viewId] = Array.from(set)
  }
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(out))
  } catch {
    // Quota / private-mode: in-memory state still works for this session.
  }
}

const EMPTY: ReadonlySet<string> = new Set()

export function getCollapsedGroupIds(viewId: string): ReadonlySet<string> {
  hydrate()
  return buckets.get(viewId) ?? EMPTY
}

export function setCollapsedGroupIds(viewId: string, next: ReadonlySet<string>): void {
  hydrate()
  buckets.set(viewId, new Set(next))
  writePersisted()
  for (const listener of subscribers) listener()
}

export function subscribeCollapsedGroups(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function useCollapsedGroupIds(viewId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeCollapsedGroups,
    () => getCollapsedGroupIds(viewId),
    () => EMPTY,
  )
}

// Test-only — keep at module bottom so tree-shaking can eliminate it.
export function __resetCollapsedGroupStoreForTests(): void {
  buckets.clear()
  subscribers.clear()
  hydrated = false
}
