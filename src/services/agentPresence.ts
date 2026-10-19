/**
 * Which open documents the agent is editing right now (architecture section 13: the agent is a
 * collaborator and appears in presence). The Kit AI bridge notes each agent edit it applies to a
 * live editor; a co-edited document then publishes the agent in its presence state (`collabRelays`)
 * until the agent has been quiet for a while, so the other people in the room see it.
 */

/** How long after its last edit the agent still counts as editing a document. */
const AGENT_PRESENCE_MS = 30_000

/** The agent as a document's presence state carries it (`presence/set` `state.agent`). */
type AgentPresence = { name: string; origin: 'agent' }

export const AGENT_PRESENCE: AgentPresence = { name: 'Agent', origin: 'agent' }

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Map<string, Set<(editing: boolean) => void>>()

function normalize(path: string) {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

function emit(path: string, editing: boolean) {
  for (const listener of listeners.get(path) ?? []) listener(editing)
}

/** The agent just edited the document at `path`. */
export function noteAgentEdit(path: string, quietMs = AGENT_PRESENCE_MS) {
  const key = normalize(path)
  const running = timers.get(key)
  if (running) clearTimeout(running)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      emit(key, false)
    }, quietMs),
  )
  if (!running) emit(key, true)
}

/** Whether the agent is editing the document at `path`. */
export function agentEditing(path: string) {
  return timers.has(normalize(path))
}

/** Hears the agent start and stop editing the document at `path`; answers an unsubscribe. */
export function onAgentEditing(path: string, listener: (editing: boolean) => void) {
  const key = normalize(path)
  const set = listeners.get(key) ?? new Set()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(key)
  }
}

/** The agent that a peer's presence state names, if any. */
export function agentOf(state: unknown): AgentPresence | null {
  const agent = (state as { agent?: unknown } | null)?.agent
  if (!agent || typeof agent !== 'object') return null
  const name = (agent as { name?: unknown }).name
  return { name: typeof name === 'string' && name.trim() ? name : AGENT_PRESENCE.name, origin: 'agent' }
}
