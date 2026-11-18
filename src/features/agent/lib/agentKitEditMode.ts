import { useSyncExternalStore } from 'react'
import type { AgentKitEditMode } from '@/api/agent'

/**
 * How the agent edits kit documents (KHP A12): `live` (the default) edits the open
 * document, which the person sees change and can undo; `draft` edits a draft the person reviews
 * and merges or discards. Chosen in the composer, sent with each run, kept across sessions.
 */
const agentKitEditModeStorageKey = 'kition.agent.kitEditMode'
const listeners = new Set<() => void>()

export function getAgentKitEditMode(): AgentKitEditMode {
  try {
    return window.localStorage.getItem(agentKitEditModeStorageKey) === 'draft' ? 'draft' : 'live'
  } catch {
    return 'live'
  }
}

export function setAgentKitEditMode(mode: AgentKitEditMode) {
  try {
    window.localStorage.setItem(agentKitEditModeStorageKey, mode)
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAgentKitEditMode(): AgentKitEditMode {
  return useSyncExternalStore(subscribe, getAgentKitEditMode, () => 'live')
}
