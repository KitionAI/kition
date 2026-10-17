/**
 * The relay between one open kit document's KDM replica (Kit UI protocol capability `replica`)
 * and its sync room (`kition-sync/1`): local edits go up as `changes/push`, other people's
 * `changes/pull` come down as `replica/import`.
 *
 * - **Up.** On every `replica/changed` (and when the room is joined or the connection comes back)
 *   the relay takes the replica's version `v`, exports the changes since `lastSent` (what the room
 *   is known to hold from here), uploads the export's blobs the server lacks (`blob/has`, then
 *   `blob/put`), and only then pushes the changes, so no one can receive a change before its blobs.
 *   `lastSent` then includes `v`. Offline, a push waits in the sync client's queue; an export
 *   whose blobs cannot be uploaded yet is not pushed at all, and `lastSent` stays put, so the
 *   next attempt (when the connection is back) exports it again: nothing is lost.
 * - **Down.** A pulled change's blobs are found in the change itself (see `blobSection.ts`) and
 *   fetched (`blob/get`) before `replica/import`. `lastSent` then also includes the version the
 *   change reaches, so the import (which moves the replica's version too) is not sent back.
 *
 * - **Position.** After the join's catch-up and after each pulled change, once every pulled change
 *   is imported, the relay reports the server `seq` it now has everything up to with the replica's
 *   version (`onSeen`); a later session whose replica still holds that version joins with
 *   `since` set to it, pulling only what is new.
 *
 * Everything runs one step at a time, in order. Imports are idempotent, so a change that arrives
 * twice (a reconnect's catch-up) is harmless.
 */
import type { ConnectionState, Presence, RoomJoinResult, SyncClient } from '@/lib/sync'
import { blobHashCandidates, decodeBlobSection, encodeBlobSection, type BlobEntry } from './blobSection'
import type { ReplicaVersions } from './replicaVersions'

/** The replica side: a mounted kit's `KitConnection.replica`, or a host editor's (`collabDocuments.ts`). */
export type RelayReplica = {
  version: () => Promise<ArrayBuffer>
  exportChanges: (since: ArrayBuffer) => Promise<{ changes: ArrayBuffer; blobs: ArrayBuffer }>
  importChanges: (changes: ArrayBuffer, blobs: ArrayBuffer) => Promise<unknown>
  onChanged: (listener: (version: ArrayBuffer) => void) => () => void
}

/** The sync side: the window's `SyncClient`. */
export type RelaySync = Pick<SyncClient, 'join' | 'leave' | 'push' | 'onChanges' | 'onState' | 'blobs'> & { readonly state: ConnectionState }

export type KitRelayOptions = {
  docId: string
  replica: RelayReplica
  sync: RelaySync
  versions: ReplicaVersions
  /** What the room is known to hold from this replica already (from an earlier session), if anything. */
  lastSent?: Uint8Array
  /** The room took a push: `version` is what it now holds from here (to keep for next time). */
  onSent?: (version: Uint8Array) => void
  /** The server `seq` to join the room from (an earlier session's `onSeen`); absent or `null`: from its snapshot. */
  since?: number | null
  /** The replica has every change of the room up to `seq`, and is at `version` (to keep for next time). */
  onSeen?: (seen: { seq: number; version: Uint8Array }) => void
  /** Joined (or re-joined) the room: its presence and this person's role. */
  onJoined?: (result: { presence: Presence[]; role: RoomJoinResult['role'] }) => void
  onError?: (error: unknown) => void
}

export type KitRelay = {
  stop: () => void
  /** Settles once every step queued so far has run (for tests). */
  idle: () => Promise<void>
}

const BLOB_MIME = 'application/octet-stream'

function bytes(buffer: ArrayBuffer | Uint8Array) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
}

function buffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer
}

export function startKitRelay(options: KitRelayOptions): KitRelay {
  const { docId, replica, sync, versions } = options
  let lastSent = options.lastSent ?? new Uint8Array()
  /** Blobs both the server and this replica hold. */
  const known = new Set<string>()
  /** Pulled changes whose blobs could not be fetched yet; imported once the connection is back. */
  const waiting: Uint8Array[] = []
  let joined = false
  let readOnly = false
  let stopped = false
  let queue: Promise<void> = Promise.resolve()

  const run = (step: () => Promise<void>) => {
    queue = queue.then(() => (stopped ? undefined : step())).catch((error: unknown) => options.onError?.(error))
    return queue
  }

  async function upload(entries: BlobEntry[]) {
    const fresh = entries.filter((entry) => !known.has(entry.hash))
    if (!fresh.length) return
    const { missing } = await sync.blobs.has(fresh.map((entry) => entry.hash))
    const absent = new Set(missing)
    for (const entry of fresh) if (absent.has(entry.hash)) await sync.blobs.put(entry.data, BLOB_MIME)
    for (const entry of fresh) known.add(entry.hash)
  }

  async function sendLocal() {
    if (!joined || readOnly) return
    const version = bytes(await replica.version())
    const exported = await replica.exportChanges(buffer(lastSent))
    const changes = bytes(exported.changes)
    if (versions.isEmpty(changes)) return
    try {
      await upload(decodeBlobSection(bytes(exported.blobs)))
    } catch {
      // Offline (or the server failed): pushed later from the same `lastSent`, blobs first.
      return
    }
    lastSent = versions.merge(lastSent, version)
    const sent = lastSent
    sync.push(docId, changes).then(() => options.onSent?.(sent), (error: unknown) => options.onError?.(error))
  }

  /** Imports one pulled change after fetching the blobs it needs; `false` when they could not be fetched. */
  async function importRemote(changes: Uint8Array) {
    const wanted = blobHashCandidates(changes).filter((hash) => !known.has(hash))
    let blobs: Uint8Array = new Uint8Array()
    if (wanted.length) {
      let fetched: BlobEntry[]
      try {
        const { missing } = await sync.blobs.has(wanted)
        const absent = new Set(missing)
        fetched = []
        for (const hash of wanted) if (!absent.has(hash)) fetched.push({ hash, data: (await sync.blobs.get(hash)).data })
      } catch {
        waiting.push(changes)
        return false
      }
      for (const entry of fetched) known.add(entry.hash)
      blobs = encodeBlobSection(fetched)
    }
    await replica.importChanges(buffer(changes), buffer(blobs))
    const end = versions.endOf(changes)
    if (end) lastSent = versions.merge(lastSent, end)
    return true
  }

  async function importWaiting() {
    while (waiting.length) {
      const next = waiting.shift()!
      if (!(await importRemote(next))) return
    }
  }

  /** Reports `seq` as seen, unless a pulled change is still waiting for its blobs. */
  async function seen(seq: number | undefined) {
    if (seq === undefined || waiting.length || !options.onSeen) return
    options.onSeen({ seq, version: bytes(await replica.version()) })
  }

  async function join() {
    const result = await sync.join(docId, options.since ?? null)
    joined = true
    readOnly = result.role === 'viewer'
    options.onJoined?.({ presence: result.presence, role: result.role })
    for (const changes of result.changes) await importRemote(changes)
    await seen(result.seq)
  }

  const unsubscribes = [
    sync.onChanges(docId, (notice) => void run(async () => {
      if (await importRemote(notice.changes)) await seen(notice.seq)
    })),
    replica.onChanged(() => void run(sendLocal)),
    sync.onState((state) => {
      if (state !== 'online') return
      void run(async () => {
        // The sync client re-joins a room it had joined by itself; only the first join is ours.
        if (!joined) await join()
        await importWaiting()
        await sendLocal()
      })
    }),
  ]
  if (sync.state === 'online') {
    void run(async () => {
      await join()
      await sendLocal()
    })
  }

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      for (const unsubscribe of unsubscribes) unsubscribe()
      if (joined) sync.leave(docId)
    },
    idle: () => queue,
  }
}
