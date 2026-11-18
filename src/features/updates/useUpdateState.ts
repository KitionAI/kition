import { useSyncExternalStore } from 'react'
import { getUpdateState, subscribeToUpdates, type UpdateState } from '@/services/desktopUpdates'

let cached: UpdateState = { phase: 'idle' }
const listeners = new Set<() => void>()
let bootstrapped = false

function notifyAll() {
  for (const fn of listeners) fn()
}

function bootstrap() {
  if (bootstrapped) return
  bootstrapped = true
  void getUpdateState().then((next) => {
    cached = next
    notifyAll()
  })
  subscribeToUpdates((next) => {
    cached = next
    notifyAll()
  })
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (notify) => {
      bootstrap()
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => cached,
    () => cached,
  )
}
