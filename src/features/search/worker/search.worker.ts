/// <reference lib="webworker" />
import type { WorkerInbound, WorkerOutbound } from '../types'
import { createOramaIndex, type IndexHandle } from './oramaIndex'
import { openSearchDb, readSnapshot, writeSnapshot, pushDirty, drainDirty, clearDirty,
  type SearchDB } from './persistence'
import { makeProgressEmitter } from './progress'
import { save, load } from '@orama/orama'

declare const self: DedicatedWorkerScope
interface DedicatedWorkerScope extends WorkerGlobalScope {
  postMessage(message: WorkerOutbound): void
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null
}

let handle: IndexHandle | null = null
let db: SearchDB | null = null
let rootPath = ''
let dirtyCount = 0
let idleTimer: number | null = null
const SNAPSHOT_DIRTY_THRESHOLD = 200
const SNAPSHOT_IDLE_MS = 30_000

const emitter = makeProgressEmitter((m) => self.postMessage(m))

function scheduleIdleSnapshot() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { void doSnapshot() }, SNAPSHOT_IDLE_MS) as unknown as number
}

async function doSnapshot() {
  if (!handle || !db) return
  try {
    // save() is synchronous in orama v3 and returns RawData directly
    const payload = {
      orama: save(handle.db),
      docs: handle.serializeDocs(),
    }
    const u8 = new TextEncoder().encode(JSON.stringify(payload))
    const ok = await writeSnapshot(db, u8, {
      version: 1, rootPath, builtAt: Date.now(), docCount: handle.size(),
      sourceVersions: { note: '1', kitable: '1' },
    })
    if (ok) {
      await clearDirty(db)
      dirtyCount = 0
    } else {
      console.warn('[search worker] snapshot skipped: QuotaExceededError, dirty queue preserved')
    }
  } catch (err) {
    console.warn('[search worker] snapshot failed', err)
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data
  try {
    switch (msg.type) {
      case 'init': {
        rootPath = msg.rootPath
        db = await openSearchDb(msg.rootHash)
        handle = await createOramaIndex()
        const snap = await readSnapshot(db)
        let restored = false
        if (snap && snap.meta.rootPath === rootPath
            && snap.meta.sourceVersions.note === '1'
            && snap.meta.sourceVersions.kitable === '1') {
          try {
            const decoded = JSON.parse(new TextDecoder().decode(snap.blob))
            // Reject legacy snapshots (Orama-only) — they leave the side-channel
            // maps empty, which makes all queries silently return zero hits.
            if (decoded && decoded.orama && Array.isArray(decoded.docs)) {
              // load() is synchronous in orama v3
              load(handle.db, decoded.orama)
              handle.restoreDocs(decoded.docs)
              await drainDirty(db)
              await clearDirty(db)
              restored = true
            } else {
              console.warn('[search worker] snapshot missing docs side-channel, rebuilding from sources')
            }
          } catch (e) {
            console.warn('[search worker] snapshot load failed, starting fresh', e)
          }
        }
        self.postMessage({
          type: 'ready', requestId: msg.requestId, restoredFromDisk: restored, docCount: handle.size(),
        })
        break
      }
      case 'bulkLoad': {
        if (!handle) throw new Error('index not initialized')
        await handle.bulkInsert(msg.docs)
        emitter.tick(msg.docs[0]?.kind === 'note' ? 'note' : 'kitable', msg.docs.length)
        self.postMessage({ type: 'ack', requestId: msg.requestId })
        if (msg.isFinal) {
          emitter.flush('note'); emitter.flush('kitable')
          await doSnapshot()
          emitter.flush('persist')
        }
        break
      }
      case 'upsert': {
        if (!handle || !db) throw new Error('index not initialized')
        await handle.bulkInsert(msg.docs)
        await pushDirty(db, { type: 'upsert', docIds: msg.docs.map(d => d.id) })
        dirtyCount += msg.docs.length
        if (dirtyCount >= SNAPSHOT_DIRTY_THRESHOLD) await doSnapshot()
        else scheduleIdleSnapshot()
        self.postMessage({ type: 'ack', requestId: msg.requestId })
        break
      }
      case 'remove': {
        if (!handle || !db) throw new Error('index not initialized')
        await handle.removeIds(msg.ids)
        await pushDirty(db, { type: 'remove', docIds: msg.ids })
        dirtyCount += msg.ids.length
        if (dirtyCount >= SNAPSHOT_DIRTY_THRESHOLD) await doSnapshot()
        else scheduleIdleSnapshot()
        self.postMessage({ type: 'ack', requestId: msg.requestId })
        break
      }
      case 'removeByVaultPath': {
        if (!handle || !db) throw new Error('index not initialized')
        const ids: string[] = []
        for (const [id, doc] of handle.fullDocs) {
          if (msg.vaultPaths.includes(doc.vaultPath)) ids.push(id)
        }
        await handle.removeIds(ids)
        await pushDirty(db, { type: 'remove', docIds: ids })
        dirtyCount += ids.length
        if (dirtyCount >= SNAPSHOT_DIRTY_THRESHOLD) await doSnapshot()
        else scheduleIdleSnapshot()
        self.postMessage({ type: 'ack', requestId: msg.requestId })
        break
      }
      case 'query': {
        if (!handle) throw new Error('index not initialized')
        const hits = await handle.query(msg.ast, msg.limit)
        self.postMessage({ type: 'results', requestId: msg.requestId, hits, truncated: false })
        break
      }
      case 'destroy': {
        if (idleTimer !== null) clearTimeout(idleTimer)
        if (db) { db.close(); db = null }
        handle = null
        self.postMessage({ type: 'ack', requestId: msg.requestId })
        break
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error', requestId: (msg as { requestId: string }).requestId,
      message: err instanceof Error ? err.message : String(err), recoverable: true,
    })
  }
}
