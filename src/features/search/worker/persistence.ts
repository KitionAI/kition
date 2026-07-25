import { openDB, type IDBPDatabase } from 'idb'

export type SnapshotMeta = {
  version: number
  rootPath: string
  builtAt: number
  docCount: number
  sourceVersions: { note: string; kitable: string }
}

export type DirtyOp =
  | { type: 'upsert'; docIds: string[] }
  | { type: 'remove'; docIds: string[] }

interface SearchSchema {
  index:       { key: string; value: { id: string; blob: Uint8Array } }
  meta:        { key: string; value: { id: string } & SnapshotMeta }
  anchors:     { key: string; value: { id: string; anchor: unknown } }
  dirtyQueue:  { key: IDBValidKey; value: DirtyOp }
}

export type SearchDB = IDBPDatabase<SearchSchema>

export async function openSearchDb(rootHash: string): Promise<SearchDB> {
  return openDB<SearchSchema>(`kition-search-${rootHash}`, 1, {
    upgrade(db) {
      db.createObjectStore('index',      { keyPath: 'id' })
      db.createObjectStore('meta',       { keyPath: 'id' })
      db.createObjectStore('anchors',    { keyPath: 'id' })
      db.createObjectStore('dirtyQueue', { autoIncrement: true })
    },
  })
}

export async function writeSnapshot(db: SearchDB, blob: Uint8Array, meta: SnapshotMeta): Promise<boolean> {
  try {
    const tx = db.transaction(['index', 'meta'], 'readwrite')
    await Promise.all([
      tx.objectStore('index').put({ id: 'snapshot', blob } as any),
      tx.objectStore('meta').put({ id: 'meta', ...meta } as any),
    ])
    await tx.done
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') return false
    throw err
  }
}

export async function readSnapshot(db: SearchDB): Promise<{ blob: Uint8Array; meta: SnapshotMeta } | null> {
  const tx = db.transaction(['index', 'meta'], 'readonly')
  const [idx, meta] = await Promise.all([
    tx.objectStore('index').get('snapshot') as Promise<{ id: string; blob: Uint8Array } | undefined>,
    tx.objectStore('meta').get('meta') as Promise<({ id: string } & SnapshotMeta) | undefined>,
  ])
  await tx.done
  if (!idx || !meta) return null
  const { id: _id, ...metaRest } = meta as any
  return { blob: idx.blob, meta: metaRest as SnapshotMeta }
}

export async function pushDirty(db: SearchDB, op: DirtyOp): Promise<void> {
  const tx = db.transaction('dirtyQueue', 'readwrite')
  await tx.objectStore('dirtyQueue').add(op as any)
  await tx.done
}

export async function drainDirty(db: SearchDB): Promise<DirtyOp[]> {
  const tx = db.transaction('dirtyQueue', 'readonly')
  const all = await tx.objectStore('dirtyQueue').getAll()
  await tx.done
  return all as unknown as DirtyOp[]
}

export async function clearDirty(db: SearchDB): Promise<void> {
  const tx = db.transaction('dirtyQueue', 'readwrite')
  await tx.objectStore('dirtyQueue').clear()
  await tx.done
}
