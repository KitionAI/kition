// Copied from kition-sdk packages/sdk/src/proxy.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Proxies and `sync()` (Office.js's request context): property writes and commands are queued as
 * operations, reads are queued with `load`, and `sync()` sends them as one `model/batch`.
 */
import type { BatchOp, BatchRequest, BatchResult, FieldDef, LoadedObject, Origin, Schema } from '../kdm'

/** Reading a property that no `load` + `sync()` has fetched. */
export class PropertyNotLoadedError extends Error {
  constructor(type: string, field: string) {
    super(`${type}.${field} is not loaded: call load(['${field}']) and await sync() first`)
    this.name = 'PropertyNotLoadedError'
  }
}

/** Reading what only exists after the next `sync()` (a new object's id, a command's result). */
export class NotSyncedError extends Error {
  constructor(what: string) {
    super(`${what} is known after the next sync()`)
    this.name = 'NotSyncedError'
  }
}

/** Every object proxy has these members besides its fields. */
export interface ModelObject {
  /** The object's id; for an object created in this batch, known after `sync()`. */
  readonly id: string
  readonly type: string
  /** Queues a read of `fields` (all fields when omitted) for the next `sync()`. */
  load(fields?: string[]): this
  /** Queues the object's deletion; it also leaves every list that holds it. */
  delete(): void
  /** Whether `field` has been loaded. */
  isLoaded(field: string): boolean
  /** The loaded fields as plain JSON. */
  toJSON(): Record<string, unknown>
}

/** A list field: an ordered collection of objects of one type. */
export interface ModelList<T extends ModelObject = ModelObject, F = Record<string, unknown>> {
  /** Queues a new object at the end (or `at`); answers its proxy. */
  add(fields?: F, options?: { at?: number }): T
  /** Queues inserting an existing object. */
  insert(index: number, item: T | string): void
  move(from: number, to: number): void
  remove(index: number): void
  /** Queues a read of the list. */
  load(): this
  /** The items after `load()` + `sync()`. */
  readonly items: T[]
  readonly length: number
  at(index: number): T
}

/** A text field. Positions count Unicode scalar values. */
export interface ModelText {
  insert(index: number, text: string): void
  delete(index: number, count: number): void
  set(text: string): void
  mark(start: number, end: number, key: string, value: unknown): void
  unmark(start: number, end: number, key: string): void
  load(): this
  /** The text after `load()` + `sync()`: a string, or its runs when the field has marks. */
  readonly value: string | Array<{ insert: string; attributes?: Record<string, unknown> }>
  toString(): string
}

/** A map field: string keys to JSON values. */
export interface ModelMap<V = unknown> {
  set(key: string, value: V): void
  delete(key: string): void
  load(): this
  get(key: string): V | undefined
  readonly value: Record<string, V>
}

/** A queued command's result, after `sync()`. */
export interface CommandResult<T = unknown> {
  readonly value: T
}

type ObjectState = { target: string; type: string; id: string | null; fields: Map<string, unknown> }

const STATE = Symbol('kition.object')

const isProxy = (value: unknown): value is { [STATE]: ObjectState } => typeof value === 'object' && value !== null && STATE in value

/** Proxies in a value become their targets (an id, or a `$` reference of this batch). */
function wire(value: unknown): unknown {
  if (isProxy(value)) return value[STATE].target
  if (Array.isArray(value)) return value.map(wire)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]))
  return value
}

export type CommandMap = Record<string, unknown>

/** The request context of `ModelDocument.run`: queue reads and writes, then `sync()`. */
export class RequestContext<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap> {
  private ops: BatchOp[] = []
  private loads: Array<{ state: ObjectState; fields?: string[] }> = []
  private created: ObjectState[] = []
  private pending: Array<{ index: number; set: (value: unknown) => void }> = []
  private proxies = new Map<string, ModelObject>()
  private refs = 0
  /** The document's root object. */
  readonly root: Root
  readonly commands: {
    /** Queues a command; its result is read after `sync()`. */
    run: <K extends keyof C & string>(id: K, params?: C[K]) => CommandResult
  }

  constructor(
    private readonly schema: Schema,
    private readonly send: (request: BatchRequest) => Promise<BatchResult>,
    private readonly origin?: Origin,
  ) {
    this.root = this.proxy({ target: 'root', type: schema.root, id: null, fields: new Map() }) as Root
    this.commands = {
      run: (id, params) => {
        let value: unknown
        let done = false
        this.pending.push({
          index: this.ops.length,
          set: (result) => {
            value = result
            done = true
          },
        })
        this.ops.push({ op: 'command', id, ...(params === undefined ? {} : { params: wire(params) }) })
        return {
          get value() {
            if (!done) throw new NotSyncedError(`the result of ${id}`)
            return value
          },
        }
      },
    }
  }

  /** A proxy of an existing object of type `type`. */
  object<T extends ModelObject = ModelObject>(id: string, type: string): T {
    const known = this.proxies.get(id)
    if (known) return known as T
    if (!this.schema.types[type]) throw new Error(`the kit has no type \`${type}\``)
    const proxy = this.proxy({ target: id, type, id, fields: new Map() })
    this.proxies.set(id, proxy)
    return proxy as T
  }

  /** Whether operations or reads wait for `sync()`. */
  get queued(): boolean {
    return this.ops.length > 0 || this.loads.length > 0
  }

  /** Sends the queued operations and reads as one batch, then fills the loaded proxies. */
  async sync(): Promise<void> {
    const ops = this.ops
    const loads = this.loads
    const created = this.created
    const pending = this.pending
    this.ops = []
    this.loads = []
    this.created = []
    this.pending = []
    if (ops.length === 0 && loads.length === 0) return
    const result = await this.send({
      ...(this.origin ? { origin: this.origin } : {}),
      ops,
      load: loads.map(({ state, fields }) => ({ target: state.target, ...(fields ? { fields } : {}) })),
    })
    for (const state of created) {
      const id = result.refs[state.target]
      if (id === undefined) continue
      state.id = id
      state.target = id
      this.proxies.set(id, this.proxyOf(state))
    }
    for (const { index, set } of pending) set(result.results[index])
    loads.forEach(({ state }, index) => this.fill(state, result.loaded[index]))
  }

  private fill(state: ObjectState, loaded: LoadedObject | undefined) {
    if (!loaded) return
    state.id = loaded.id
    state.type = loaded.type
    if (state.target === 'root') this.proxies.set(loaded.id, this.proxyOf(state))
    for (const [field, value] of Object.entries(loaded.fields)) state.fields.set(field, value)
  }

  private byState = new WeakMap<ObjectState, ModelObject>()

  private proxyOf(state: ObjectState): ModelObject {
    return this.byState.get(state) ?? this.proxy(state)
  }

  private push(op: BatchOp) {
    this.ops.push(op)
  }

  private field(state: ObjectState, name: string): FieldDef | undefined {
    return this.schema.types[state.type]?.fields[name]
  }

  private proxy(state: ObjectState): ModelObject {
    const context = this
    const children = new Map<string, unknown>()
    const base = {
      [STATE]: state,
      get id() {
        if (state.id === null) throw new NotSyncedError(`the id of a new ${state.type}`)
        return state.id
      },
      get type() {
        return state.type
      },
      load(fields?: string[]) {
        context.loads.push({ state, ...(fields ? { fields } : {}) })
        return proxy
      },
      delete() {
        context.push({ op: 'delete', target: state.target })
      },
      isLoaded(field: string) {
        return state.fields.has(field)
      },
      toJSON() {
        return { id: state.id, type: state.type, ...Object.fromEntries(state.fields) }
      },
    }
    const proxy: ModelObject = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver)
        const def = context.field(state, prop)
        if (!def) return undefined
        if (def.kind === 'list' || def.kind === 'text' || def.kind === 'map') {
          let child = children.get(prop)
          if (!child) children.set(prop, (child = context.container(state, prop, def, proxy)))
          return child
        }
        if (!state.fields.has(prop)) throw new PropertyNotLoadedError(state.type, prop)
        return state.fields.get(prop)
      },
      set(_target, prop, value) {
        if (typeof prop === 'symbol') return false
        const def = context.field(state, prop)
        if (!def) throw new Error(`${state.type} has no field \`${prop}\``)
        if (def.kind === 'text') {
          context.push({ op: 'text.set', target: state.target, field: prop, text: String(value) })
          return true
        }
        if (def.kind === 'list' || def.kind === 'map' || def.kind === 'tree') throw new Error(`${state.type}.${prop} is a ${def.kind}; use its methods`)
        const sent = wire(value)
        context.push({ op: 'set', target: state.target, field: prop, value: sent ?? null })
        state.fields.set(prop, sent ?? null)
        return true
      },
      has(target, prop) {
        return prop in target || (typeof prop === 'string' && context.field(state, prop) !== undefined)
      },
    }) as ModelObject
    this.byState.set(state, proxy)
    return proxy
  }

  private container(state: ObjectState, field: string, def: FieldDef, owner: ModelObject): unknown {
    const context = this
    const loaded = () => {
      if (!state.fields.has(field)) throw new PropertyNotLoadedError(state.type, field)
      return state.fields.get(field)
    }
    const target = () => state.target
    if (def.kind === 'list') {
      const of = def.of ?? ''
      const list: ModelList = {
        add(fields, options) {
          const ref = `$${(context.refs += 1)}`
          const created: ObjectState = { target: ref, type: of, id: null, fields: new Map() }
          context.created.push(created)
          context.push({ op: 'create', type: of, in: `${target()}.${field}`, ref, ...(fields ? { fields: wire(fields) } : {}), ...(options?.at !== undefined ? { at: options.at } : {}) })
          return context.proxy(created)
        },
        insert(index, item) {
          context.push({ op: 'list.insert', target: target(), field, index, item: typeof item === 'string' ? item : wire(item) })
        },
        move(from, to) {
          context.push({ op: 'list.move', target: target(), field, from, to })
        },
        remove(index) {
          context.push({ op: 'list.remove', target: target(), field, index })
        },
        load() {
          owner.load([field])
          return list
        },
        get items() {
          return (loaded() as string[]).map((id) => context.object(id, of))
        },
        get length() {
          return (loaded() as string[]).length
        },
        at(index) {
          const id = (loaded() as string[])[index]
          if (id === undefined) throw new RangeError(`${state.type}.${field} has no item ${index}`)
          return context.object(id, of)
        },
      }
      return list
    }
    if (def.kind === 'text') {
      const text: ModelText = {
        insert(index, value) {
          context.push({ op: 'text.insert', target: target(), field, index, text: value })
        },
        delete(index, count) {
          context.push({ op: 'text.delete', target: target(), field, index, count })
        },
        set(value) {
          context.push({ op: 'text.set', target: target(), field, text: value })
        },
        mark(start, end, key, value) {
          context.push({ op: 'text.mark', target: target(), field, start, end, key, value: wire(value) })
        },
        unmark(start, end, key) {
          context.push({ op: 'text.unmark', target: target(), field, start, end, key })
        },
        load() {
          owner.load([field])
          return text
        },
        get value() {
          return loaded() as ModelText['value']
        },
        toString() {
          const value = loaded()
          return typeof value === 'string' ? value : (value as Array<{ insert: string }>).map((run) => run.insert).join('')
        },
      }
      return text
    }
    const map: ModelMap = {
      set(key, value) {
        context.push({ op: 'map.set', target: target(), field, key, value: wire(value) })
      },
      delete(key) {
        context.push({ op: 'map.delete', target: target(), field, key })
      },
      load() {
        owner.load([field])
        return map
      },
      get(key) {
        return (loaded() as Record<string, unknown>)[key]
      },
      get value() {
        return loaded() as Record<string, unknown>
      },
    }
    return map
  }
}
