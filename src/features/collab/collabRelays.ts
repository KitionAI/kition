/**
 * Starts a relay (`startRelay`, `@/lib/sync`) for every open document that can be co-edited
 * (`collabDocuments.ts`: kit documents whose kit serves the `replica` capability, Markdown
 * documents, tables), when this window may co-edit (`collabConfigured`) and the document has a
 * room (`rooms.ts`, written by Share or Open shared document). Anything else is left alone: no
 * connection is made, nothing is sent, and no replica is touched.
 *
 * It also keeps the documents whose content this person may not change (`viewer` and `commenter`
 * rooms) read-only in every editor (`@/services/documentAccess`), tells editors who comments on a
 * relayed document and how (`@/services/documentComments`), and follows the owner changing this
 * person's role or removing them (`room/access`): removed, the document stops relaying and stays
 * here as a local copy.
 *
 * The agent is a collaborator (architecture section 13): while it edits a relayed document through
 * the Kit AI bridge (`@/services/agentPresence`), this person's presence state carries it as
 * `agent: { name, origin: 'agent' }`, and every viewer shows it as a peer of its own.
 *
 * What the person shares from the document's editor (Kit UI protocol section 7e: the objects they
 * selected, their caret, what they look at; `@/services/documentPresence`) goes in their presence
 * state as `{ kit, selection, caret?, viewport? }`, a viewer's too, and the editor hears what the
 * other people in the room share.
 *
 * A change a newer kit made (Kition platform rules M5a and M20, `./schemaWatch`) shows a notice;
 * one the kit refuses keeps the document read-only until the kit is updated, and the room position
 * is not kept past it, so the change is pulled again then.
 */
import { DocumentLeases, SyncRpcError, leaseHolder, startRelay, type Lease, type Presence, type Relay, type RelaySync, type ReplicaVersions, type SyncClient } from '@/lib/sync'
import { DocumentLeaseRefused, setDocumentLeaseProvider, type DocumentLease, type DocumentLeaseProvider } from '@/services/documentLeases'
import { AGENT_PRESENCE, agentEditing, onAgentEditing } from '@/services/agentPresence'
import { setReadOnlyDocuments } from '@/services/documentAccess'
import { setSharedCommentAccess } from '@/services/documentComments'
import { localPresence, onLocalPresence, setPresencePeers, type PeerPresence, type SharedPresence } from '@/services/documentPresence'
import { documentSchemaNotice, onDocumentSchemaNotices, schemaBlockedPaths, setDocumentSchemaNotice } from '@/services/documentSchema'
import { followCollabDocuments, type CollabDocument, type CollabReplica } from './collabDocuments'
import { loadCollabToken, onCollabSettingsChanged, syncServerUrl } from './collabSettings'
import { setDocumentCollab, setDocumentPeers, setDocumentRole } from './collabStore'
import { deleteRoom, fromHex, onRoomsChanged, readOnlyPaths, readRoom, toHex, updateRoom, type CollabRoom } from './rooms'
import { watchSchema } from './schemaWatch'
import { closeSyncClient, collabConfigured, syncClient } from './syncConnection'

type CollabClient = RelaySync & Pick<SyncClient, 'setPresence' | 'onPresence' | 'principal'> & Partial<Pick<SyncClient, 'leases' | 'onAccess'>>

export type CollabDependencies = {
  configured: () => Promise<boolean>
  client: () => Promise<CollabClient | null>
  versions: () => Promise<ReplicaVersions>
}

const DEFAULT_DEPENDENCIES: CollabDependencies = {
  configured: collabConfigured,
  client: syncClient,
  versions: async () => (await import('@/lib/sync/replicaVersions')).LORO_REPLICA_VERSIONS,
}

/** The settings a connection depends on; without a server the session is not even read. */
async function currentSettings() {
  const url = syncServerUrl()
  return url ? `${url} ${(await loadCollabToken()) ?? ''}` : ''
}

/**
 * The server `seq` to join `room` from: the one an earlier session saw, if the replica still holds
 * the version it had then (a replica that lost changes since, say a file restored from a backup,
 * catches up from the room's snapshot instead).
 */
async function resumeSeq(room: CollabRoom, replica: CollabReplica, versions: ReplicaVersions) {
  if (!room.seen) return null
  const version = new Uint8Array(await replica.version())
  return versions.includes(version, fromHex(room.seen.version)) ? room.seen.seq : null
}

/**
 * The lease provider of one co-edited document (Kit UI protocol section 7b): its kit's leases on
 * the room's scopes, held renewed until released or the document stops relaying.
 */
function leaseProvider(leases: DocumentLeases): DocumentLeaseProvider & { dispose: () => void } {
  const asDocumentLease = (lease: Lease): DocumentLease => ({ scope: lease.scope, holder: { principalId: lease.principalId, name: lease.name, self: leases.mine(lease) } })
  return {
    acquire: async (scope, ttl) => {
      try {
        const lease = await leases.acquire(scope, ttl)
        return lease ? asDocumentLease(lease) : null
      } catch (error) {
        const holder = leaseHolder(error)
        if (holder) throw new DocumentLeaseRefused('held', asDocumentLease(holder))
        if (error instanceof SyncRpcError && error.reason === 'forbidden') throw new DocumentLeaseRefused('read-only', null)
        throw error
      }
    },
    release: (scope) => leases.release(scope),
    list: () => leases.list().map(asDocumentLease),
    subscribe: (listener) => leases.onChanged(() => listener()),
    dispose: () => leases.dispose(),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What a peer's presence state shares (Kit UI protocol section 7e), checked: the state is the peer's own. */
function sharedPresence(state: unknown): SharedPresence {
  if (!isRecord(state)) return { selection: [] }
  const selection = Array.isArray(state.selection) ? state.selection.filter((id): id is string => typeof id === 'string').slice(0, 256) : []
  const caret = isRecord(state.caret) && typeof state.caret.object === 'string' && typeof state.caret.field === 'string' && Number.isInteger(state.caret.offset) && (state.caret.offset as number) >= 0
    ? { object: state.caret.object, field: state.caret.field, offset: state.caret.offset as number }
    : null
  return { selection, ...(caret ? { caret } : {}), ...(isRecord(state.viewport) ? { viewport: state.viewport } : {}) }
}

/** The other people in the room and what each shares; this person's own sessions are left out. */
function presencePeersOf(peers: Presence[], self: string | undefined): PeerPresence[] {
  return peers.filter((peer) => peer.principalId !== self).map((peer) => ({ principal: peer.principalId, name: peer.name, color: peer.color, ...sharedPresence(peer.state) }))
}

/** This person's presence state in the room: the kit, what they share from the editor, and the agent editing for them. */
function presenceState(kit: string, path: string) {
  const local = localPresence(path)
  return {
    kit,
    ...(local ? { selection: local.selection, ...(local.caret ? { caret: local.caret } : {}), ...(local.viewport ? { viewport: local.viewport } : {}) } : {}),
    ...(agentEditing(path) ? { agent: AGENT_PRESENCE } : {}),
  }
}

function follow(document: CollabDocument, dependencies: CollabDependencies) {
  const { path } = document
  let stopped = false
  let starting = false
  let replica: CollabReplica | null = null
  let docId: string | null = null
  let relay: Relay | null = null
  let stopPresence: (() => void) | null = null
  let stopLeases: (() => void) | null = null
  /** Publishes this person's presence again, now with or without the agent; set once joined. */
  let publishPresence: (() => void) | null = null
  const stopAgent = onAgentEditing(path, () => publishPresence?.())
  const stopLocal = onLocalPresence(path, () => publishPresence?.())

  let again = false
  const start = async (): Promise<void> => {
    if (stopped || relay) return
    if (starting) {
      again = true
      return
    }
    starting = true
    again = false
    try {
      if (!(await dependencies.configured()) || stopped) return
      replica ??= await document.connect().catch(() => null)
      if (stopped) return
      docId ??= replica ? await replica.docId().catch(() => null) : null
      const room = docId ? readRoom(docId) : null
      if (!replica || !docId || !room || stopped) return
      const client = await dependencies.client()
      if (!client || stopped) return
      const versions = await dependencies.versions()
      if (stopped) return
      const since = await resumeSeq(room, replica, versions).catch(() => null)
      if (stopped) return
      const id = docId
      const showPeers = (peers: Presence[]) => {
        setDocumentPeers(path, peers, client.principal?.id)
        setPresencePeers(path, presencePeersOf(peers, client.principal?.id))
      }
      setDocumentCollab(path, { docId: id, peers: [], role: room.role })
      stopPresence = client.onPresence(id, showPeers)
      if (client.leases) {
        const provider = leaseProvider(new DocumentLeases(client.leases, id))
        const withdraw = setDocumentLeaseProvider(path, provider)
        stopLeases = () => {
          withdraw()
          provider.dispose()
        }
      }
      relay = startRelay({
        docId: id,
        // A refused change (a newer kit migrated the document) is pulled again from the room's
        // snapshot once the kit is updated: the position kept for a later session goes.
        replica: watchSchema(path, document.kit, replica, { onBlocked: () => updateRoom(id, { seen: undefined }, { quiet: true }) }),
        sync: client,
        versions,
        lastSent: fromHex(room.lastSent),
        since,
        onSent: (version) => updateRoom(id, { lastSent: toHex(version) }, { quiet: true }),
        onSeen: ({ seq, version }) => {
          if (documentSchemaNotice(path)?.blocked) return
          updateRoom(id, { seen: { seq, version: toHex(version) } }, { quiet: true })
        },
        onJoined: ({ presence, role }) => {
          showPeers(presence)
          setDocumentRole(path, role)
          if (client.principal) setSharedCommentAccess(path, { principal: client.principal, role })
          // A role that changed (a viewer link opened, a member's role changed) is kept, and a
          // viewer's document turns read-only.
          if (readRoom(id)?.role !== role) updateRoom(id, { role })
          publishPresence = () => client.setPresence(id, presenceState(document.kit, path))
          publishPresence()
        },
        onAccess: (role) => {
          if (role) {
            setDocumentRole(path, role)
            if (client.principal) setSharedCommentAccess(path, { principal: client.principal, role })
            updateRoom(id, { role })
            return
          }
          // Removed from the room: the document stays here as a local copy.
          publishPresence = null
          setSharedCommentAccess(path, null)
          setPresencePeers(path, [])
          setDocumentSchemaNotice(path, null)
          stopLeases?.()
          stopLeases = null
          stopPresence?.()
          stopPresence = null
          relay?.stop()
          relay = null
          setDocumentCollab(path, null)
          deleteRoom(id)
        },
        onError: (error) => console.warn('[collab] relay', error),
      })
    } finally {
      starting = false
    }
    if (again) return start()
  }

  // A document shared after it opened starts relaying then.
  const stopRooms = onRoomsChanged(() => void start())
  void start()
  return () => {
    stopped = true
    publishPresence = null
    stopAgent()
    stopLocal()
    stopRooms()
    // Leases first, while the room is still joined.
    stopLeases?.()
    relay?.stop()
    stopPresence?.()
    replica?.dispose()
    if (relay) setDocumentCollab(path, null)
    setSharedCommentAccess(path, null)
    setPresencePeers(path, [])
    setDocumentSchemaNotice(path, null)
  }
}

/**
 * Makes the documents of `viewer` rooms, and those whose kit refused a newer kit's changes,
 * read-only in their editors, now and as rooms and notices change.
 */
function followViewerDocuments() {
  const publish = () => setReadOnlyDocuments([...readOnlyPaths(), ...schemaBlockedPaths()])
  publish()
  const stopRooms = onRoomsChanged(publish)
  const stopNotices = onDocumentSchemaNotices(publish)
  return () => {
    stopRooms()
    stopNotices()
  }
}

/**
 * Follows the open documents for co-editing until the answered stop. When the server URL or the
 * session changes, every relay stops and the connection closes, then they start again under the
 * new settings.
 */
export function startCollab(dependencies: CollabDependencies = DEFAULT_DEPENDENCIES) {
  const stopViewers = followViewerDocuments()
  let unfollow = followCollabDocuments((document) => follow(document, dependencies))
  let settings = currentSettings()
  const stopSettings = onCollabSettingsChanged(() => {
    void currentSettings().then(async (next) => {
      // A session refreshed with the same token (the app restoring it) changes nothing.
      if (next === (await settings)) return
      settings = Promise.resolve(next)
      unfollow()
      if (dependencies === DEFAULT_DEPENDENCIES) closeSyncClient()
      unfollow = followCollabDocuments((document) => follow(document, dependencies))
    })
  })
  return () => {
    stopSettings()
    stopViewers()
    unfollow()
  }
}
