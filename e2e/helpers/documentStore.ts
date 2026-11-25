/**
 * An in-memory document replica store (`.kition/docs/` on the desktop: each document's last snapshot and its checkpoints) for mock desktop bridges. It adds the store
 * commands to the page's `window.kitionDesktop`, behaves like the desktop shell (document id and index path checks,
 * the index version guard, the workspace root check), keeps its state across reloads like a disk would, and exposes
 * hooks to inspect the store and to make writes fail.
 */
import type { Page } from '@playwright/test'

import type { KitCheckpoint } from '@kition/sdk/protocol'
import type { KitReplicaMeta } from '../../src/services/desktopClient/bridge'

const STORAGE_KEY = 'kition.e2e.document-store'

/** What the mock store holds, as tests read it. */
export type DocumentStoreE2EState = {
  /** Per entry: the last written snapshot, the version it holds, and its blobs (base64). */
  entries: Record<string, { meta: KitReplicaMeta; snapshotBase64: string; version: string; blobsBase64?: string }>
  index: { entries: Record<string, string>; version: string | null }
  /** Per entry: its checkpoints, oldest first, each with the snapshot it keeps. */
  histories: Record<string, Array<KitCheckpoint & { snapshotBase64: string }>>
  /** `WriteDocumentStore` calls, refused ones included. */
  entryWrites: number
  /** `WriteDocumentIndex` calls, refused ones included. */
  indexWrites: number
  /** `DeleteDocumentStore` calls. */
  deletes: number
  /** When set, every `WriteDocumentStore` and `DeleteDocumentStore` call fails with this message. */
  failWrites: string | null
  /** When set, every `WriteDocumentIndex` call fails with this message. */
  failIndexWrites: string | null
}

type DocumentStoreE2E = DocumentStoreE2EState & {
  /** Replaces the index as another writer would, so the app's next guarded write conflicts. */
  setIndex: (entries: Record<string, string>) => void
}

declare global {
  interface Window {
    __KITION_DOCUMENT_STORE_E2E__?: DocumentStoreE2E
  }
}

/**
 * Adds the store commands to the mock bridge. Call it after the init script that installs `window.kitionDesktop`;
 * `root` is the workspace root the bridge reports, which `expected_root` must match.
 */
export async function installDocumentStoreBridge(page: Page, options: { root: string }) {
  await page.addInitScript(({ root, storageKey }) => {
    const bridge = (window as typeof window & { kitionDesktop?: Record<string, unknown> }).kitionDesktop
    if (!bridge) return
    const empty = {
      entries: {},
      histories: {},
      index: { entries: {}, version: null },
      entryWrites: 0,
      indexWrites: 0,
      deletes: 0,
      failWrites: null,
      failIndexWrites: null,
    }
    let saved: Partial<DocumentStoreE2EState> = {}
    try {
      saved = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    } catch {
      saved = {}
    }
    // Failure hooks last for one page load; the stored state and counters survive reloads.
    const store = { ...empty, ...saved, failWrites: null, failIndexWrites: null } as DocumentStoreE2E
    let versions = 0
    const persist = () => {
      const { entries, histories, index, entryWrites, indexWrites, deletes } = store
      window.localStorage.setItem(storageKey, JSON.stringify({ entries, histories, index, entryWrites, indexWrites, deletes }))
    }
    const nextVersion = () => {
      versions += 1
      return `e2e-${Date.now().toString(36)}-${versions}`
    }
    store.setIndex = (entries) => {
      store.index = { entries: { ...entries }, version: nextVersion() }
      persist()
    }
    window.__KITION_DOCUMENT_STORE_E2E__ = store

    const docIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
    /** Records a checkpoint keeping the written snapshot, like the desktop store; a write at the newest one's version answers it. */
    const record = (docId: string, input: { origin: string; author?: string; label?: string }, written: { snapshotBase64: string; version: string }) => {
      const history = store.histories[docId] ?? []
      const last = history[history.length - 1]
      if (last && last.version === written.version) return last
      const checkpoint = {
        id: crypto.randomUUID(), time: Date.now(), origin: input.origin, version: written.version, snapshotBase64: written.snapshotBase64,
        ...(input.author ? { author: input.author } : {}), ...(input.label ? { label: input.label } : {}),
      }
      store.histories[docId] = [...history, checkpoint].slice(-200)
      return checkpoint
    }
    const asKit = ({ snapshotBase64: _snapshot, ...checkpoint }: KitCheckpoint & { snapshotBase64: string }) => checkpoint
    const checkRoot = (request: { expected_root?: string } | null | undefined) => {
      if (request?.expected_root && request.expected_root !== root) throw new Error('DESIGN_WORKSPACE_CHANGED')
    }
    const checkDocId = (docId: unknown) => {
      if (typeof docId !== 'string' || !docIdPattern.test(docId)) throw new Error('invalid document id')
      return docId
    }
    const isIndexPath = (path: string) => path !== ''
      && !path.includes('\\')
      && !path.startsWith('/')
      && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.trim() === part)

    Object.assign(bridge, {
      ReadDocumentStore: async (request: { doc_id: string; expected_root?: string }) => {
        checkRoot(request)
        const stored = store.entries[checkDocId(request?.doc_id)]
        if (!stored) return null
        return { meta: JSON.parse(JSON.stringify(stored.meta)), snapshot_base64: stored.snapshotBase64, version: stored.version, ...(stored.blobsBase64 !== undefined ? { blobs_base64: stored.blobsBase64 } : {}) }
      },
      WriteDocumentStore: async (request: {
        doc_id: string; meta: KitReplicaMeta; snapshot_base64: string; version: string; blobs_base64?: string
        checkpoint?: { origin: string; author?: string; label?: string }; expected_root?: string
      }) => {
        store.entryWrites += 1
        persist()
        if (store.failWrites !== null) throw new Error(store.failWrites)
        checkRoot(request)
        const docId = checkDocId(request?.doc_id)
        if (request.meta?.docId !== docId) throw new Error('document store meta names another document')
        if (typeof request.snapshot_base64 !== 'string') throw new Error('a document store write carries a snapshot')
        if (typeof request.version !== 'string') throw new Error('a document store write names the version its snapshot holds')
        const written = { snapshotBase64: request.snapshot_base64, version: request.version }
        store.entries[docId] = { meta: JSON.parse(JSON.stringify(request.meta)), ...written, ...(typeof request.blobs_base64 === 'string' ? { blobsBase64: request.blobs_base64 } : {}) }
        const answer: Record<string, unknown> = { version: request.version }
        if (request.checkpoint) answer.checkpoint = asKit(record(docId, request.checkpoint, written))
        persist()
        return answer
      },
      ReadDocumentHistory: async (request: { doc_id: string; expected_root?: string }) => {
        checkRoot(request)
        return { checkpoints: [...(store.histories[checkDocId(request?.doc_id)] ?? [])].reverse().map(asKit) }
      },
      DocumentStoreStatus: async () => ({ writable: true, holder: null }),
      DeleteDocumentStore: async (request: { doc_id: string; expected_root?: string }) => {
        store.deletes += 1
        persist()
        if (store.failWrites !== null) throw new Error(store.failWrites)
        checkRoot(request)
        const docId = checkDocId(request?.doc_id)
        delete store.entries[docId]
        delete store.histories[docId]
        persist()
        return null
      },
      ReadDocumentIndex: async (request: { expected_root?: string }) => {
        checkRoot(request)
        return { entries: { ...store.index.entries }, version: store.index.version }
      },
      WriteDocumentIndex: async (request: { entries: Record<string, string>; expected_version: string | null; expected_root?: string }) => {
        store.indexWrites += 1
        persist()
        if (store.failIndexWrites !== null) throw new Error(store.failIndexWrites)
        checkRoot(request)
        for (const [path, docId] of Object.entries(request?.entries || {})) {
          if (!isIndexPath(path)) throw new Error('invalid document path in the document index')
          checkDocId(docId)
        }
        if ((request?.expected_version ?? null) !== store.index.version) throw new Error('DOCUMENT_INDEX_CONFLICT')
        store.index = { entries: { ...request.entries }, version: nextVersion() }
        persist()
        return { version: store.index.version }
      },
    })
  }, { root: options.root, storageKey: STORAGE_KEY })
}

/** A copy of the mock store's state. */
export async function readDocumentStoreState(page: Page): Promise<DocumentStoreE2EState> {
  return page.evaluate(() => {
    const store = window.__KITION_DOCUMENT_STORE_E2E__
    if (!store) throw new Error('The document store mock is unavailable')
    const { entries, histories, index, entryWrites, indexWrites, deletes, failWrites, failIndexWrites } = store
    return JSON.parse(JSON.stringify({ entries, histories, index, entryWrites, indexWrites, deletes, failWrites, failIndexWrites }))
  })
}

/** Makes every later replica write and delete fail with `message` (`null` lets them through). */
export async function failDocumentStoreWrites(page: Page, message: string | null) {
  await page.evaluate((failure) => {
    if (!window.__KITION_DOCUMENT_STORE_E2E__) throw new Error('The document store mock is unavailable')
    window.__KITION_DOCUMENT_STORE_E2E__.failWrites = failure
  }, message)
}

/** Makes every later index write fail with `message` (`null` lets them through). */
export async function failDocumentIndexWrites(page: Page, message: string | null) {
  await page.evaluate((failure) => {
    if (!window.__KITION_DOCUMENT_STORE_E2E__) throw new Error('The document store mock is unavailable')
    window.__KITION_DOCUMENT_STORE_E2E__.failIndexWrites = failure
  }, message)
}

/** Replaces the index as another writer would; the app's next guarded index write conflicts. */
export async function changeDocumentIndexExternally(page: Page, entries: Record<string, string>) {
  await page.evaluate((next) => {
    if (!window.__KITION_DOCUMENT_STORE_E2E__) throw new Error('The document store mock is unavailable')
    window.__KITION_DOCUMENT_STORE_E2E__.setIndex(next)
  }, entries)
}
