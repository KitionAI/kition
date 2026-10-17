/**
 * Starts a relay (`kitRelay.ts`) for every open document that can be co-edited
 * (`collabDocuments.ts`: kit documents whose kit serves the `replica` capability, boards, Markdown
 * documents, tables), when this window may co-edit (`collabConfigured`) and the document has a
 * room (`rooms.ts`, written by Share or Open shared document). Anything else is left alone: no
 * connection is made, nothing is sent, and no replica is touched.
 *
 * It also keeps the documents this person may only view (`viewer` rooms) read-only in every
 * editor (`@/services/documentAccess`).
 */
import type { Presence, SyncClient } from '@/lib/sync'
import { setReadOnlyDocuments } from '@/services/documentAccess'
import { followCollabDocuments, type CollabDocument, type CollabReplica } from './collabDocuments'
import { loadCollabToken, onCollabSettingsChanged, syncServerUrl } from './collabSettings'
import { setDocumentCollab, setDocumentPeers, setDocumentRole } from './collabStore'
import { startKitRelay, type KitRelay, type RelaySync } from './kitRelay'
import type { ReplicaVersions } from './replicaVersions'
import { fromHex, onRoomsChanged, readRoom, toHex, updateRoom, viewerPaths, type CollabRoom } from './rooms'
import { closeSyncClient, collabConfigured, syncClient } from './syncConnection'

type CollabClient = RelaySync & Pick<SyncClient, 'setPresence' | 'onPresence' | 'principal'>

export type CollabDependencies = {
  configured: () => Promise<boolean>
  client: () => Promise<CollabClient | null>
  versions: () => Promise<ReplicaVersions>
}

const DEFAULT_DEPENDENCIES: CollabDependencies = {
  configured: collabConfigured,
  client: syncClient,
  versions: async () => (await import('./replicaVersions')).LORO_REPLICA_VERSIONS,
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

function follow(document: CollabDocument, dependencies: CollabDependencies) {
  const { path } = document
  let stopped = false
  let starting = false
  let replica: CollabReplica | null = null
  let docId: string | null = null
  let relay: KitRelay | null = null
  let stopPresence: (() => void) | null = null

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
      const showPeers = (peers: Presence[]) => setDocumentPeers(path, peers, client.principal?.id)
      setDocumentCollab(path, { docId: id, peers: [], role: room.role })
      stopPresence = client.onPresence(id, showPeers)
      relay = startKitRelay({
        docId: id,
        replica,
        sync: client,
        versions,
        lastSent: fromHex(room.lastSent),
        since,
        onSent: (version) => updateRoom(id, { lastSent: toHex(version) }, { quiet: true }),
        onSeen: ({ seq, version }) => updateRoom(id, { seen: { seq, version: toHex(version) } }, { quiet: true }),
        onJoined: ({ presence, role }) => {
          showPeers(presence)
          setDocumentRole(path, role)
          // A role that changed (a viewer link opened, a member's role changed) is kept, and a
          // viewer's document turns read-only.
          if (readRoom(id)?.role !== role) updateRoom(id, { role })
          client.setPresence(id, { kit: document.kit })
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
    stopRooms()
    relay?.stop()
    stopPresence?.()
    replica?.dispose()
    if (relay) setDocumentCollab(path, null)
  }
}

/** Makes the documents of `viewer` rooms read-only in their editors, now and as rooms change. */
function followViewerDocuments() {
  const publish = () => setReadOnlyDocuments(viewerPaths())
  publish()
  return onRoomsChanged(publish)
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
