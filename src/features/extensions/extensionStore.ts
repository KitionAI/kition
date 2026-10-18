import { openDB, type IDBPDatabase } from 'idb'
import type { ExtensionManifest } from '@/lib/extensions'

/** An installed extension, kept in this app's own storage (not in the workspace). */
export type InstalledExtension = {
  id: string
  manifest: ExtensionManifest
  /** Its entry module's source. */
  source: string
  enabled: boolean
  installedAt: number
  /** The workspace path it was installed from. */
  from: string
}

const DATABASE = 'kition-extensions'
const STORE = 'extensions'

let database: Promise<IDBPDatabase> | null = null

function open() {
  database ??= openDB(DATABASE, 1, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: 'id' })
    },
  })
  return database
}

export async function listInstalledExtensions(): Promise<InstalledExtension[]> {
  const all = (await (await open()).getAll(STORE)) as InstalledExtension[]
  return all.sort((left, right) => left.installedAt - right.installedAt)
}

export async function putInstalledExtension(extension: InstalledExtension) {
  await (await open()).put(STORE, extension)
}

export async function deleteInstalledExtension(id: string) {
  await (await open()).delete(STORE, id)
}

/** Forgets the open database (tests delete it between cases). */
export async function closeExtensionStore() {
  const open = database
  database = null
  ;(await open)?.close()
}
