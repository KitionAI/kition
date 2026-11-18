/**
 * "Sync all my documents" (kition-sync 1.9, an account setting, off by default): while it is on,
 * every co-editable document open in this window that carries its document identity (a KDM
 * replica with a `docId`) and has no room yet is synced to this person's devices as a private
 * room. Recording the room starts its relay (`collabRelays.ts`). A document without a replica yet
 * is left alone: making one would mean saving it, which only the person decides (the "Sync to my
 * devices" action saves first). Nothing here connects, or touches a replica, while it is off.
 */
import { onSyncAllChanged, syncAllDocuments } from './accountSettings'
import { followCollabDocuments, type CollabDocument } from './collabDocuments'
import { readRoom } from './rooms'
import { syncReplicaToMyDevices } from './shareActions'
import { collabConfigured, onlineSyncClient } from './syncConnection'

function follow(document: CollabDocument) {
  let stopped = false
  let busy = false
  const check = async () => {
    if (stopped || busy || !syncAllDocuments()) return
    busy = true
    try {
      if (!(await collabConfigured()) || stopped) return
      const replica = await document.connect()
      try {
        const docId = await replica.docId()
        if (!docId || readRoom(docId) || stopped) return
        const client = await onlineSyncClient()
        if (stopped || !syncAllDocuments()) return
        await syncReplicaToMyDevices(client, replica, docId, document.path, document.kit)
      } finally {
        replica.dispose()
      }
    } catch (error) {
      console.warn('[collab] sync to my devices', error)
    } finally {
      busy = false
    }
  }
  void check()
  const stop = onSyncAllChanged(() => void check())
  return () => {
    stopped = true
    stop()
  }
}

/** Follows the open documents for "Sync all my documents" until the answered stop. */
export function startAutoSync() {
  return followCollabDocuments(follow)
}
