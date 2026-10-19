/** Which open documents are co-edited right now, and who else is in each one: for the tab's indicators. */
import { useSyncExternalStore } from 'react'
import type { Presence, Role } from '@/lib/sync'
import { agentOf } from '@/services/agentPresence'

/** A co-edited document: its room, the other people in it, and this person's role there. */
export type DocumentCollab = { docId: string; peers: Presence[]; role?: Role }

const documents = new Map<string, DocumentCollab>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Marks the document at `path` co-edited (or not, with `null`). */
export function setDocumentCollab(path: string, value: DocumentCollab | null) {
  if (value) documents.set(path, value)
  else documents.delete(path)
  emit()
}

/** Whether the document at `path` relays to a room now (shared, or synced to this person's devices). */
export function isDocumentCollab(path: string) {
  return documents.has(path)
}

/** The colour of an agent's avatar: the product purple, whoever runs it. */
export const AGENT_PEER_COLOR = '#5645d4'

/** The id of the agent peer of `principalId`: the agent edits for that person (standard A11). */
const agentPeerId = (principalId: string) => `${principalId}#agent`

/** Whether a peer is an agent (one a person's presence state carries), not a person. */
export function isAgentPeer(peer: Presence) {
  return (peer.state as { agent?: unknown } | null)?.agent === true
}

/**
 * The other people in the document's room (`self` is this person's principal id, left out), and
 * the agents editing in it, each as a peer of its own: a person whose presence state carries
 * `agent` has the agent editing for them (`collabRelays`), this person's own agent included.
 */
export function setDocumentPeers(path: string, peers: Presence[], self: string | undefined) {
  const current = documents.get(path)
  if (!current) return
  const others = peers.filter((peer) => peer.principalId !== self)
  const people = others.filter((peer, index) => others.findIndex((other) => other.principalId === peer.principalId) === index)
  const agents: Presence[] = []
  for (const peer of peers) {
    const agent = agentOf(peer.state)
    const id = agentPeerId(peer.principalId)
    if (agent && !agents.some((known) => known.principalId === id)) {
      agents.push({ principalId: id, name: agent.name, color: AGENT_PEER_COLOR, state: { agent: true, origin: agent.origin, for: peer.principalId } })
    }
  }
  documents.set(path, { ...current, peers: [...people, ...agents] })
  emit()
}

/** This person's role in the document's room, as the room answered it. */
export function setDocumentRole(path: string, role: Role) {
  const current = documents.get(path)
  if (!current || current.role === role) return
  documents.set(path, { ...current, role })
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The co-editing state of the document at `path`, or `null` when it is not shared. */
export function useDocumentCollab(path: string | undefined): DocumentCollab | null {
  return useSyncExternalStore(subscribe, () => (path ? documents.get(path) ?? null : null), () => null)
}
