import { showDesktopNotification } from '@/services/desktop'
import type { DesktopNotificationPolicy } from '@/types/desktopSettings'
import {
  dispatchLifecycleHook,
  getNotificationPolicy,
  policyFromDTO,
  putNotificationPolicy,
  policyToDTO,
  type DesktopLifecycleEvent,
} from '@/api/desktopNotifications'
import { resolveApiURL } from '@/services/desktop'

const defaultPolicy: DesktopNotificationPolicy = {
  systemNotificationsEnabled: true,
  onTaskCompleted: true,
  onTaskFailed: true,
  onUserInputNeeded: true,
  longRunningThresholdSeconds: 0,
}

let cachedPolicy: DesktopNotificationPolicy = defaultPolicy
let loaded = false
let loadPromise: Promise<DesktopNotificationPolicy> | null = null

export function getCachedNotificationPolicy(): DesktopNotificationPolicy {
  return cachedPolicy
}

export async function ensureNotificationPolicyLoaded(): Promise<DesktopNotificationPolicy> {
  if (loaded) return cachedPolicy
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const dto = await getNotificationPolicy()
        cachedPolicy = policyFromDTO(dto)
      } catch {
        cachedPolicy = defaultPolicy
      } finally {
        loaded = true
        loadPromise = null
      }
      return cachedPolicy
    })()
  }
  return loadPromise
}

export async function saveNotificationPolicy(
  policy: DesktopNotificationPolicy,
): Promise<DesktopNotificationPolicy> {
  const dto = await putNotificationPolicy(policyToDTO(policy))
  cachedPolicy = policyFromDTO(dto)
  loaded = true
  return cachedPolicy
}

// notifyFromAgentEvent inspects a streamed agent_event and surfaces a system
// notification when the cached policy says so. Returns true if a notification
// was fired (useful for tests / debug). Never throws — notification failure
// must not propagate into the agent stream.
export async function notifyFromAgentEvent(event: {
  event_type?: string
  label?: string
  message?: string
}): Promise<boolean> {
  if (!event) return false
  const policy = cachedPolicy
  if (!policy.systemNotificationsEnabled) return false
  const mapping: Record<string, { flag: keyof DesktopNotificationPolicy; title: string }> = {
    'task.completed': { flag: 'onTaskCompleted', title: 'Task completed' },
    'task.failed': { flag: 'onTaskFailed', title: 'Task failed' },
    'user.input_needed': { flag: 'onUserInputNeeded', title: 'User input needed' },
  }
  const hit = mapping[event.event_type || '']
  if (!hit) return false
  if (!policy[hit.flag]) return false
  const body = event.label || event.message || ''
  try {
    await showDesktopNotification(hit.title, body)
    return true
  } catch {
    return false
  }
}

export function resetNotificationPolicyCacheForTests() {
  cachedPolicy = defaultPolicy
  loaded = false
  loadPromise = null
}

let sessionStartedDispatched = false

// dispatchSessionStarted fires the `session_started` hook event once per page
// lifecycle. Safe to call from any number of mounts — the in-memory guard
// prevents duplicates after route changes or HMR.
export async function dispatchSessionStarted(): Promise<boolean> {
  if (sessionStartedDispatched) return false
  sessionStartedDispatched = true
  try {
    await dispatchLifecycleHook('session_started')
    return true
  } catch {
    sessionStartedDispatched = false
    return false
  }
}

// dispatchOnQuit fires the `on_quit` hook event from a `beforeunload` handler.
// Must use `fetch` + `keepalive` because axios cancels in-flight requests
// during page unload. Failures are swallowed; the renderer is going away.
export function dispatchOnQuit(): void {
  try {
    const url = resolveApiURL('/v1/desktop/hooks/lifecycle')
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'on_quit' }),
      credentials: 'include',
      keepalive: true,
    })
  } catch {
    // best-effort
  }
}

export function resetSessionStartedFlagForTests() {
  sessionStartedDispatched = false
}

export type { DesktopLifecycleEvent }
