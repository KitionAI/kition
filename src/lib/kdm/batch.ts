// Copied from kition-sdk packages/kdm/src/batch.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Object-model batches (`KitObjectModel 1.0`, Kition platform `docs/platform/sets/object-model.md`): the twin of the Rust
 * crate's `batch` module, run on the same fixtures (`crates/kition-kdm/tests/fixtures/batch.json`).
 *
 * A batch is `{ origin?, ops, load? }`. Runs of model operations become one transaction each;
 * `command` operations go to the kit between them (`BatchTarget.command`). `$` references bind the
 * ids of objects the batch creates; a string equal to a bound reference, anywhere in an
 * operation's values or a command's parameters, becomes its id. Text positions count Unicode
 * scalar values (rule M18), converted here to the UTF-16 units of this implementation's `Tx`.
 */
import { errors, KdmError } from './errors'
import type { NodeRef, ObjectId } from './ids'
import { checkOrigin, type Origin } from './origin'
import type { TreeEntry } from './ids'
import type { Replica } from './replica'
import { fieldDef, hasMarks, hasToolIds, KDM_VERSION, mapHeld, owning, objectReadOnly, parseSchema, sortedKeys, typeDef, type FieldKind, type Schema, type TypeDef } from './schema'
import { isUnresolved, ToolIds, type Unresolved } from './toolIds'
import type { Tx } from './tx'
import { hasProjections, ProjectionView, routeProjection, type ProjectedObject } from './projection'

export const OBJECT_MODEL_CAPABILITY = 'KitObjectModel 1.0'

export type BatchErrorCode = 'invalid-op' | 'not-found' | 'invalid-value' | 'read-only' | 'command-failed'

export class BatchError extends Error {
  readonly code: BatchErrorCode
  readonly index: number | null

  constructor(code: BatchErrorCode, index: number | null, message: string) {
    super(message)
    this.name = 'BatchError'
    this.code = code
    this.index = index
  }

  toJSON() {
    return { code: this.code, index: this.index, message: this.message }
  }
}

export type BatchOp = { op: string; [key: string]: unknown }
export type BatchLoad = { target: string; fields?: string[] }
export type BatchRequest = { origin?: Origin | null; ops?: BatchOp[]; load?: BatchLoad[]; objects?: boolean }
export type LoadedObject = { id: string; type: string; fields: Record<string, unknown>; projected?: boolean; at?: ProjectedObject['at'] }
export type BatchResult = { refs: Record<string, string>; results: unknown[]; loaded: LoadedObject[]; objects?: Array<{id:string;type:string}> }

/** What a batch runs against: a replica that takes transactions, and a kit that runs commands. */
export interface BatchTarget {
  projectedObjects?(): ProjectedObject[] | Promise<ProjectedObject[]>
  /** The replica reads come from, current with the document. */
  replica(): Replica | Promise<Replica>
  /** Runs `write` as one transaction with `origin`; nothing changes when it throws. */
  transact(origin: Origin, write: (tx: Tx) => void): void | Promise<void>
  /** Runs a kit command as `origin`; answers its result. */
  command(id: string, params: unknown, origin: Origin): unknown | Promise<unknown>
  commandAt?(id: string, params: unknown, context: { on?: unknown; part?: unknown; time?: unknown }, origin: Origin): unknown | Promise<unknown>
  readOnly?: () => boolean
}

/** A `Replica` as a `BatchTarget` without commands. */
export function replicaTarget(replica: Replica): BatchTarget {
  return {
    replica: () => replica,
    transact: (origin, write) => replica.transact(origin, write),
    command: (id) => {
      throw new Error(`unknown command \`${id}\`: this document runs no commands`)
    },
  }
}

const WRITES = new Set(['create', 'set', 'delete', 'text.insert', 'text.delete', 'text.set', 'text.mark', 'text.unmark', 'list.insert', 'list.move', 'list.remove', 'map.set', 'map.delete', 'tree.insert', 'tree.move', 'command'])

/** The origin of a batch: `extension`/`script` when absent; only `person`, `agent`, and `extension`. */
export function batchOrigin(value: unknown): Origin {
  if (value === undefined || value === null) return { kind: 'extension', principal: 'script' }
  const bad = () => new BatchError('invalid-op', null, 'origin is { kind: person | agent | extension, principal, label? }')
  try {
    checkOrigin(value)
  } catch {
    throw bad()
  }
  if (!['person', 'agent', 'extension'].includes(value.kind)) throw bad()
  return value.label === undefined ? { kind: value.kind, principal: value.principal } : { kind: value.kind, principal: value.principal, label: value.label }
}

type Refs = Map<string, ObjectId>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` with every string equal to a bound reference replaced by its id. */
export function resolveValues(value: unknown, refs: ReadonlyMap<string, ObjectId>): unknown {
  if (typeof value === 'string') return refs.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => resolveValues(item, refs))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = resolveValues(item, refs)
    return out
  }
  return value
}

/** The root object: the first object of the schema's root type. */
export const rootId = (replica: Replica): ObjectId | null => replica.objectsOfType(replica.schema.root)[0] ?? null

function kdmError(index: number | null, error: unknown): BatchError {
  if (error instanceof BatchError) return error
  if (error instanceof KdmError) return new BatchError(error.reason === 'not-found' ? 'not-found' : 'invalid-value', index, error.message)
  return new BatchError('invalid-value', index, error instanceof Error ? error.message : String(error))
}

/** A target that names no object (`not-found`) or several (`invalid-op`), saying which it may mean (KHP A44, A48). */
const refused = (index: number | null, unresolved: Unresolved): BatchError =>
  new BatchError(unresolved.reason === 'not-found' ? 'not-found' : 'invalid-op', index, unresolved.message)

/** The id a target names: `root`, a bound `$reference`, a tool id (rule OM9), or an object id (for which `exists` holds, when the schema declares tool ids). */
function targetId(text: unknown, refs: Refs, names: ToolIds, exists: (id: ObjectId) => boolean, root: () => ObjectId | null, index: number | null): ObjectId {
  if (typeof text !== 'string') throw new BatchError('invalid-op', index, '`target` is a string')
  if (text === 'root') {
    const id = root()
    if (id === null) throw new BatchError('not-found', index, 'the document has no root object')
    return id
  }
  if (text.startsWith('$')) {
    const id = refs.get(text)
    if (id === undefined) throw new BatchError('not-found', index, `\`${text}\` is not bound in this batch`)
    return id
  }
  if (text === '') throw new BatchError('invalid-op', index, 'a target is not empty')
  const resolved = names.resolve(text, exists)
  if (isUnresolved(resolved)) throw refused(index, resolved)
  return resolved
}

/** As the Rust `ref_value`: a `ref` field's value given as a tool id, as the object id it names (rule OM9). */
function refValue(tx: Tx, schema: Schema, names: ToolIds, index: number, ty: string, field: string, value: unknown): unknown {
  if (typeof value !== 'string' || !names.isActive() || value === '') return value
  const def = schema.types[ty]?.fields[field]
  if (!def || !(def.kind === 'ref' || (def.kind === 'map' && def.of !== undefined))) return value
  const resolved = names.resolve(value, (id) => tx.exists(id))
  if (!isUnresolved(resolved)) return resolved
  if (resolved.reason === 'not-found') return value
  throw refused(index, resolved)
}

/** As the Rust `show_ids`: a loaded field with the ids it holds as tool ids (rule OM9). */
function showIds(names: ToolIds, kind: FieldKind, value: unknown): unknown {
  if (!names.isActive()) return value
  const show = (item: unknown) => (typeof item === 'string' ? names.show(item) : item)
  if (kind === 'ref') return show(value)
  if (kind === 'text') return names.showText(value)
  if (kind === 'list' && Array.isArray(value)) return value.map(show)
  if (kind === 'tree' && Array.isArray(value)) {
    return value.map((entry: { object: unknown; parent: unknown }) => ({ ...entry, object: show(entry.object), parent: show(entry.parent) }))
  }
  if (kind === 'map' || kind === 'json') return names.showJson(value)
  return value
}

function opName(index: number, op: unknown): string {
  const name = isRecord(op) ? op.op : undefined
  if (typeof name !== 'string') throw new BatchError('invalid-op', index, 'an operation is an object with an `op`')
  if (!WRITES.has(name)) throw new BatchError('invalid-op', index, `unknown operation \`${name}\``)
  return name
}

const str = (index: number, op: BatchOp, key: string): string => {
  const value = op[key]
  if (typeof value !== 'string') throw new BatchError('invalid-op', index, `\`${key}\` is a string`)
  return value
}

const whole = (index: number, op: BatchOp, key: string): number => {
  const value = op[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BatchError('invalid-op', index, `\`${key}\` is a whole number`)
  return value
}

function position(index: number, value: unknown, len: number): number {
  if (value === undefined || value === null || value === 'end') return len
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BatchError('invalid-op', index, '`at` is "end" or a whole number')
  return value
}

/** The UTF-16 offset of the scalar value at `scalar` in `text`; past the end stays past the end. */
function utf16(text: string, scalar: number): number {
  let units = 0
  let count = 0
  for (const char of text) {
    if (count === scalar) return units
    units += char.length
    count += 1
  }
  return units + (scalar - count)
}

/** Runs a batch request against `target`; answers `{ refs, results, loaded }`. */
export async function runBatch(target: BatchTarget, request: BatchRequest): Promise<BatchResult> {
  if (!isRecord(request)) throw new BatchError('invalid-op', null, 'a batch is an object')
  if (request.objects !== undefined && typeof request.objects !== 'boolean') throw new BatchError('invalid-op', null, '`objects` is a boolean')
  const origin = batchOrigin(request.origin)
  const list = (value: unknown, name: string): unknown[] => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw new BatchError('invalid-op', null, `\`${name}\` is an array`)
    return value
  }
  const ops = list(request.ops, 'ops') as BatchOp[]
  const loads = list(request.load, 'load')
  let writes = false
  ops.forEach((op, index) => {
    writes = WRITES.has(opName(index, op)) || writes
  })
  if (writes && target.readOnly?.()) throw new BatchError('read-only', null, 'the document is read-only')
  const schema = (await target.replica()).schema
  // Tool ids (rule OM9): objects are named as the kit's tools name them, read again before each run
  // of operations and after the last, since the kit numbers what a batch creates.
  const toolIds = hasToolIds(schema)
  const namesOf = async (): Promise<ToolIds> => (toolIds ? ToolIds.ofReplica(await target.replica()) : ToolIds.none())
  let refs: Refs = new Map()
  const results: unknown[] = ops.map(() => null)
  const projections = hasProjections(schema)
  const readProjections = async () => {
    if (!target.projectedObjects) throw new BatchError('invalid-value', null, 'this adapter cannot read declared projected objects')
    const objects = await target.projectedObjects()
    return new ProjectionView(await target.replica(), objects)
  }
  const projectedRoute = async (op: BatchOp) => {
    if (!projections || op.op === 'command') return undefined
    const view = await readProjections()
    const replica = await target.replica()
    const root = rootId(replica)
    return routeProjection(schema, view, root ? (await namesOf()).show(root) : '', resolveValues(op, refs) as BatchOp)
  }
  let index = 0
  while (index < ops.length) {
    const op = ops[index]
    const routed = await projectedRoute(op)
    if (routed) {
      if (routed.creates && op.ref !== undefined && (typeof op.ref !== 'string' || !op.ref.startsWith('$') || refs.has(op.ref))) throw new BatchError('invalid-op', index, 'a projected create ref starts with $ and is unique')
      let result: unknown
      try { result = await target.command(routed.command, routed.params, origin) } catch (error) { throw new BatchError('command-failed', index, String(error)) }
      if (routed.creates) {
        const id = typeof result === 'string' ? result : isRecord(result) ? result.id : undefined
        if (typeof id !== 'string') throw new BatchError('invalid-op', index, 'a projected create command must return its id')
        if ((await readProjections()).objects.get(id)?.type !== routed.creates) throw new BatchError('invalid-op', index, 'a projected create command returned no live object of its type')
        if (typeof op.ref === 'string') refs.set(op.ref, id)
      }
      results[index++] = result ?? null
      continue
    }
    if (op.op === 'command') {
      if (typeof op.id !== 'string') throw new BatchError('invalid-op', index, 'a command needs an `id`')
      let params: unknown = {}
      if (op.params !== undefined && toolIds && refs.size > 0) {
        // A command takes the kit's own ids: a bound reference becomes the object's tool id.
        const names = await namesOf()
        params = resolveValues(op.params, new Map([...refs].map(([name, id]) => [name, names.show(id)])))
      } else if (op.params !== undefined) params = resolveValues(op.params, refs)
      try {
        const at = op.at as { part?: unknown; time?: unknown } | undefined
        let contextRefs = refs
        if (toolIds && refs.size > 0) {
          const names = await namesOf()
          contextRefs = new Map([...refs].map(([name, id]) => [name, names.show(id)]))
        }
        const context = Object.fromEntries(Object.entries({ on: op.on, part: at?.part, time: at?.time }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, resolveValues(value, contextRefs)]))
        if (Object.keys(context).length > 0 && !target.commandAt) throw new Error('this batch adapter cannot apply explicit command context')
        results[index] = (await (target.commandAt ? target.commandAt(op.id, params, context, origin) : target.command(op.id, params, origin))) ?? null
        if (typeof op.ref === 'string') {
          const result=results[index]
          const id=typeof result==='string'?result:isRecord(result)&&typeof result.id==='string'?result.id:undefined
          if (!id) throw new Error('a bound command must return its object id')
          const replica=await target.replica()
          const resolved=ToolIds.ofReplica(replica).resolve(id, id=>replica.exists(id))
          if (typeof resolved !== 'string') throw new Error('a bound command returned no live object')
          refs.set(op.ref,resolved)
        }
      } catch (error) {
        throw new BatchError('command-failed', index, error instanceof Error ? error.message : String(error))
      }
      index += 1
      continue
    }
    const start = index
    while (index < ops.length && ops[index].op !== 'command' && !await projectedRoute(ops[index])) index += 1
    const end = index
    const names = await namesOf()
    let staged: Refs = refs
    let values: unknown[] = []
    await target.transact(origin, (tx) => {
      staged = new Map(refs)
      values = []
      let root: ObjectId | null | undefined
      const rootOf = () => (root === undefined ? (root = tx.objectsOfType(schema.root)[0] ?? null) : root)
      for (let at = start; at < end; at += 1) values.push(apply(tx, schema, names, at, ops[at], staged, rootOf))
    })
    refs = staged
    values.forEach((value, offset) => {
      results[start + offset] = value
    })
  }
  const names = await namesOf()
  const replica = await target.replica()
  const projected = projections ? await readProjections() : undefined
  const loaded = loads.map((entry, at) => {
    try {
      if (projected) {
        if (!isRecord(entry) || typeof entry.target !== 'string') throw new BatchError('invalid-op', null, '`target` is a string')
        return projected.load(rootId(replica) ? names.show(rootId(replica)!) : null, refs.get(entry.target) ?? entry.target, entry.fields)
      }
      return load(replica, names, entry, refs)
    } catch (error) {
      const failed = kdmError(null, error)
      throw new BatchError(failed.code, null, `load ${at}: ${failed.message}`)
    }
  })
  if (names.isActive()) {
    results.forEach((result, at) => { results[at] = names.showJson(result) })
  }
  const answer: BatchResult = { refs: Object.fromEntries([...refs].map(([name, id]) => [name, names.show(id)])), results, loaded }
  if (request.objects) answer.objects = [...Object.keys(schema.types).flatMap(type => replica.objectsOfType(type).map(id => ({id:names.show(id),type}))), ...[...projected?.objects.values() ?? []].map(object => ({id:object.id,type:object.type,projected:true,at:object.at}))].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
  return answer
}

/**
 * Refuses (`read-only`) a write to `id`, or to its `field`, that the schema keeps from the object
 * model (rule OM8). An unknown object or field is left to the operation, which reports it.
 */
/**
 * A `set` or text operation's field given as a path from its target, as the Rust
 * `held_path`: through owning fields (a ref or map declared `owns`, a list by index) to a field of
 * a held object without a tool id of its own, or the same in the kit's words (`pathName`); past a
 * `json` field, the rest is a path inside its value. Same refusals and messages.
 */
function heldPath(tx: Tx, schema: Schema, names: ToolIds, index: number, target: ObjectId, path: string): [ObjectId, string, string[]] {
  const refuse = (why: string) => new BatchError('invalid-op', index, `\`field\` \`${path}\`: ${why}`)
  let at = target
  let rest = path
  const first = path.split('.')[0]
  if (first.includes('/') || first.includes('#')) {
    let found: [ObjectId, number] | null = null
    const frontier: ObjectId[] = [target]
    const seen = new Set<ObjectId>()
    while (frontier.length > 0) {
      const object = frontier.pop() as ObjectId
      if (seen.has(object) || seen.size > 100_000) continue
      seen.add(object)
      const named = names.namedPath(object)
      if (named !== null && path.startsWith(named)) {
        const after = path.slice(named.length)
        if ((after === '' || after.startsWith('.')) && (found === null || named.length > found[1])) found = [object, named.length]
      }
      let ty: string
      try {
        ty = tx.objectType(object)
      } catch {
        continue
      }
      if (!Object.hasOwn(schema.types, ty)) continue
      for (const name of sortedKeys(schema.types[ty].fields)) {
        const def = schema.types[ty].fields[name]
        if (def.kind === 'list') frontier.push(...tx.listItems(object, name))
        else if (def.kind === 'ref' && def.owns === true) {
          const value = tx.get(object, name)
          if (typeof value === 'string' && value !== '') frontier.push(value)
        }
      }
    }
    if (found === null) throw refuse("no object the target holds has that name in the kit's words")
    at = found[0]
    rest = path.slice(found[1]).replace(/^\.+/, '')
  }
  const segments = rest.split('.')
  let position = 0
  while (position < segments.length) {
    const name = segments[position]
    const ty = tx.objectType(at)
    if (!Object.hasOwn(schema.types, ty) || !Object.hasOwn(schema.types[ty].fields, name)) throw refuse(`\`${ty}\` has no field \`${name}\``)
    const def = schema.types[ty].fields[name]
    if (position + 1 === segments.length || !['ref', 'list', 'map', 'tree'].includes(def.kind)) {
      const inner = segments.slice(position + 1)
      if (inner.length > 0 && def.kind !== 'json') throw refuse(`\`${ty}.${name}\` is no json value to go into`)
      return [at, name, inner]
    }
    let next: ObjectId | null = null
    if (def.kind === 'ref' && def.owns === true) {
      const value = tx.get(at, name)
      next = typeof value === 'string' && value !== '' ? value : null
    } else if (def.kind === 'list') {
      position += 1
      const segment = segments[position]
      if (segment === undefined || !/^\d+$/.test(segment)) throw refuse(`\`${name}\` is a list: give an index after it`)
      const item = Number(segment)
      const items = tx.listItems(at, name)
      if (item >= items.length) throw refuse(`\`${name}\` has ${items.length} items, not ${item + 1}`)
      next = items[item]
    } else if (def.kind === 'map' && def.owns === true) {
      position += 1
      const key = segments[position]
      if (key === undefined) throw refuse(`\`${name}\` is a map: give a key after it`)
      const value = tx.mapGet(at, name, key)
      next = typeof value === 'string' && value !== '' ? value : null
    } else if (def.kind === 'ref' || def.kind === 'map') {
      throw refuse(`\`${ty}.${name}\` does not own what it names: a path goes through owning fields only`)
    } else throw refuse(`\`${ty}.${name}\` is a tree: a path does not go through trees`)
    if (next === null) throw refuse(`\`${ty}.${name}\` holds nothing there`)
    if (names.toolId(next) !== null) throw refuse(`it reaches \`${names.show(next)}\`, which has a tool id of its own: target it by that id`)
    at = next
    position += 1
  }
  throw refuse('it names no field')
}

/** `value` with `inner` (object members and array indexes) set to `next`, as the Rust `set_inside`. */
function setInside(value: unknown, inner: string[], next: unknown): unknown {
  if (inner.length === 0) return next
  const copy: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value))
  const root: unknown = copy
  let at = root as Record<string, unknown> | unknown[]
  for (const [i, key] of inner.entries()) {
    const last = i === inner.length - 1
    if (Array.isArray(at) && /^\d+$/.test(key)) {
      const index = Number(key)
      if (index >= at.length) throw new Error(last ? `no item ${index}` : `no item ${index} at \`${key}\``)
      if (last) at[index] = next
      else at = at[index] as Record<string, unknown> | unknown[]
    } else {
      if (at === null || typeof at !== 'object' || Array.isArray(at)) throw new Error(`\`${key}\` is in no object`)
      const record = at as Record<string, unknown>
      if (last) record[key] = next
      else {
        if (!Object.hasOwn(record, key)) record[key] = null
        at = record[key] as Record<string, unknown> | unknown[]
      }
    }
  }
  return root
}

function guard(tx: Tx, schema: Schema, names: ToolIds, index: number, id: ObjectId, field: string | null): void {
  let ty: string
  try {
    ty = tx.objectType(id)
  } catch {
    return
  }
  if (!Object.hasOwn(schema.types, ty)) return
  const def = schema.types[ty]
  const read = (name: string): unknown => {
    try {
      return tx.get(id, name)
    } catch {
      return undefined
    }
  }
  if (objectReadOnly(def, read)) throw new BatchError('read-only', index, `\`${names.show(id)}\` is a read-only \`${ty}\`: the kit keeps it as it is`)
  if (field !== null && Object.hasOwn(def.fields, field) && def.fields[field].readOnly) {
    throw new BatchError('read-only', index, `\`${ty}.${field}\` is read-only: the kit keeps it as it is`)
  }
}

/** Refuses a read-only object type or discriminator; immutable registers may be initialized at creation (OM8). */
function guardNew(schema: Schema, index: number, ty: string, fields: Record<string, unknown>): void {
  if (!Object.hasOwn(schema.types, ty)) return
  const def = schema.types[ty]
  if (objectReadOnly(def, (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined))) {
    throw new BatchError('read-only', index, `a new \`${ty}\` would be read-only: only the kit makes one`)
  }
}

/**
 * As the Rust `check_refs`: refuses (`not-found`) a reference field of a `ty` given the id of no
 * object. A reference may still dangle later, when its object is deleted (M4a).
 */
function checkRefs(tx: Tx, schema: Schema, index: number, ty: string, fields: Array<[string, unknown]>): void {
  if (!Object.hasOwn(schema.types, ty)) return
  const def = schema.types[ty]
  for (const [name, value] of fields) {
    if (!Object.hasOwn(def.fields, name) || typeof value !== 'string') continue
    const field = def.fields[name]
    if (!(field.kind === 'ref' || (field.kind === 'map' && field.of !== undefined)) || tx.exists(value)) continue
    const of = field.of ?? 'object'
    throw new BatchError(
      'not-found',
      index,
      `\`${ty}.${name}\` holds the id of a \`${of}\`, and no object has the id \`${value}\`: give the id of an existing \`${of}\` (a load or query answers them), or create one earlier in the batch and use its \`$name\``,
    )
  }
}

function apply(tx: Tx, schema: Schema, names: ToolIds, index: number, op: BatchOp, refs: Refs, root: () => ObjectId | null): unknown {
  const name = opName(index, op)
  const exists = (id: ObjectId) => tx.exists(id) || (name === 'delete' && tx.wasDeleted(id))
  const target = (key: string) => targetId(op[key], refs, names, exists, root, index)
  const containerField = (id: ObjectId, path: string): [ObjectId, string] => {
    const [held, field, inner] = heldPath(tx, schema, names, index, id, path)
    if (inner.length) throw new BatchError('invalid-op', index, 'a container operation requires a container field, not a JSON member')
    return [held, field]
  }
  const textField = (id: ObjectId, path: string): [ObjectId, string] => {
    if (!path.includes('.') && !path.includes('/')) return [id, path]
    const [held, field, inner] = heldPath(tx, schema, names, index, id, path)
    if (inner.length) throw new BatchError('invalid-op', index, `\`field\` \`${path}\`: \`${name}\` ${name === 'text.set' ? 'replaces' : 'edits'} a text field, not a path inside a value`)
    return [held, field]
  }
  try {
    switch (name) {
      case 'create': {
        const ty = str(index, op, 'type')
        if (op.fields !== undefined && op.fields !== null && !isRecord(op.fields)) throw new BatchError('invalid-op', index, '`fields` is an object')
        const resolved = (resolveValues(op.fields ?? {}, refs) ?? {}) as Record<string, unknown>
        const fields: Record<string, unknown> = {}
        for (const key of sortedKeys(resolved)) fields[key] = refValue(tx, schema, names, index, ty, key, resolved[key])
        const reference = op.ref
        if (reference !== undefined && reference !== null && !(typeof reference === 'string' && reference.length > 1 && reference.startsWith('$'))) {
          throw new BatchError('invalid-op', index, '`ref` is a name starting with `$`')
        }
        let container: [ObjectId, string] | null = null
        if (op.in !== undefined && op.in !== null) {
          const path = op.in
          const dot = typeof path === 'string' ? path.indexOf('.') : -1
          if (typeof path !== 'string' || dot < 0) throw new BatchError('invalid-op', index, '`in` is "<target>.<field>"')
          container = containerField(targetId(path.slice(0, dot), refs, names, exists, root, index), path.slice(dot + 1))
        }
        if (op.id !== undefined && op.id !== null && typeof op.id !== 'string') throw new BatchError('invalid-op', index, '`id` is a string')
        guardNew(schema, index, ty, fields)
        checkRefs(tx, schema, index, ty, sortedKeys(fields).map((key): [string, unknown] => [key, fields[key]]))
        const id = tx.create(ty, fields, typeof op.id === 'string' ? { id: op.id } : undefined)
        if (container) {
          const [owner, field] = container
          const ownerType = tx.objectType(owner)
          const kind = fieldDef(schema, ownerType, field).kind
          guard(tx, schema, names, index, owner, field)
          if (kind === 'list') tx.listInsert(owner, field, position(index, op.at, tx.listItems(owner, field).length), id)
          else if (kind === 'tree') {
            if (op.at !== undefined && op.at !== null && op.at !== 'end') throw new BatchError('invalid-op', index, '`at` places items in lists; a tree adds a node last among its siblings')
            tx.treeCreate(owner, field, treeParent(tx, refs, names, root, index, op, owner, field), id)
          } else throw new BatchError('invalid-op', index, `\`${ownerType}.${field}\` is not a list or a tree; create objects in lists and trees`)
        } else if (op.parent !== undefined && op.parent !== null) throw new BatchError('invalid-op', index, '`parent` places an object in a tree: give `in` too')
        if (typeof reference === 'string') refs.set(reference, id)
        return id
      }
      case 'set': {
        let id = target('target')
        let field = str(index, op, 'field')
        let given = op.value === undefined ? null : resolveValues(op.value, refs)
        // A path to a field of a held object.
        if (field.includes('.') || field.includes('/')) {
          const path = field
          const [held, name, inner] = heldPath(tx, schema, names, index, id, path)
          if (inner.length > 0) {
            let whole: unknown = null
            try {
              whole = tx.get(held, name)
            } catch {
              whole = null
            }
            try {
              given = setInside(whole, inner, given)
            } catch (error) {
              throw new BatchError('invalid-op', index, `\`field\` \`${path}\`: ${(error as Error).message}`)
            }
          }
          id = held
          field = name
        }
        let value = given
        try {
          value = refValue(tx, schema, names, index, tx.objectType(id), field, given)
        } catch (error) {
          if (error instanceof BatchError) throw error
        }
        guard(tx, schema, names, index, id, field)
        // A value that would make the object read-only is the kit's to write.
        let ty: string | null = null
        try {
          ty = tx.objectType(id)
        } catch {
          ty = null
        }
        if (ty !== null && Object.hasOwn(schema.types, ty)) {
          const def = schema.types[ty]
          const read = (name: string): unknown => {
            if (name === field) return value
            try {
              return tx.get(id, name)
            } catch {
              return undefined
            }
          }
          if (def.readOnlyWhen?.field === field && objectReadOnly(def, read)) {
            throw new BatchError('read-only', index, `\`${ty}.${field}\` would make \`${names.show(id)}\` read-only: only the kit does`)
          }
        }
        if (ty !== null) checkRefs(tx, schema, index, ty, [[field, value]])
        tx.set(id, field, value)
        return null
      }
      case 'delete': {
        const id = target('target')
        if (!tx.exists(id) && !tx.wasDeleted(id)) throw new BatchError('not-found', index, `object \`${id}\` not found`)
        const pending: Array<[ObjectId, boolean]> = [[id, false]]
        const seen = new Set<ObjectId>()
        const order: ObjectId[] = []
        while (pending.length) {
          const [id, visited] = pending.pop()!
          if (visited) { order.push(id); continue }
          if (!tx.exists(id) || seen.has(id)) continue
          seen.add(id)
          pending.push([id, true])
          for (const ownerType of sortedKeys(schema.types)) {
            for (const [field, fieldOf] of Object.entries(typeDef(schema, ownerType).fields)) {
              if (!fieldOf.cascade) continue
              for (const owner of tx.objectsOfType(ownerType)) {
                const entries = tx.tree(owner, field)
                const mine = entries.filter((entry) => entry.object === id).map((entry) => entry.node)
                pending.push(...entries.filter((entry) => entry.parent !== null && mine.some((node) => node.equals(entry.parent!))).map((entry): [ObjectId, boolean] => [entry.object, false]))
              }
            }
          }
          const def = typeDef(schema, tx.objectType(id))
          for (const field of sortedKeys(def.fields)) {
            const fieldOf = def.fields[field]
            if (!owning(fieldOf)) continue
            let held: ObjectId[] = []
            switch (fieldOf.kind) {
              case 'list': held = tx.listItems(id, field); break
              case 'tree': held = tx.tree(id, field).map((entry) => entry.object); break
              case 'ref': { const value = tx.get(id, field); if (typeof value === 'string') held = [value]; break }
              case 'map': held = mapHeld(Object.fromEntries(tx.mapEntries(id, field)), (id) => tx.exists(id)).map(([id]) => id); break
            }
            pending.push(...held.map((id): [ObjectId, boolean] => [id, false]))
          }
        }
        for (const id of order) {
        const ty = tx.objectType(id)
        guard(tx, schema, names, index, id, null)
        // Drop the object from every list holding it, so no list keeps a dangling entry.
        for (const ownerType of sortedKeys(schema.types)) {
          const def = typeDef(schema, ownerType)
          for (const field of sortedKeys(def.fields)) {
            const fieldOf = def.fields[field]
            if (fieldOf.kind !== 'list' || fieldOf.of !== ty) continue
            for (const owner of tx.objectsOfType(ownerType)) {
              const items = tx.listItems(owner, field)
              if (items.includes(id)) guard(tx, schema, names, index, owner, field)
              for (let at = items.length - 1; at >= 0; at -= 1) if (items[at] === id) tx.listRemove(owner, field, at)
            }
          }
        }
        // A tree keeps the node of a deleted object (readers skip it), but not over live children.
        for (const ownerType of sortedKeys(schema.types)) {
          const def = typeDef(schema, ownerType)
          for (const field of sortedKeys(def.fields)) {
            const fieldOf = def.fields[field]
            if (fieldOf.kind !== 'tree' || (fieldOf.of !== undefined && fieldOf.of !== ty)) continue
            for (const owner of tx.objectsOfType(ownerType)) {
              const entries = tx.tree(owner, field)
              const mine = entries.filter((entry) => entry.object === id).map((entry) => entry.node)
              if (mine.length) guard(tx, schema, names, index, owner, field)
              if (entries.some((entry) => entry.parent !== null && mine.some((node) => node.equals(entry.parent!)) && tx.exists(entry.object))) {
                throw new BatchError('invalid-value', index, `\`${names.show(id)}\` has children in \`${names.show(owner)}.${field}\`: delete them child-first or move them, before deleting this node in the same batch`)
              }
            }
          }
        }
        tx.delete(id)
        }
        return null
      }
      case 'tree.insert': {
        const [id, field] = containerField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        const item = target('item')
        if (liveNode(tx, id, field, item)) throw new BatchError('invalid-value', index, `\`${names.show(item)}\` is already in \`${names.show(id)}.${field}\`: move it with tree.move`)
        tx.treeCreate(id, field, treeParent(tx, refs, names, root, index, op, id, field), item)
        return null
      }
      case 'tree.move': {
        const [id, field] = containerField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        const item = target('item')
        const node = liveNode(tx, id, field, item)
        if (!node) throw new BatchError('not-found', index, `\`${names.show(item)}\` is not in \`${names.show(id)}.${field}\``)
        tx.treeMove(id, field, node, treeParent(tx, refs, names, root, index, op, id, field))
        return null
      }
      case 'text.insert': {
        const [id, field] = textField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        tx.textInsert(id, field, utf16(tx.text(id, field), whole(index, op, 'index')), str(index, op, 'text'))
        return null
      }
      case 'text.delete': {
        const [id, field] = textField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        const text = tx.text(id, field)
        const from = whole(index, op, 'index')
        const start = utf16(text, from)
        tx.textDelete(id, field, start, utf16(text, from + whole(index, op, 'count')) - start)
        return null
      }
      case 'text.set': {
        const [id, field] = textField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        const text = str(index, op, 'text')
        const len = tx.textLength(id, field)
        if (len > 0) tx.textDelete(id, field, 0, len)
        if (text !== '') tx.textInsert(id, field, 0, text)
        return null
      }
      case 'text.mark':
      case 'text.unmark': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, names, index, id, field)
        const text = tx.text(id, field)
        const start = utf16(text, whole(index, op, 'start'))
        const end = utf16(text, whole(index, op, 'end'))
        if (name === 'text.mark') tx.textMark(id, field, start, end, str(index, op, 'key'), op.value ?? null)
        else tx.textUnmark(id, field, start, end, str(index, op, 'key'))
        return null
      }
      case 'list.insert': {
        const [id, field] = containerField(target('target'), str(index, op, 'field'))
        guard(tx, schema, names, index, id, field)
        tx.listInsert(id, field, position(index, op.index, tx.listItems(id, field).length), target('item'))
        return null
      }
      case 'list.move':
      case 'list.remove':
      case 'map.set':
      case 'map.delete': {
        const [id, field] = name.startsWith('list.') ? containerField(target('target'), str(index, op, 'field')) : [target('target'), str(index, op, 'field')]
        guard(tx, schema, names, index, id, field)
        if (name === 'list.move') {
          const from = whole(index, op, 'from')
          const to = whole(index, op, 'to')
          tx.listMove(id, field, from, to > from ? to - 1 : to)
        }
        else if (name === 'list.remove') tx.listRemove(id, field, whole(index, op, 'index'))
        else if (name === 'map.set') {
          const ty = tx.objectType(id)
          const value = refValue(tx, schema, names, index, ty, field, op.value === undefined ? null : resolveValues(op.value, refs))
          checkRefs(tx, schema, index, ty, [[field, value]])
          tx.mapSet(id, field, str(index, op, 'key'), value)
        }
        else tx.mapDelete(id, field, str(index, op, 'key'))
        return null
      }
      default:
        throw new BatchError('invalid-op', index, `\`${name}\` is not a model operation`)
    }
  } catch (error) {
    throw kdmError(index, error)
  }
}

/** The node of a tree field naming `object`, when `object` exists (the node of a deleted object is skipped, as readers skip it). */
function liveNode(tx: Tx, id: ObjectId, field: string, object: ObjectId): NodeRef | null {
  if (!tx.exists(object)) return null
  return tx.tree(id, field).find((entry) => entry.object === object)?.node ?? null
}

/** The node an operation's `parent` names in a tree (`null`: absent or `null`, a root). */
function treeParent(tx: Tx, refs: Refs, names: ToolIds, root: () => ObjectId | null, index: number, op: BatchOp, id: ObjectId, field: string): NodeRef | null {
  if (op.parent === undefined || op.parent === null) return null
  if (typeof op.parent !== 'string') throw new BatchError('invalid-op', index, '`parent` is an object or null')
  const parent = targetId(op.parent, refs, names, (object) => tx.exists(object), root, index)
  const node = liveNode(tx, id, field, parent)
  if (!node) throw new BatchError('not-found', index, `the parent \`${names.show(parent)}\` is not in \`${names.show(id)}.${field}\``)
  return node
}

function load(replica: Replica, names: ToolIds, entry: unknown, refs: Refs): LoadedObject {
  if (!isRecord(entry) || typeof entry.target !== 'string') throw new BatchError('invalid-op', null, '`target` is a string')
  const id = targetId(entry.target, refs, names, (object) => replica.exists(object), () => rootId(replica), null)
  const ty = replica.objectType(id)
  const def = typeDef(replica.schema, ty)
  let wanted: string[]
  if (entry.fields === undefined || entry.fields === null) wanted = sortedKeys(def.fields)
  else if (Array.isArray(entry.fields) && entry.fields.every((name) => typeof name === 'string')) wanted = entry.fields as string[]
  else throw new BatchError('invalid-op', null, '`fields` lists names')
  const fields: Record<string, unknown> = {}
  // Every field the schema declares is in `fields`, one named `id` or `type` too (a tool id's
  // field may be named `id`): the answer's own `id` and `type` are members beside `fields`.
  for (const name of wanted) {
    const kind: FieldKind = Object.hasOwn(def.fields, name) ? def.fields[name].kind : 'json'
    fields[name] = showIds(names, kind, readField(replica, id, ty, name))
  }
  return { id: names.show(id), type: ty, fields }
}

/** One field as `load` answers it. */
export function readField(replica: Replica, id: ObjectId, ty: string, name: string): unknown {
  const def = fieldDef(replica.schema, ty, name)
  switch (def.kind) {
    case 'text':
      return hasMarks(def) ? replica.textDelta(id, name) : replica.text(id, name)
    case 'list':
      return replica.list(id, name)
    case 'map':
      return Object.fromEntries(replica.mapEntries(id, name))
    case 'tree': {
      // The nodes of deleted objects are skipped with their subtrees, as kits read them.
      const entries: TreeEntry[] = []
      for (const entry of replica.tree(id, name)) {
        const parentKept = entry.parent === null || entries.some((kept) => kept.node.equals(entry.parent!))
        if (parentKept && replica.exists(entry.object)) entries.push(entry)
      }
      return entries.map((entry) => ({ object: entry.object, parent: entries.find((other) => entry.parent !== null && other.node.equals(entry.parent))?.object ?? null }))
    }
    default:
      return replica.get(id, name)
  }
}

/** The schema as `model/describe` answers it, without the commands (the kit adds them). */
export function describeModel(replica: Replica) {
  const schema = replica.schema
  type Described = { fields: Record<string, Record<string, unknown>>; projected?: true; projectedOps?: TypeDef['projectedOps']; batchOps?: TypeDef['batchOps']; creation?: TypeDef['creation']; readOnly?: true; batchIndependent?: true; moveConsequences?: string[]; structuralConsequences?: TypeDef['structuralConsequences']; readOnlyWhen?: { field: string; values: string[] }; toolId?: { field: string; prefix: string; parent?: string }; pathName?: string; label?: string; text?: string; derived?: Record<string, { description?: string; premiseOnly?: boolean; onDemand?: boolean }> }
  const types: Record<string, Described> = {}
  for (const ty of sortedKeys(schema.types)) {
    const fields: Record<string, Record<string, unknown>> = {}
    for (const [name, field] of Object.entries(schema.types[ty].fields)) {
      const out: Record<string, unknown> = { kind: field.kind }
      if (field.label !== undefined) out.label = field.label
      for (const key of ['minimum', 'maximum', 'multipleOf'] as const) if (field[key] !== undefined) out[key] = field[key]
      if (field.members !== undefined && Object.keys(field.members).length > 0) out.members = field.members
      if (field.of !== undefined) out.of = field.of
      if (field.values?.length) out.values = field.values
      if (field.optional) out.optional = true
      if (field.marks && Object.keys(field.marks).length > 0) out.marks = sortedKeys(field.marks)
      if (field.readOnly) out.readOnly = true
      if (field.owns) out.owns = true
      if (field.cascade) out.cascade = true
      if (field.position) out.position = true
      if (field.display !== undefined) out.display = { ...field.display }
      if (field.sample !== undefined) out.sample = field.sample
      fields[name] = out
    }
    const def = schema.types[ty]
    const out: Described = { fields }
    if (def.projected) out.projected = true
    if (def.projectedOps && Object.keys(def.projectedOps).length) out.projectedOps = structuredClone(def.projectedOps)
    if (def.readOnly) out.readOnly = true
    if (def.readOnlyWhen) out.readOnlyWhen = { field: def.readOnlyWhen.field, values: [...def.readOnlyWhen.values] }
    if (def.toolId) out.toolId = { field: def.toolId.field, prefix: def.toolId.prefix, ...(def.toolId.parent === undefined ? {} : { parent: def.toolId.parent }) }
    if (def.pathName !== undefined) out.pathName = def.pathName
    if (def.label !== undefined) out.label = def.label
    if (def.derived) out.derived = Object.fromEntries(sortedKeys(def.derived).map((name) => [name, { ...def.derived![name] }]))
    if (def.text) out.text = def.text
    if (def.batchOps) Object.assign(out, { batchOps: structuredClone(def.batchOps) })
    if (def.creation) Object.assign(out, { creation: structuredClone(def.creation) })
    if (def.batchIndependent) out.batchIndependent = true
    if (def.moveConsequences?.length) out.moveConsequences = [...def.moveConsequences]
    if (def.structuralConsequences?.length) out.structuralConsequences = def.structuralConsequences.map(rule => ({ container: rule.container, on: [...rule.on], fields: [...rule.fields] }))
    types[ty] = out
  }
  const root = rootId(replica)
  const shown = root !== null && hasToolIds(schema) ? ToolIds.ofReplica(replica).show(root) : root
  return { capability: OBJECT_MODEL_CAPABILITY, kit: schema.kit, schemaVersion: schema.schemaVersion, root: schema.root, rootId: shown, types }
}

/**
 * The schema a kit's `model/describe` answer describes (Rust's `kition_kits::drafts::schema_of`),
 * for a reader that has no other. The description names a text field's marks by key (OM1), not
 * their definitions (M4c): each expands after here, which only editing a marked text reads.
 */
export function schemaOfDescription(description: object): Schema {
  const described = description as Record<string, unknown>
  for (const name of ['kit', 'schemaVersion', 'root', 'types']) {
    if (described[name] === undefined) throw errors.schema(`the kit's description has no \`${name}\``)
  }
  const types: Record<string, unknown> = {}
  for (const [ty, def] of Object.entries(described.types as Record<string, { fields?: Record<string, Record<string, unknown>> }>)) {
    const fields: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(def.fields ?? {})) {
      fields[name] = Array.isArray(field.marks) ? { ...field, marks: Object.fromEntries(field.marks.map((mark) => [mark, { expand: 'after' }])) } : field
    }
    types[ty] = { ...def, fields }
  }
  return parseSchema({ kdm: KDM_VERSION, kit: described.kit, schemaVersion: described.schemaVersion, root: described.root, types })
}
