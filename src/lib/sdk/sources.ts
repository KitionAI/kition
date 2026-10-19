// Copied from kition-sdk packages/sdk/src/sources.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { encodeOrigin, type Origin } from '../kdm'
import type { DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, ModelPort } from './port'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

export function isModelPort(value: unknown): value is ModelPort {
  return isObject(value) && typeof value.kitId === 'string' && isFunction(value.exportChanges) && isFunction(value.importChanges) && isFunction(value.command)
}

const bytes = (buffer: ArrayBuffer | Uint8Array): Uint8Array => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

const buffer = (view: Uint8Array): ArrayBuffer => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer

/** The parts of a `KitConnection` (`@kition/kit-host`) the object model uses. */
export type ConnectionLike = {
  kit: { id: string }
  capabilities: string[]
  ai: {
    commands: (query: string) => Promise<Array<Record<string, unknown>>>
    run: (steps: Array<{ command: string; params?: Record<string, unknown> }>, save: boolean) => Promise<{ completed: Array<{ result: unknown }> }>
  }
  replica: {
    exportChanges: (since: ArrayBuffer) => Promise<{ changes: ArrayBuffer; blobs: ArrayBuffer }>
    importChanges: (changes: ArrayBuffer, blobs: ArrayBuffer) => Promise<unknown>
    onChanged: (listener: (version: ArrayBuffer) => void) => () => void
  }
  /**
   * Hears the kit's `presence/set` (Kit UI protocol section 7e): what the person selected, as KDM
   * object ids. With it, the document fires `selection`.
   */
  onPresence?: (listener: (presence: { selection: string[] }) => void) => () => void
  /** The kit's own object model (capability `model`). */
  model?: {
    describe: (schema?: object) => Promise<Record<string, unknown>>
    batch: (params: Record<string, unknown>) => Promise<{ refs: Record<string, string>; results: unknown[]; loaded: Array<{ id: string; type: string; fields: Record<string, unknown> }>; version?: ArrayBuffer | null }>
  }
}

const isConnection = (value: unknown): value is ConnectionLike =>
  isObject(value) && isObject(value.kit) && Array.isArray(value.capabilities) && isObject(value.ai) && isObject(value.replica)

/**
 * A kit editor in a frame (Kit UI protocol): changes through `replica/export` and `replica/import`,
 * commands through the Kit AI bridge (`ai/run`, which the kit records as the agent's).
 */
export function portFromConnection(connection: ConnectionLike, options: { readOnly?: () => boolean } = {}): ModelPort {
  const model = connection.capabilities.includes('model') ? connection.model : undefined
  if (!connection.capabilities.includes('replica') && !model) {
    throw new Error(`${connection.kit.id} was opened without the replica capability: the host must offer replica (with @kition/embed, pass storage.replica or model: true)`)
  }
  const onPresence = typeof connection.onPresence === 'function' ? connection.onPresence.bind(connection) : null
  return {
    kitId: connection.kit.id,
    exportChanges: async (since) => bytes((await connection.replica.exportChanges(buffer(since))).changes),
    importChanges: async (changes) => {
      await connection.replica.importChanges(buffer(changes), new ArrayBuffer(0))
    },
    command: async (id, params) => {
      const result = await connection.ai.run([{ command: id, ...(isObject(params) ? { params } : {}) }], false)
      return result.completed[0]?.result ?? null
    },
    commands: async () => (await connection.ai.commands('')) as KitCommandInfo[],
    readOnly: options.readOnly,
    onChanged: (listener) => connection.replica.onChanged((version) => listener(bytes(version))),
    ...(onPresence
      ? {
          events: ['selection'] as const,
          on: <E extends DocumentEventName>(event: E, listener: (value: DocumentEvents[E]) => void) =>
            event === 'selection' ? onPresence((presence) => (listener as (value: DocumentEvents['selection']) => void)({ ids: [...presence.selection] })) : () => undefined,
        }
      : {}),
    ...(model
      ? {
          model: {
            describe: (schema) => model.describe(schema),
            batch: async (request, schema) => {
              const { version, ...result } = await model.batch({ ...request, schema })
              return { ...result, version: version ? bytes(version) : null }
            },
          },
        }
      : {}),
  }
}

/** The members of a kit engine's class (the Kit SDK's `export_kit_document!` and contract 2) the object model uses. */
export type EngineLike = {
  exportChanges: (since: Uint8Array) => Uint8Array
  importChanges: (changes: Uint8Array) => unknown
  execute: (command: string, params: string) => string
  executeAs?: (command: string, params: string, origin: string) => string
  commands: () => string
}

const isEngine = (value: unknown): value is EngineLike =>
  isObject(value) && isFunction(value.exportChanges) && isFunction(value.importChanges) && isFunction(value.execute) && isFunction(value.commands)

const parsed = (text: string): unknown => (text === '' ? null : JSON.parse(text))

/** A kit engine in this process (Node, a worker): commands run as the batch's origin when it has `executeAs`. */
export function portFromEngine(engine: EngineLike, kitId: string, options: { readOnly?: () => boolean; onChanged?: ModelPort['onChanged'] } & DocumentEventSource = {}): ModelPort {
  return {
    events: options.events,
    on: options.on,
    kitId,
    exportChanges: async (since) => engine.exportChanges(since),
    importChanges: async (changes) => {
      engine.importChanges(changes)
    },
    command: async (id: string, params: unknown, origin: Origin) => {
      const text = JSON.stringify(params ?? {})
      return parsed(engine.executeAs ? engine.executeAs(id, text, encodeOrigin(origin)) : engine.execute(id, text))
    },
    commands: async () => JSON.parse(engine.commands()) as KitCommandInfo[],
    readOnly: options.readOnly,
    onChanged: options.onChanged,
  }
}

/** An editor of `@kition/embed` (it gives its own port), a `KitConnection`, or an engine. */
export async function portFromSource(source: unknown, kit?: string): Promise<ModelPort> {
  if (isObject(source) && isFunction(source.modelPort)) return (await (source.modelPort as () => ModelPort | Promise<ModelPort>)()) as ModelPort
  if (isConnection(source)) return portFromConnection(source)
  if (isEngine(source)) {
    if (!kit) throw new Error('an engine does not name its kit: pass options.kit')
    return portFromEngine(source, kit)
  }
  throw new Error('openDocument takes a ModelPort, an @kition/embed editor, a KitConnection, or a kit engine')
}
