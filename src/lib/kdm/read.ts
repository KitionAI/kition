// Copied from kition-sdk packages/kdm/src/read.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** Reads shared by `Replica` and `Tx`, mirroring the Rust crate's `read` module. */
import { isContainer as isEngineContainer, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree, type LoroTreeNode } from 'loro-crdt'
import { canonical, compareKeys, setKey } from './canonical'
import { errors, type KdmError } from './errors'
import type { ObjectId } from './ids'
import { pushRun, runs, type TextRun } from './marks'
import { fieldDef, hasMarks, isContainer, sortedKeys, type FieldKind, type Schema } from './schema'

export const META = 'meta'
export const OBJECTS = 'objects'
export const TYPE_KEY = '$type'
export const NODE_OBJECT = 'object'

/** The engine container class each container kind is stored as. */
export const CONTAINER_CLASS = { text: LoroText, list: LoroMovableList, tree: LoroTree, map: LoroMap } as const

export type ContainerKind = keyof typeof CONTAINER_CLASS

type ContainerOf<K extends ContainerKind> = InstanceType<(typeof CONTAINER_CLASS)[K]>

export function objectMap(doc: LoroDoc, id: ObjectId): LoroMap {
  const found = doc.getMap(OBJECTS).get(id)
  if (!(found instanceof LoroMap)) throw errors.notFound(id)
  return found
}

export function typeOf(map: LoroMap, id: ObjectId): string {
  const ty = map.get(TYPE_KEY)
  if (typeof ty !== 'string') throw errors.notFound(id)
  return ty
}

export const objectType = (doc: LoroDoc, id: ObjectId): string => typeOf(objectMap(doc, id), id)

export const wrongContainer = (id: ObjectId, field: string): KdmError => errors.engine(`${id}.${field} holds the wrong container`)

/** The error for using a field as a kind it is not. */
export const wrongKind = (ty: string, field: string, kind: FieldKind): KdmError => errors.invalidValue(ty, field, `is not a ${kind} field`)

/** `value` as a container of `kind`, `null` for a missing field, or the wrong-container error. */
export function asContainer<K extends ContainerKind>(value: unknown, kind: K, id: ObjectId, field: string): ContainerOf<K> | null {
  if (value === undefined) return null
  if (value instanceof CONTAINER_CLASS[kind]) return value as ContainerOf<K>
  throw wrongContainer(id, field)
}

/**
 * A container field of an object, checked against the schema. `null` when the stored object lacks
 * the field: it was written under an older schema version, and the field reads as empty.
 */
export function container<K extends ContainerKind>(doc: LoroDoc, schema: Schema, id: ObjectId, field: string, kind: K): ContainerOf<K> | null {
  const map = objectMap(doc, id)
  const ty = typeOf(map, id)
  if (fieldDef(schema, ty, field).kind !== kind) throw wrongKind(ty, field, kind)
  return asContainer(map.get(field), kind, id, field)
}

/** A text field's runs (`TextRun`): one unmarked run for a field that declares no marks. */
export function textRuns(doc: LoroDoc, schema: Schema, id: ObjectId, field: string): TextRun[] {
  const text = container(doc, schema, id, field, 'text')
  if (!text) return []
  const def = fieldDef(schema, objectType(doc, id), field)
  if (hasMarks(def)) return runs(text, def)
  const out: TextRun[] = []
  pushRun(out, text.toString(), undefined)
  return out
}

/** A register field's value in canonical form, or `null`. */
export function register(doc: LoroDoc, schema: Schema, id: ObjectId, field: string): unknown {
  const map = objectMap(doc, id)
  const ty = typeOf(map, id)
  if (isContainer(fieldDef(schema, ty, field).kind)) throw errors.invalidValue(ty, field, 'is a container; read it with its accessor')
  return storedValue(map.get(field))
}

/** A value read from the engine in canonical form; a missing value or a container reads as `null`. */
export const storedValue = (value: unknown): unknown => (value === undefined || isEngineContainer(value) ? null : canonical(value))

/** A map field's keys and values as `storedValue` reads them, sorted by key in code point order. */
export function mapEntries(map: LoroMap): Array<[string, unknown]> {
  return map
    .keys()
    .sort(compareKeys)
    .map((key): [string, unknown] => [key, storedValue(map.get(key))])
}

/** Ids of the objects of type `ty`, sorted. One pass over every object of the document. */
export function objectsOfType(doc: LoroDoc, ty: string): ObjectId[] {
  const ids: ObjectId[] = []
  for (const [id, value] of doc.getMap(OBJECTS).entries()) {
    if (value instanceof LoroMap && value.get(TYPE_KEY) === ty) ids.push(id)
  }
  return ids.sort(compareKeys)
}

/**
 * A list's items. Every item of a KDM list is an object id; anything else was written outside the
 * KDM and is an `encoding` error, so indices never disagree with the engine's.
 */
export function listItems(items: unknown[]): ObjectId[] {
  items.forEach((item, index) => {
    if (typeof item !== 'string') throw errors.encoding(`list item ${index} is ${describe(item)}, not an object id`)
  })
  return items as ObjectId[]
}

const describe = (value: unknown): string => (isEngineContainer(value) ? 'a container' : JSON.stringify(value) ?? String(value))

/** The object a tree node names, or `null` for a node without one; tree reads skip it with its subtree. */
export function nodeObject(node: LoroTreeNode): ObjectId | null {
  const object = node.data.get(NODE_OBJECT)
  return typeof object === 'string' ? object : null
}

export function objectIds(doc: LoroDoc): ObjectId[] {
  return doc.getMap(OBJECTS).keys().sort(compareKeys)
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The key the engine's deep JSON loses: it assigns keys, and assigning `__proto__` changes the prototype instead. */
const PROTO = '__proto__'

/** A value as the engine's deep JSON gives it: containers by their own deep JSON. */
const deepValue = (value: unknown): unknown => (isEngineContainer(value) ? (value as { toJSON(): unknown }).toJSON() : value)

interface DeepNode {
  meta?: Record<string, unknown>
  children?: DeepNode[]
}

/** A tree from the engine's deep JSON in canonical `{ object, children }` form; a node without an object is skipped with its subtree. */
function treeFromDeep(nodes: DeepNode[] | undefined): unknown[] {
  const out: unknown[] = []
  for (const node of nodes ?? []) {
    const object = node.meta?.[NODE_OBJECT]
    if (typeof object === 'string') out.push({ children: treeFromDeep(node.children), object })
  }
  return out
}

/** A tree read node by node, in the same form as `treeFromDeep`. */
function treeJson(nodes: LoroTreeNode[] | undefined): unknown[] {
  const out: unknown[] = []
  for (const node of nodes ?? []) {
    const object = nodeObject(node)
    if (object !== null) out.push({ children: treeJson(node.children()), object })
  }
  return out
}

/** A map field read key by key, keeping a `__proto__` key. */
function mapJson(map: LoroMap): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of map.keys()) setKey(out, key, deepValue(map.get(key)))
  return out
}

/**
 * One object in canonical form by per-field reads, as the Rust `object_json`: for the rare
 * objects the engine's deep JSON cannot represent (an id or a field named `__proto__`).
 */
function objectJson(doc: LoroDoc, schema: Schema, id: ObjectId): Record<string, unknown> {
  const map = objectMap(doc, id)
  const ty = typeOf(map, id)
  const out: Record<string, unknown> = { [TYPE_KEY]: ty }
  if (!Object.hasOwn(schema.types, ty)) return out
  const fields = schema.types[ty].fields
  for (const name of sortedKeys(fields)) {
    const kind = fields[name].kind
    let value: unknown
    if (kind === 'text' && hasMarks(fields[name])) {
      const text = container(doc, schema, id, name, 'text')
      value = text ? runs(text, fields[name]) : []
    } else if (kind === 'text') value = container(doc, schema, id, name, 'text')?.toString() ?? ''
    else if (kind === 'list') value = listItems(container(doc, schema, id, name, 'list')?.toArray() ?? [])
    else if (kind === 'tree') value = treeJson(container(doc, schema, id, name, 'tree')?.roots())
    else if (kind === 'map') {
      const found = container(doc, schema, id, name, 'map')
      value = found ? mapJson(found) : {}
    } else value = register(doc, schema, id, name)
    setKey(out, name, value)
  }
  return out
}

/** The keys of a declared type's objects in `stateJson` (`$type` and its fields), in canonical order. */
const canonicalKeys = new WeakMap<Schema, Map<string, string[]>>()

function keysOf(schema: Schema, ty: string): string[] {
  let byType = canonicalKeys.get(schema)
  if (!byType) canonicalKeys.set(schema, (byType = new Map()))
  let keys = byType.get(ty)
  if (!keys) byType.set(ty, (keys = [TYPE_KEY, ...Object.keys(schema.types[ty].fields)].sort(compareKeys)))
  return keys
}

/** A value of the engine's deep JSON in canonical form: plain values as they are, objects and arrays copied by `canonical`. */
const canonicalValue = (value: unknown): unknown => (value !== null && typeof value === 'object' ? canonical(value) : value)

/**
 * The whole document in canonical form, from one engine read rather than one per field. An
 * object of a type the schema does not declare reads as its `$type` only; a field the stored
 * object lacks reads as empty (`null`, `""`, `[]`, `{}`). Only `canonicalText` of it is the
 * canonical form.
 *
 * Objects are built with their keys already in canonical order, so only the values the engine
 * hands over as objects (JSON registers, map fields, `meta`) go through `canonical`.
 */
export function stateJson(doc: LoroDoc, schema: Schema): unknown {
  const deep = doc.toJSON() as Record<string, unknown>
  const stored = isRecord(deep[OBJECTS]) ? (deep[OBJECTS] as Record<string, unknown>) : {}
  const objectsMap = doc.getMap(OBJECTS)
  const ids = Object.keys(stored)
  if (objectsMap.get(PROTO) !== undefined) ids.push(PROTO)
  ids.sort(compareKeys)
  const objects: Record<string, unknown> = {}
  for (const id of ids) {
    const raw = stored[id]
    const ty = isRecord(raw) ? raw[TYPE_KEY] : undefined
    const declared = typeof ty === 'string' && Object.hasOwn(schema.types, ty)
    if (id === PROTO || (declared && Object.hasOwn(schema.types[ty].fields, PROTO))) {
      setKey(objects, id, canonical(objectJson(doc, schema, id)))
      continue
    }
    if (!isRecord(raw) || typeof ty !== 'string') throw errors.notFound(id)
    if (!declared) {
      objects[id] = { [TYPE_KEY]: ty }
      continue
    }
    const out: Record<string, unknown> = {}
    objects[id] = out
    const fields = schema.types[ty].fields
    for (const name of keysOf(schema, ty)) {
      if (name === TYPE_KEY) {
        out[name] = ty
        continue
      }
      const value = raw[name]
      const wrong = () => wrongContainer(id, name)
      switch (fields[name].kind) {
        case 'text':
          if (value !== undefined && typeof value !== 'string') throw wrong()
          if (hasMarks(fields[name])) {
            const text = value === undefined ? null : asContainer(objectMap(doc, id).get(name), 'text', id, name)
            out[name] = text ? runs(text, fields[name]) : []
          } else out[name] = value ?? ''
          break
        case 'list':
          if (value !== undefined && !Array.isArray(value)) throw wrong()
          out[name] = Array.isArray(value) ? listItems(value) : []
          break
        case 'tree':
          if (value !== undefined && !Array.isArray(value)) throw wrong()
          out[name] = treeFromDeep(value as DeepNode[] | undefined)
          break
        case 'map': {
          if (value !== undefined && !isRecord(value)) throw wrong()
          const entries: Record<string, unknown> = isRecord(value) ? { ...value } : {}
          const engineMap = objectMap(doc, id).get(name)
          const proto = engineMap instanceof LoroMap ? engineMap.get(PROTO) : undefined
          if (proto !== undefined) setKey(entries, PROTO, deepValue(proto))
          out[name] = canonical(entries)
          break
        }
        default:
          out[name] = value === undefined ? null : canonicalValue(value)
      }
    }
  }
  return { meta: canonical(isRecord(deep[META]) ? deep[META] : {}), objects }
}
