/**
 * Starts a relay (`kitRelay.ts`) for every open kit document that can be co-edited: its kit
 * serves the `replica` capability, this window may co-edit (`collabConfigured`), and the
 * document has a room (`rooms.ts`, written by Share or Open shared document). Anything else is
 * left alone: no connection is made, nothing is sent.
 */
import { followKitConnections, type MountedKitDocument } from '@/features/kits/public'
import type { Presence, SyncClient } from '@/lib/sync'
import { loadCollabToken, onCollabSettingsChanged, syncServerUrl } from './collabSettings'
import { setDocumentCollab, setDocumentPeers } from './collabStore'
import { startKitRelay, type KitRelay, type RelaySync } from './kitRelay'
import type { ReplicaVersions } from './replicaVersions'
import { fromHex, onRoomsChanged, readRoom, toHex, writeRoom } from './rooms'
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

function follow(document: MountedKitDocument, dependencies: CollabDependencies) {
  const { connection, path } = document
  if (!connection.capabilities.includes('replica')) return undefined
  let stopped = false
  let starting = false
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
      docId ??= await connection.replica.info().catch(() => null)
      const room = docId ? readRoom(docId) : null
      if (!docId || !room || stopped) return
      const client = await dependencies.client()
      if (!client || stopped) return
      const versions = await dependencies.versions()
      if (stopped) return
      const id = docId
      const showPeers = (peers: Presence[]) => setDocumentPeers(path, peers, client.principal?.id)
      setDocumentCollab(path, { docId: id, peers: [] })
      stopPresence = client.onPresence(id, showPeers)
      relay = startKitRelay({
        docId: id,
        replica: connection.replica,
        sync: client,
        versions,
        lastSent: fromHex(room.lastSent),
        onSent: (version) => {
          const latest = readRoom(id)
          if (latest) writeRoom({ ...latest, lastSent: toHex(version) }, { quiet: true })
        },
        onJoined: ({ presence }) => {
          showPeers(presence)
          client.setPresence(id, { kit: document.kitId })
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
    if (relay) setDocumentCollab(path, null)
  }
}

/**
 * Follows the open kit documents for co-editing until the answered stop. When the server URL or
 * the session changes, every relay stops and the connection closes, then they start again under
 * the new settings.
 */
export function startCollab(dependencies: CollabDependencies = DEFAULT_DEPENDENCIES) {
  let unfollow = followKitConnections((document) => follow(document, dependencies))
  let settings = currentSettings()
  const stopSettings = onCollabSettingsChanged(() => {
    void currentSettings().then(async (next) => {
      // A session refreshed with the same token (the app restoring it) changes nothing.
      if (next === (await settings)) return
      settings = Promise.resolve(next)
      unfollow()
      if (dependencies === DEFAULT_DEPENDENCIES) closeSyncClient()
      unfollow = followKitConnections((document) => follow(document, dependencies))
    })
  })
  return () => {
    stopSettings()
    unfollow()
  }
}
