import { useSyncExternalStore } from 'react'

/**
 * Native kit editors draw in their own window over part of the workspace, so
 * any web content in that area is hidden behind them. Components that float
 * over the content area (the Agent launcher) step aside while one is shown.
 */
const showing = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function setNativeSurfaceShowing(id: string, value: boolean) {
  const had = showing.has(id)
  if (value === had) return
  if (value) showing.add(id)
  else showing.delete(id)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useNativeSurfaceShowing() {
  return useSyncExternalStore(subscribe, () => showing.size > 0, () => false)
}
