// Copied from kition-sdk packages/sync/src/leases.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Leases for coordinated objects (`kition-sync/1` 1.5, Kit Standard spec/reference/sync-protocol.md section 8): a
 * session takes a short lease on a scope (a KDM object id, a kit-named scope, or `*` for the whole
 * document) before an edit that does not merge meaningfully, and hears every room's lease list.
 * `SyncClient.leases` is one of these, wired to the client's connection.
 */
import { SyncRpcError, type Lease } from './protocol'

/** What the lease side needs from the client it belongs to. */
export type LeaseLink = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Whether the connection is up and the server listed the `leases` capability. */
  available: () => boolean
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/** A lease kept alive (`SyncLeases.hold`) until released or lost with the connection. */
export type LeaseHold = {
  readonly lease: Lease
  /** Ends the lease (`lease/release`) and stops renewing it. */
  release: () => Promise<void>
  /** Hears the lease being lost (the connection dropped, or a renewal was refused). */
  onLost: (listener: () => void) => () => void
}

const DEFAULT_TTL = 30_000

/** The lease that holds a colliding scope, from a refused `lease/acquire` (`conflict`). */
export function leaseHolder(error: unknown): Lease | undefined {
  if (!(error instanceof SyncRpcError) || error.reason !== 'conflict') return undefined
  const lease = (error.data as { lease?: unknown } | undefined)?.lease
  return lease && typeof lease === 'object' && typeof (lease as Lease).scope === 'string' ? (lease as Lease) : undefined
}

/** Whether two scopes collide: equal, or either is `*` (the whole document). */
export function scopesCollide(a: string, b: string) {
  return a === b || a === '*' || b === '*'
}

const key = (docId: string, scope: string) => `${docId}\u0000${scope}`

export class SyncLeases {
  private readonly lists = new Map<string, Lease[]>()
  private readonly listeners = new Map<string, Set<(leases: Lease[]) => void>>()
  private readonly holds = new Map<string, { stop: () => void; lose: () => void }>()
  /** This connection's session, learned from the first lease it was granted; reset with the connection. */
  private session: string | null = null

  constructor(private readonly link: LeaseLink) {}

  /** Whether the server keeps leases and the connection is up: without, there is nobody to coordinate with. */
  get available() {
    return this.link.available()
  }

  /** Takes (or renews) the lease on `scope` for `ttl` ms. Rejects `conflict` (see `leaseHolder`) when another session holds it. */
  async acquire(docId: string, scope: string, ttl?: number): Promise<Lease> {
    const result = (await this.link.request('lease/acquire', ttl === undefined ? { docId, scope } : { docId, scope, ttl })) as { lease: Lease }
    const learned = this.session !== result.lease.session
    this.session = result.lease.session
    // The server tells the room of a new lease before it answers the acquire: a list heard then
    // could not tell this session's leases yet, so its listeners hear it again now that it can.
    if (learned) for (const [heard, leases] of [...this.lists]) for (const listener of [...(this.listeners.get(heard) ?? [])]) listener(leases)
    return result.lease
  }

  /** Ends this session's lease on `scope` (harmless when it holds none). */
  async release(docId: string, scope: string): Promise<void> {
    this.holds.get(key(docId, scope))?.stop()
    await this.link.request('lease/release', { docId, scope })
  }

  /**
   * Takes the lease on `scope` and renews it at half its `ttl` until `release` (or the connection
   * drops, which loses it: the server ends a session's leases with the session). Holding a scope
   * already held renews it and answers a new hold that replaces the old one.
   */
  async hold(docId: string, scope: string, ttl = DEFAULT_TTL): Promise<LeaseHold> {
    const lease = await this.acquire(docId, scope, ttl)
    const id = key(docId, scope)
    this.holds.get(id)?.stop()
    const lost = new Set<() => void>()
    const schedule = this.link.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    const clear = this.link.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as number))
    let timer: unknown
    let active = true
    const stop = () => {
      if (!active) return
      active = false
      clear(timer)
      if (this.holds.get(id) === entry) this.holds.delete(id)
    }
    const lose = () => {
      if (!active) return
      stop()
      for (const listener of [...lost]) listener()
    }
    const renew = () => {
      timer = schedule(() => {
        if (!active) return
        this.acquire(docId, scope, ttl).then(
          () => active && renew(),
          () => lose(),
        )
      }, Math.max(500, Math.floor(ttl / 2)))
    }
    const entry = { stop, lose }
    this.holds.set(id, entry)
    renew()
    return {
      lease,
      release: async () => {
        stop()
        await this.link.request('lease/release', { docId, scope }).catch(() => undefined)
      },
      onLost: (listener) => {
        lost.add(listener)
        return () => lost.delete(listener)
      },
    }
  }

  /** The room's leases as last heard (`lease/changed`); empty before any and while offline. */
  list(docId: string): Lease[] {
    return this.lists.get(docId) ?? []
  }

  /** Hears `docId`'s lease list each time it changes; answers an unsubscribe. */
  onChanged(docId: string, listener: (leases: Lease[]) => void): () => void {
    let set = this.listeners.get(docId)
    if (!set) this.listeners.set(docId, (set = new Set()))
    set.add(listener)
    return () => set?.delete(listener)
  }

  /** Whether `lease` is this connection's own. */
  mine(lease: Lease) {
    return this.session !== null && lease.session === this.session
  }

  /** `lease/changed` from the server (the client routes it here). */
  receive(params: Record<string, unknown>) {
    const docId = params.docId
    if (typeof docId !== 'string' || !Array.isArray(params.leases)) return
    this.set(docId, params.leases as Lease[])
  }

  /** The connection dropped: the server ended this session's leases, and the lists are stale. */
  disconnected() {
    this.session = null
    for (const hold of [...this.holds.values()]) hold.lose()
    for (const docId of [...this.lists.keys()]) this.set(docId, [])
  }

  /** Left `docId`'s room: its list no longer applies, and nothing there is held any more. */
  left(docId: string) {
    for (const [id, hold] of [...this.holds]) if (id.startsWith(`${docId}\u0000`)) hold.lose()
    this.set(docId, [])
  }

  private set(docId: string, leases: Lease[]) {
    const before = this.lists.get(docId) ?? []
    if (!leases.length && !before.length) return
    if (leases.length) this.lists.set(docId, leases)
    else this.lists.delete(docId)
    for (const listener of [...(this.listeners.get(docId) ?? [])]) listener(leases)
  }
}

/**
 * One document's leases as an editor's host serves them to its kit: `acquire` holds a scope
 * (renewed until released), `release` ends it, and `dispose` (the editor closed) releases what is
 * still held. Without a server that keeps leases, or while offline, there is nobody to coordinate
 * with: `acquire` answers `null` and the edit goes ahead (an edit made then lands as a conflict
 * object if someone else held the lease meanwhile). A refusal rejects as `lease/acquire` did
 * (`conflict` with the holder, see `leaseHolder`; `forbidden` for a viewer).
 */
export class DocumentLeases {
  private readonly holds = new Map<string, LeaseHold>()

  constructor(
    private readonly leases: SyncLeases,
    readonly docId: string,
  ) {}

  async acquire(scope: string, ttl?: number): Promise<Lease | null> {
    if (!this.leases.available) return null
    let hold: LeaseHold
    try {
      hold = await this.leases.hold(this.docId, scope, ttl)
    } catch (error) {
      if (error instanceof SyncRpcError && (error.reason === 'conflict' || error.reason === 'forbidden' || error.reason === 'invalid')) throw error
      return null
    }
    this.holds.set(scope, hold)
    hold.onLost(() => {
      if (this.holds.get(scope) === hold) this.holds.delete(scope)
    })
    return hold.lease
  }

  async release(scope: string): Promise<void> {
    const hold = this.holds.get(scope)
    this.holds.delete(scope)
    await hold?.release()
  }

  list(): Lease[] {
    return this.leases.list(this.docId)
  }

  onChanged(listener: (leases: Lease[]) => void): () => void {
    return this.leases.onChanged(this.docId, listener)
  }

  mine(lease: Lease) {
    return this.leases.mine(lease)
  }

  /** Releases every lease still held for this editor. */
  dispose() {
    for (const hold of this.holds.values()) void hold.release()
    this.holds.clear()
  }
}
