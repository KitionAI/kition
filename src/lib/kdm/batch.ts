// Copied from kition-sdk packages/kdm/src/batch.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Object-model batches (`KitObjectModel 1.0`, Kit Standard `spec/sets/object-model.md`): the twin of the Rust
 * crate's `batch` module, run on the same fixtures (`crates/kition-kdm/tests/fixtures/batch.json`).
 *
 * A batch is `{ origin?, ops, load? }`. Runs of model operations become one transaction each;
 * `command` operations go to the kit between them (`BatchTarget.command`). `$` references bind the
 * ids of objects the batch creates; a string equal to a bound reference, anywhere in an
 * operation's values or a command's parameters, becomes its id. Text positions count Unicode
 * scalar values (rule M18), converted here to the UTF-16 units of this implementation's `Tx`.
 */
import { KdmError } from './errors'
import type { NodeRef, ObjectId } from './ids'
import { checkOrigin, type Origin } from './origin'
import type { TreeEntry } from './ids'
import type { Replica } from './replica'
import { fieldDef, hasMarks, objectReadOnly, sortedKeys, typeDef, type Schema } from './schema'
import type { Tx } from './tx'

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
export type BatchRequest = { origin?: Origin | null; ops?: BatchOp[]; load?: BatchLoad[] }
export type LoadedObject = { id: string; type: string; fields: Record<string, unknown> }
export type BatchResult = { refs: Record<string, string>; results: unknown[]; loaded: LoadedObject[] }

/** What a batch runs against: a replica that takes transactions, and a kit that runs commands. */
export interface BatchTarget {
  /** The replica reads come from, current with the document. */
  replica(): Replica | Promise<Replica>
  /** Runs `write` as one transaction with `origin`; nothing changes when it throws. */
  transact(origin: Origin, write: (tx: Tx) => void): void | Promise<void>
  /** Runs a kit command as `origin`; answers its result. */
  command(id: string, params: unknown, origin: Origin): unknown | Promise<unknown>
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

function targetId(text: unknown, refs: Refs, root: () => ObjectId | null, index: number | null): ObjectId {
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
  return text
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
  let refs: Refs = new Map()
  const results: unknown[] = ops.map(() => null)
  let index = 0
  while (index < ops.length) {
    const op = ops[index]
    if (op.op === 'command') {
      if (typeof op.id !== 'string') throw new BatchError('invalid-op', index, 'a command needs an `id`')
      const params = op.params === undefined ? {} : resolveValues(op.params, refs)
      try {
        results[index] = (await target.command(op.id, params, origin)) ?? null
      } catch (error) {
        throw new BatchError('command-failed', index, error instanceof Error ? error.message : String(error))
      }
      index += 1
      continue
    }
    const start = index
    while (index < ops.length && ops[index].op !== 'command') index += 1
    const end = index
    let staged: Refs = refs
    let values: unknown[] = []
    await target.transact(origin, (tx) => {
      staged = new Map(refs)
      values = []
      let root: ObjectId | null | undefined
      const rootOf = () => (root === undefined ? (root = tx.objectsOfType(schema.root)[0] ?? null) : root)
      for (let at = start; at < end; at += 1) values.push(apply(tx, schema, at, ops[at], staged, rootOf))
    })
    refs = staged
    values.forEach((value, offset) => {
      results[start + offset] = value
    })
  }
  const replica = await target.replica()
  const loaded = loads.map((entry, at) => {
    try {
      return load(replica, entry, refs)
    } catch (error) {
      const failed = kdmError(null, error)
      throw new BatchError(failed.code, null, `load ${at}: ${failed.message}`)
    }
  })
  return { refs: Object.fromEntries(refs), results, loaded }
}

/**
 * Refuses (`read-only`) a write to `id`, or to its `field`, that the schema keeps from the object
 * model (rule OM8). An unknown object or field is left to the operation, which reports it.
 */
function guard(tx: Tx, schema: Schema, index: number, id: ObjectId, field: string | null): void {
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
  if (objectReadOnly(def, read)) throw new BatchError('read-only', index, `\`${id}\` is a read-only \`${ty}\`: the kit keeps it as it is`)
  if (field !== null && Object.hasOwn(def.fields, field) && def.fields[field].readOnly) {
    throw new BatchError('read-only', index, `\`${ty}.${field}\` is read-only: the kit keeps it as it is`)
  }
}

/** Refuses (`read-only`) a new object of type `ty` that would be read-only, or that gives a read-only field a value (rule OM8). */
function guardNew(schema: Schema, index: number, ty: string, fields: Record<string, unknown>): void {
  if (!Object.hasOwn(schema.types, ty)) return
  const def = schema.types[ty]
  if (objectReadOnly(def, (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined))) {
    throw new BatchError('read-only', index, `a new \`${ty}\` would be read-only: only the kit makes one`)
  }
  const name = sortedKeys(fields).find((name) => fields[name] !== null && fields[name] !== undefined && Object.hasOwn(def.fields, name) && def.fields[name].readOnly)
  if (name !== undefined) throw new BatchError('read-only', index, `\`${ty}.${name}\` is read-only: the kit keeps it as it is`)
}

function apply(tx: Tx, schema: Schema, index: number, op: BatchOp, refs: Refs, root: () => ObjectId | null): unknown {
  const name = opName(index, op)
  const target = (key: string) => targetId(op[key], refs, root, index)
  try {
    switch (name) {
      case 'create': {
        const ty = str(index, op, 'type')
        if (op.fields !== undefined && op.fields !== null && !isRecord(op.fields)) throw new BatchError('invalid-op', index, '`fields` is an object')
        const fields = (resolveValues(op.fields ?? {}, refs) ?? {}) as Record<string, unknown>
        const reference = op.ref
        if (reference !== undefined && reference !== null && !(typeof reference === 'string' && reference.length > 1 && reference.startsWith('$'))) {
          throw new BatchError('invalid-op', index, '`ref` is a name starting with `$`')
        }
        let container: [ObjectId, string] | null = null
        if (op.in !== undefined && op.in !== null) {
          const path = op.in
          const dot = typeof path === 'string' ? path.lastIndexOf('.') : -1
          if (typeof path !== 'string' || dot < 0) throw new BatchError('invalid-op', index, '`in` is "<target>.<field>"')
          container = [targetId(path.slice(0, dot), refs, root, index), path.slice(dot + 1)]
        }
        if (op.id !== undefined && op.id !== null && typeof op.id !== 'string') throw new BatchError('invalid-op', index, '`id` is a string')
        guardNew(schema, index, ty, fields)
        const id = tx.create(ty, fields, typeof op.id === 'string' ? { id: op.id } : undefined)
        if (container) {
          const [owner, field] = container
          const ownerType = tx.objectType(owner)
          const kind = fieldDef(schema, ownerType, field).kind
          guard(tx, schema, index, owner, field)
          if (kind === 'list') tx.listInsert(owner, field, position(index, op.at, tx.listItems(owner, field).length), id)
          else if (kind === 'tree') {
            if (op.at !== undefined && op.at !== null && op.at !== 'end') throw new BatchError('invalid-op', index, '`at` places items in lists; a tree adds a node last among its siblings')
            tx.treeCreate(owner, field, treeParent(tx, refs, root, index, op, owner, field), id)
          } else throw new BatchError('invalid-op', index, `\`${ownerType}.${field}\` is not a list or a tree; create objects in lists and trees`)
        } else if (op.parent !== undefined && op.parent !== null) throw new BatchError('invalid-op', index, '`parent` places an object in a tree: give `in` too')
        if (typeof reference === 'string') refs.set(reference, id)
        return id
      }
      case 'set': {
        const id = target('target')
        const field = str(index, op, 'field')
        const value = op.value === undefined ? null : resolveValues(op.value, refs)
        guard(tx, schema, index, id, field)
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
            throw new BatchError('read-only', index, `\`${ty}.${field}\` would make \`${id}\` read-only: only the kit does`)
          }
        }
        tx.set(id, field, value)
        return null
      }
      case 'delete': {
        const id = target('target')
        const ty = tx.objectType(id)
        guard(tx, schema, index, id, null)
        // Drop the object from every list holding it, so no list keeps a dangling entry.
        for (const ownerType of sortedKeys(schema.types)) {
          const def = typeDef(schema, ownerType)
          for (const field of sortedKeys(def.fields)) {
            const fieldOf = def.fields[field]
            if (fieldOf.kind !== 'list' || fieldOf.of !== ty) continue
            for (const owner of tx.objectsOfType(ownerType)) {
              const items = tx.listItems(owner, field)
              if (items.includes(id)) guard(tx, schema, index, owner, field)
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
              if (entries.some((entry) => entry.parent !== null && mine.some((node) => node.equals(entry.parent!)) && tx.exists(entry.object))) {
                throw new BatchError('invalid-value', index, `\`${id}\` has children in \`${owner}.${field}\`: delete or move them first`)
              }
            }
          }
        }
        tx.delete(id)
        return null
      }
      case 'tree.insert': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        const item = target('item')
        if (liveNode(tx, id, field, item)) throw new BatchError('invalid-value', index, `\`${item}\` is already in \`${id}.${field}\`: move it with tree.move`)
        tx.treeCreate(id, field, treeParent(tx, refs, root, index, op, id, field), item)
        return null
      }
      case 'tree.move': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        const item = target('item')
        const node = liveNode(tx, id, field, item)
        if (!node) throw new BatchError('not-found', index, `\`${item}\` is not in \`${id}.${field}\``)
        tx.treeMove(id, field, node, treeParent(tx, refs, root, index, op, id, field))
        return null
      }
      case 'text.insert': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        tx.textInsert(id, field, utf16(tx.text(id, field), whole(index, op, 'index')), str(index, op, 'text'))
        return null
      }
      case 'text.delete': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        const text = tx.text(id, field)
        const from = whole(index, op, 'index')
        const start = utf16(text, from)
        tx.textDelete(id, field, start, utf16(text, from + whole(index, op, 'count')) - start)
        return null
      }
      case 'text.set': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
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
        guard(tx, schema, index, id, field)
        const text = tx.text(id, field)
        const start = utf16(text, whole(index, op, 'start'))
        const end = utf16(text, whole(index, op, 'end'))
        if (name === 'text.mark') tx.textMark(id, field, start, end, str(index, op, 'key'), op.value ?? null)
        else tx.textUnmark(id, field, start, end, str(index, op, 'key'))
        return null
      }
      case 'list.insert': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        tx.listInsert(id, field, position(index, op.index, tx.listItems(id, field).length), target('item'))
        return null
      }
      case 'list.move':
      case 'list.remove':
      case 'map.set':
      case 'map.delete': {
        const id = target('target')
        const field = str(index, op, 'field')
        guard(tx, schema, index, id, field)
        if (name === 'list.move') tx.listMove(id, field, whole(index, op, 'from'), whole(index, op, 'to'))
        else if (name === 'list.remove') tx.listRemove(id, field, whole(index, op, 'index'))
        else if (name === 'map.set') tx.mapSet(id, field, str(index, op, 'key'), op.value === undefined ? null : resolveValues(op.value, refs))
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
function treeParent(tx: Tx, refs: Refs, root: () => ObjectId | null, index: number, op: BatchOp, id: ObjectId, field: string): NodeRef | null {
  if (op.parent === undefined || op.parent === null) return null
  if (typeof op.parent !== 'string') throw new BatchError('invalid-op', index, '`parent` is an object or null')
  const parent = targetId(op.parent, refs, root, index)
  const node = liveNode(tx, id, field, parent)
  if (!node) throw new BatchError('not-found', index, `the parent \`${parent}\` is not in \`${id}.${field}\``)
  return node
}

function load(replica: Replica, entry: unknown, refs: Refs): LoadedObject {
  if (!isRecord(entry) || typeof entry.target !== 'string') throw new BatchError('invalid-op', null, '`target` is a string')
  const id = targetId(entry.target, refs, () => rootId(replica), null)
  const ty = replica.objectType(id)
  const def = typeDef(replica.schema, ty)
  let names: string[]
  if (entry.fields === undefined || entry.fields === null) names = sortedKeys(def.fields)
  else if (Array.isArray(entry.fields) && entry.fields.every((name) => typeof name === 'string')) names = entry.fields as string[]
  else throw new BatchError('invalid-op', null, '`fields` lists names')
  const fields: Record<string, unknown> = {}
  for (const name of names) {
    if (name === 'id' || name === 'type') continue
    fields[name] = readField(replica, id, ty, name)
  }
  return { id, type: ty, fields }
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
  const types: Record<string, { fields: Record<string, Record<string, unknown>>; readOnly?: true; readOnlyWhen?: { field: string; values: string[] } }> = {}
  for (const ty of sortedKeys(schema.types)) {
    const fields: Record<string, Record<string, unknown>> = {}
    for (const [name, field] of Object.entries(schema.types[ty].fields)) {
      const out: Record<string, unknown> = { kind: field.kind }
      if (field.of !== undefined) out.of = field.of
      if (field.values?.length) out.values = field.values
      if (field.optional) out.optional = true
      if (field.marks && Object.keys(field.marks).length > 0) out.marks = sortedKeys(field.marks)
      if (field.readOnly) out.readOnly = true
      fields[name] = out
    }
    const def = schema.types[ty]
    const out: { fields: Record<string, Record<string, unknown>>; readOnly?: true; readOnlyWhen?: { field: string; values: string[] } } = { fields }
    if (def.readOnly) out.readOnly = true
    if (def.readOnlyWhen) out.readOnlyWhen = { field: def.readOnlyWhen.field, values: [...def.readOnlyWhen.values] }
    types[ty] = out
  }
  return { capability: OBJECT_MODEL_CAPABILITY, kit: schema.kit, schemaVersion: schema.schemaVersion, root: schema.root, rootId: rootId(replica), types }
}
