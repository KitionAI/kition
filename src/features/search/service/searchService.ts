import type {
  IndexableDoc, SearchHit, WorkerInbound, WorkerProgress,
} from '../types'
import { WorkerClient } from './workerClient'
import { parseQuery } from '../query/parser'
import { applyPostFilters } from '../query/operators'

const BATCH_SIZE = 200

function rid(): string { return Math.random().toString(36).slice(2, 10) }

async function rootHash(path: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(path))
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }
  let h = 2166136261
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8) + '00000000'
}

export type SearchServiceOptions = {
  workerFactory: () => Worker
}

export class SearchService {
  private client: WorkerClient | null = null
  private factory: () => Worker
  private currentRootPath = ''
  private onProgressCbs = new Set<(p: WorkerProgress) => void>()
  private onErrorCbs = new Set<(msg: string) => void>()
  private onChangeCbs = new Set<() => void>()

  constructor(opts: SearchServiceOptions) {
    this.factory = opts.workerFactory
  }

  onProgress(cb: (p: WorkerProgress) => void): () => void {
    this.onProgressCbs.add(cb)
    return () => { this.onProgressCbs.delete(cb) }
  }

  onError(cb: (msg: string) => void): () => void {
    this.onErrorCbs.add(cb)
    return () => { this.onErrorCbs.delete(cb) }
  }

  onChange(cb: () => void): () => void {
    this.onChangeCbs.add(cb)
    return () => { this.onChangeCbs.delete(cb) }
  }

  private changed(client: WorkerClient) {
    if (this.client === client) this.onChangeCbs.forEach(cb => cb())
  }

  async init(rootPath: string): Promise<{ restoredFromDisk: boolean; docCount: number; stamps: Record<string, string> }> {
    if (this.client) await this.destroy()
    this.currentRootPath = rootPath
    const worker = this.factory()
    this.client = new WorkerClient(worker)
    this.client.setOnProgress(p => this.onProgressCbs.forEach(cb => cb(p)))
    this.client.onError(msg => this.onErrorCbs.forEach(cb => cb(msg)))
    const out = await this.client.send({
      type: 'init', requestId: rid(), rootPath, rootHash: await rootHash(rootPath),
    })
    if (out.type !== 'ready') throw new Error('init failed: unexpected response')
    return { restoredFromDisk: out.restoredFromDisk, docCount: out.docCount, stamps: out.stamps ?? {} }
  }

  async destroy(): Promise<void> {
    // Snapshot the client and claim it BEFORE any await — otherwise a concurrent
    // destroy (onReload listener) + init pair both pass the null guard and the
    // second one crashes on `client.terminate()` after the first nulled it out.
    // That rejection bubbles out of init() and leaves the service worker-less.
    const client = this.client
    if (!client) return
    this.client = null
    try { await client.send({ type: 'destroy', requestId: rid() }, 2000) } catch {}
    client.terminate()
  }

  async bulkLoad(docs: IndexableDoc[]): Promise<void> {
    const client = this.client
    if (!client) throw new Error('service not initialized')
    if (docs.length === 0) {
      await client.send({ type: 'bulkLoad', requestId: rid(), docs: [], isFinal: true })
      this.changed(client)
      return
    }
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const slice = docs.slice(i, i + BATCH_SIZE)
      const isFinal = i + BATCH_SIZE >= docs.length
      const msg: WorkerInbound = { type: 'bulkLoad', requestId: rid(), docs: slice, isFinal }
      await client.send(msg)
    }
    this.changed(client)
  }

  /** `stamps`: the source files the docs were read from, at the stamp they were read at. */
  async upsert(docs: IndexableDoc[], stamps?: Record<string, string>): Promise<void> {
    const client = this.client
    if (!client) throw new Error('service not initialized')
    await client.send({ type: 'upsert', requestId: rid(), docs, ...(stamps ? { stamps } : {}) })
    this.changed(client)
  }

  async remove(ids: string[]): Promise<void> {
    const client = this.client
    if (!client) throw new Error('service not initialized')
    await client.send({ type: 'remove', requestId: rid(), ids })
    this.changed(client)
  }

  async removeByVaultPath(vaultPaths: string[]): Promise<void> {
    const client = this.client
    if (!client) throw new Error('service not initialized')
    await client.send({ type: 'removeByVaultPath', requestId: rid(), vaultPaths })
    this.changed(client)
  }

  async query(input: string, limit = 200): Promise<SearchHit[]> {
    if (!this.client) throw new Error('service not initialized')
    const ast = parseQuery(input)
    const out = await this.client.send({ type: 'query', requestId: rid(), ast, limit })
    if (out.type !== 'results') return []
    return applyPostFilters(out.hits, ast)
  }

  get rootPath(): string { return this.currentRootPath }
}
