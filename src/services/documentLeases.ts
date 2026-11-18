/**
 * Leases on co-edited documents' scopes (Kit UI protocol section 7b): co-editing registers each
 * relayed document's lease provider here, by workspace path, and kit editors take, release, and
 * follow leases through it. A document with no provider (not co-edited, or not yet joined) has no
 * leases: every acquire answers `null`, and the kit goes ahead.
 */

/** A lease as an editor sees it: who holds it, and whether that is this window (`self`). */
export type DocumentLease = { scope: string; holder: { principalId: string; name: string; self: boolean } }

/** Why an acquire was refused: another session holds the scope (`lease`), or the person may only view. */
export class DocumentLeaseRefused extends Error {
  readonly reason: 'held' | 'read-only'
  readonly lease: DocumentLease | null

  constructor(reason: 'held' | 'read-only', lease: DocumentLease | null) {
    super(reason === 'held' ? `${lease?.holder.name ?? 'someone'} holds ${lease?.scope ?? 'it'}` : 'the document is read-only')
    this.reason = reason
    this.lease = lease
  }
}

export type DocumentLeaseProvider = {
  /** Holds `scope` until released; `null` when there is nobody to coordinate with. Throws `DocumentLeaseRefused`. */
  acquire: (scope: string, ttl?: number) => Promise<DocumentLease | null>
  release: (scope: string) => Promise<void>
  list: () => DocumentLease[]
  subscribe: (listener: () => void) => () => void
}

const providers = new Map<string, DocumentLeaseProvider>()
const watchers = new Map<string, Set<() => void>>()

function changed(path: string) {
  for (const listener of [...(watchers.get(path) ?? [])]) listener()
}

/** Registers the lease provider of the co-edited document at `path`; answers its withdrawal. */
export function setDocumentLeaseProvider(path: string, provider: DocumentLeaseProvider) {
  providers.set(path, provider)
  const stop = provider.subscribe(() => changed(path))
  changed(path)
  return () => {
    stop()
    if (providers.get(path) !== provider) return
    providers.delete(path)
    changed(path)
  }
}

export function acquireDocumentLease(path: string, scope: string, ttl?: number) {
  return providers.get(path)?.acquire(scope, ttl) ?? Promise.resolve(null)
}

export async function releaseDocumentLease(path: string, scope: string) {
  await providers.get(path)?.release(scope)
}

export function documentLeases(path: string): DocumentLease[] {
  return providers.get(path)?.list() ?? []
}

/** Hears the leases of the document at `path` change (a provider coming or going too); answers an unsubscribe. */
export function onDocumentLeases(path: string, listener: () => void) {
  let set = watchers.get(path)
  if (!set) watchers.set(path, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size && watchers.get(path) === set) watchers.delete(path)
  }
}
