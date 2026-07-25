import { useSyncExternalStore } from 'react'

export type CellKey = `${number}:${number}:${number}`

export type CellStatus =
  | { status: 'idle' }
  | { status: 'pending'; action: string; startedAt: number; controller: AbortController }
  | { status: 'error'; message: string; failedAt: number }

const IDLE: CellStatus = { status: 'idle' }

const states = new Map<CellKey, CellStatus>()
const listeners = new Map<CellKey, Set<() => void>>()
const globalListeners = new Set<() => void>()
let version = 0

function notify(key: CellKey) {
  version += 1
  const set = listeners.get(key)
  if (set) for (const listener of set) listener()
  for (const listener of globalListeners) listener()
}

export function buildCellKey(tableId: number, recordId: number, fieldId: number): CellKey {
  return `${tableId}:${recordId}:${fieldId}` as CellKey
}

export const aiCellStore = {
  get(key: CellKey): CellStatus {
    return states.get(key) ?? IDLE
  },
  start(key: CellKey, action: string, controller: AbortController) {
    states.set(key, { status: 'pending', action, startedAt: Date.now(), controller })
    notify(key)
  },
  complete(key: CellKey) {
    states.delete(key)
    notify(key)
  },
  fail(key: CellKey, message: string) {
    states.set(key, { status: 'error', message, failedAt: Date.now() })
    notify(key)
  },
  cancel(key: CellKey) {
    const current = states.get(key)
    if (current?.status === 'pending') current.controller.abort()
    states.delete(key)
    notify(key)
  },
  subscribe(key: CellKey, listener: () => void) {
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) listeners.delete(key)
    }
  },
  subscribeAll(listener: () => void) {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  },
  getVersion() {
    return version
  },
  pendingKeys(): CellKey[] {
    return Array.from(states.entries())
      .filter(([, value]) => value.status === 'pending')
      .map(([key]) => key)
  },
  _resetForTests() {
    states.clear()
    listeners.clear()
    globalListeners.clear()
    version = 0
  },
}

                                                                
                                                           
                                              
if (typeof window !== 'undefined') {
  window.addEventListener('kition:workspace-reload', () => {
    const snapshotKeys = Array.from(states.keys())
    for (const key of snapshotKeys) {
      const current = states.get(key)
      if (current?.status === 'pending') current.controller.abort()
      states.delete(key)
      notify(key)
    }
  })
}

export function useAICellStatus(key: CellKey): CellStatus {
  return useSyncExternalStore(
    (listener) => aiCellStore.subscribe(key, listener),
    () => aiCellStore.get(key),
    () => IDLE,
  )
}
