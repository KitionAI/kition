/**
 * Presence in co-edited documents (Kit UI protocol section 7e), by workspace path: what this
 * person shares from an editor (the objects they selected, their caret, what they look at), which
 * co-editing carries to the document's room as their presence, and what the other people in the
 * room share, which co-editing sets and editors draw. A document that is not co-edited keeps what
 * its editor shares here and has no peers.
 */

/** A caret in a text field of a KDM object; the offset counts Unicode scalar values. */
type PresenceCaret = { object: string; field: string; offset: number }

/** What one person shares: selected KDM object ids, caret, and viewport (an editor's own shape). */
export type SharedPresence = { selection: string[]; caret?: PresenceCaret | null; viewport?: Record<string, unknown> | null }

/** Another person in the document: who, in which color, and what they share. */
export type PeerPresence = { principal: string; name: string; color: string } & SharedPresence

type Entry = { local: SharedPresence | null; peers: PeerPresence[] }

const documents = new Map<string, Entry>()
const localWatchers = new Map<string, Set<() => void>>()
const peerWatchers = new Map<string, Set<() => void>>()
const NO_PEERS: PeerPresence[] = []

function entry(path: string): Entry {
  let found = documents.get(path)
  if (!found) documents.set(path, (found = { local: null, peers: NO_PEERS }))
  return found
}

function tell(watchers: Map<string, Set<() => void>>, path: string) {
  for (const listener of [...(watchers.get(path) ?? [])]) listener()
}

function watch(watchers: Map<string, Set<() => void>>, path: string, listener: () => void) {
  let set = watchers.get(path)
  if (!set) watchers.set(path, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size && watchers.get(path) === set) watchers.delete(path)
  }
}

function forget(path: string) {
  const found = documents.get(path)
  if (found && !found.local && !found.peers.length) documents.delete(path)
}

/** Sets what this person shares from the editor of `path` (`null`: the editor closed). */
export function setLocalPresence(path: string, presence: SharedPresence | null) {
  entry(path).local = presence
  forget(path)
  tell(localWatchers, path)
}

export function localPresence(path: string): SharedPresence | null {
  return documents.get(path)?.local ?? null
}

/** Hears what this person shares from the editor of `path` change; answers an unsubscribe. */
export function onLocalPresence(path: string, listener: () => void) {
  return watch(localWatchers, path, listener)
}

/** Sets the other people in the document at `path` and what they share (`[]`: nobody, or no longer co-edited). */
export function setPresencePeers(path: string, peers: PeerPresence[]) {
  entry(path).peers = peers.length ? peers : NO_PEERS
  forget(path)
  tell(peerWatchers, path)
}

export function presencePeers(path: string): PeerPresence[] {
  return documents.get(path)?.peers ?? NO_PEERS
}

/** Hears the other people in the document at `path` change; answers an unsubscribe. */
export function onPresencePeers(path: string, listener: () => void) {
  return watch(peerWatchers, path, listener)
}
