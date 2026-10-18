// Copied from kition-sdk packages/sdk/src/document.ts by scripts/sync-kit-host.mjs; change it there, not here.
import type { BatchRequest, BatchResult, Origin, Schema } from '../kdm'
import { Exchange, type ModelDescription } from './exchange'
import { kitModelBackend } from './kitModel'
import { kitDescriptor } from './kits'
import type { DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, ModelPort } from './port'
import { RequestContext, type CommandMap, type ModelObject } from './proxy'
import { isModelPort, portFromSource } from './sources'

/** The document moved: by this handle's own `sync()` (`local`) or otherwise (`kit`: a person, a command, a collaborator). */
export type ChangedEvent = { origin: 'local' | 'kit'; version: Uint8Array | null }

export type OpenOptions = {
  /** The kit's schema; by default the one registered for the kit's id (`registerKit`). */
  schema?: Schema | object
  /** The kit's id, for an engine (which does not name its kit). */
  kit?: string
  /** The origin every batch of this handle carries; `extension`/`script` by default. */
  origin?: Origin
}

/**
 * What answers a document's `model/describe` and `model/batch`: an `Exchange` over a `ModelPort`
 * (the object model on the host's side), or a kit that serves the object model itself (a
 * headless kit executable over the Kit Protocol, `@kition/sdk/node`'s `launchHeadlessKit`).
 */
export interface ModelBackend extends DocumentEventSource {
  readonly kitId: string
  readonly schema: Schema
  batch(request: BatchRequest): Promise<BatchResult>
  describe(): Promise<ModelDescription>
  commands(): Promise<KitCommandInfo[]>
  /** The document's version after this handle's last batch, when known. */
  version(): Uint8Array | null
  /** Hears the document move (its version when known). */
  onChanged?(listener: (version: Uint8Array | null) => void): () => void
}

/** An `Exchange` as a `ModelBackend`. */
export function exchangeBackend(exchange: Exchange): ModelBackend {
  return {
    kitId: exchange.port.kitId,
    schema: exchange.schema,
    batch: (request) => exchange.batch(request),
    describe: () => exchange.describe(),
    commands: () => exchange.port.commands(),
    version: () => exchange.version()?.encode() ?? null,
    onChanged: exchange.port.onChanged?.bind(exchange.port),
    events: exchange.port.events,
    on: exchange.port.on?.bind(exchange.port),
  }
}

/** A document opened for scripting: run batches through request contexts, and hear its changes. */
export class ModelDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap> {
  private listeners = new Set<(event: ChangedEvent) => void>()
  private unsubscribe: (() => void) | null = null
  /** Unsubscribes of the source's other events this handle hears. */
  private hearing = new Set<() => void>()
  private closed = false

  constructor(
    readonly backend: ModelBackend,
    private readonly origin?: Origin,
  ) {
    this.unsubscribe =
      backend.onChanged?.((version) => {
        // The engine announcing the changes this handle just gave it is not news.
        const own = this.backend.version()
        if (version && own && sameBytes(version, own)) return
        this.emit({ origin: 'kit', version })
      }) ?? null
  }

  get kitId(): string {
    return this.backend.kitId
  }

  get schema(): Schema {
    return this.backend.schema
  }

  /**
   * Runs `script` with a new request context; operations it queued and did not `sync()` are sent
   * when it returns. Answers what `script` answers.
   */
  async run<T>(script: (context: RequestContext<Root, C>) => Promise<T> | T): Promise<T> {
    const context = this.context()
    const value = await script(context)
    if (context.queued) await context.sync()
    return value
  }

  /** A request context to keep (`run` makes one per script). */
  context(): RequestContext<Root, C> {
    this.alive()
    return new RequestContext<Root, C>(this.schema, (request) => this.batch(request), this.origin)
  }

  /** One `model/batch` in its wire form. */
  async batch(request: BatchRequest): Promise<BatchResult> {
    this.alive()
    const result = await this.backend.batch(request.origin || !this.origin ? request : { ...request, origin: this.origin })
    if ((request.ops?.length ?? 0) > 0) this.emit({ origin: 'local', version: this.backend.version() })
    return result
  }

  /** `model/describe`: the schema, the root's id, and the kit's commands. */
  describe() {
    this.alive()
    return this.backend.describe()
  }

  readonly commands = {
    list: (): Promise<KitCommandInfo[]> => this.backend.commands(),
    /** Whether a command can run now. */
    enabled: async (id: string): Promise<boolean> => (await this.backend.commands()).some((command) => command.id === id && command.enabled !== false),
    /** Runs one command now (outside any request context). */
    run: async <K extends keyof C & string>(id: K, params?: C[K]): Promise<unknown> =>
      (await this.batch({ ops: [{ op: 'command', id, ...(params === undefined ? {} : { params }) }] })).results[0],
  }

  /**
   * Whether this document's source reports `event`: `changed` always; `saved`, `presence`,
   * `conflict`, and `selection` when its host or kit does (an `@kition/embed` editor reports
   * `saved` and `conflict`, and `presence` when it co-edits; a headless kit and a Node package
   * document report `saved`).
   */
  supports(event: 'changed' | DocumentEventName): boolean {
    return event === 'changed' || (typeof this.backend.on === 'function' && (this.backend.events ?? []).includes(event))
  }

  /** Hears an event; answers an unsubscribe. An event the source does not report (`supports`) is never heard. */
  on(event: 'changed', listener: (event: ChangedEvent) => void): () => void
  on<E extends DocumentEventName>(event: E, listener: (event: DocumentEvents[E]) => void): () => void
  on(event: string, listener: (event: never) => void): () => void {
    if (event === 'changed') {
      const heard = listener as (event: ChangedEvent) => void
      this.listeners.add(heard)
      return () => {
        this.listeners.delete(heard)
      }
    }
    if (!EVENTS.includes(event as DocumentEventName)) throw new Error(`unknown event \`${event}\``)
    this.alive()
    if (!this.supports(event as DocumentEventName)) return () => undefined
    const off = this.backend.on!(event as DocumentEventName, (value) => {
      const call = listener as (value: unknown) => void
      try {
        call(value)
      } catch (error) {
        console.error(`[kition-sdk] a ${event} listener failed`, error)
      }
    })
    this.hearing.add(off)
    return () => {
      if (this.hearing.delete(off)) off()
    }
  }

  /** Stops listening to the engine; the engine (or the kit's document) itself stays open. */
  close() {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
    for (const off of this.hearing) off()
    this.hearing.clear()
  }

  private alive() {
    if (this.closed) throw new Error('the document handle is closed')
  }

  private emit(event: ChangedEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[kition-sdk] a changed listener failed', error)
      }
    }
  }
}

const EVENTS: readonly DocumentEventName[] = ['saved', 'presence', 'conflict', 'selection']

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])

/**
 * Opens a document for scripting. `source` is a `ModelPort`, an `@kition/embed` editor, a
 * `KitConnection` (`@kition/kit-host`) whose kit has the `replica` or `model` capability, or a kit
 * engine (`options.kit` names its kit). A kit that answers the object model itself (`port.model`)
 * runs each batch as one undo step of the person's history; otherwise the batch runs here.
 */
export async function openDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(
  source: unknown,
  options: OpenOptions = {},
): Promise<ModelDocument<Root, C>> {
  const port: ModelPort = isModelPort(source) ? source : await portFromSource(source, options.kit)
  const schema = options.schema ?? kitDescriptor(port.kitId)?.schema
  if (!schema) throw new Error(`no schema for ${port.kitId}: pass options.schema or registerKit() its descriptor`)
  const backend = port.model ? kitModelBackend({ ...port, model: port.model }, schema) : exchangeBackend(new Exchange(port, schema))
  return new ModelDocument<Root, C>(backend, options.origin)
}
