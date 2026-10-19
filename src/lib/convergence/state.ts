// Copied from kition-sdk packages/convergence/src/state.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Schema-driven reads of a canonical KDM state (`Replica.stateJson`): reference checks, register
 * diffs, and a description of the first difference between two states. The TypeScript twin of the
 * Rust `kition_convergence::state`, with the same iteration orders, so both runners report the same
 * problem first.
 *
 * The canonical state is `{ "meta": {...}, "objects": { "<id>": { "$type": "T", "<field>": ... } } }`:
 * registers as their values, text as a string (or runs `{ insert, attributes? }` with marks), lists
 * as id arrays, trees as nested `{ object, children }`, maps as objects. Values are compared by
 * their canonical text (`canonicalText`), as the Rust suite compares `serde_json` values.
 */
import { canonicalText } from '../kdm'

/** A field's kind, as the schema names it, and the type a `ref`, `list`, or `tree` names. */
export type FieldInfo = { kind: string; of: string | null }

/** A register: one value, last writer wins. */
export function isRegister(field: FieldInfo): boolean {
  return !['text', 'list', 'tree', 'map'].includes(field.kind)
}

/** Strings in Unicode code point order, as Rust orders `String`s (by their UTF-8 bytes). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.codePointAt(index) as number
    const y = b.codePointAt(index) as number
    if (x !== y) return x < y ? -1 : 1
    if (x > 0xffff) index += 1
  }
  return a.length - b.length
}

function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort(compareStrings)
}

/** Whether two JSON values are equal (`undefined` reads as `null`, as a missing key does in Rust). */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalText(a ?? null) === canonicalText(b ?? null)
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function member(value: unknown, key: string): unknown {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : null
}

/** The parts of a KDM schema the suite reads: each type's fields and their kinds. */
export class SchemaInfo {
  constructor(
    readonly kit: string,
    readonly root: string,
    readonly types: ReadonlyMap<string, ReadonlyMap<string, FieldInfo>>,
  ) {}

  /** Reads `model/schema.json`. */
  static parse(text: string): SchemaInfo {
    let schema: unknown
    try {
      schema = JSON.parse(text)
    } catch (error) {
      throw new Error(`the schema is not JSON: ${(error as Error).message}`)
    }
    const typeDefs = member(schema, 'types')
    if (!isObject(typeDefs)) throw new Error('the schema has no types')
    const types = new Map<string, Map<string, FieldInfo>>()
    for (const name of sorted(Object.keys(typeDefs))) {
      const fields = new Map<string, FieldInfo>()
      const found = member(typeDefs[name], 'fields')
      const fieldDefs: Json = isObject(found) ? found : {}
      for (const field of sorted(Object.keys(fieldDefs))) {
        const def = fieldDefs[field]
        const kind = member(def, 'kind')
        if (typeof kind !== 'string') throw new Error(`${name}.${field} has no kind`)
        const of = member(def, 'of')
        fields.set(field, { kind, of: typeof of === 'string' ? of : null })
      }
      types.set(name, fields)
    }
    const stringAt = (key: string) => {
      const value = member(schema, key)
      return typeof value === 'string' ? value : ''
    }
    return new SchemaInfo(stringAt('kit'), stringAt('root'), types)
  }

  /** Whether any type has a field of `kind`. */
  hasKind(kind: string): boolean {
    return [...this.types.values()].some((fields) => [...fields.values()].some((field) => field.kind === kind))
  }

  field(ty: string, field: string): FieldInfo | undefined {
    return this.types.get(ty)?.get(field)
  }

  /** A type's fields in name order (none for an unknown type). */
  fieldsOf(ty: string): ReadonlyMap<string, FieldInfo> {
    return this.types.get(ty) ?? new Map()
  }
}

/** The objects of a state, by id. */
export function objects(state: unknown): Json {
  const found = member(state, 'objects')
  return isObject(found) ? found : {}
}

function typeOf(object: unknown): string | null {
  const ty = member(object, '$type')
  return typeof ty === 'string' ? ty : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Checks the schema's references in `state`; `dangling(ty, field)` says which fields may name deleted objects. Throws what it found. */
export function checkReferences(schema: SchemaInfo, state: unknown, dangling: (ty: string, field: string) => boolean): void {
  const all = objects(state)
  const typeOfId = (id: string) => (Object.hasOwn(all, id) ? typeOf(all[id]) : null)
  const problems: string[] = []
  // Each object is in at most one tree position overall.
  const inTrees = new Map<string, string>()
  for (const id of sorted(Object.keys(all))) {
    const object = all[id]
    const ty = typeOf(object)
    if (ty === null) {
      problems.push(`${id} has no $type`)
      continue
    }
    const fields = schema.types.get(ty)
    if (!fields) continue
    for (const [name, field] of fields) {
      const value = member(object, name)
      const checkTarget = (target: string, what: string) => {
        const found = typeOfId(target)
        if (found === null) {
          if (!dangling(ty, name)) problems.push(`${ty} ${id}.${name} ${what} ${target}, which does not exist`)
        } else if (field.of !== null && field.of !== found) {
          problems.push(`${ty} ${id}.${name} ${what} ${target}, a ${found} rather than a ${field.of}`)
        }
      }
      if (field.kind === 'ref') {
        if (typeof value === 'string') checkTarget(value, 'names')
      } else if (field.kind === 'list') {
        const seen = new Set<string>()
        for (const item of strings(value)) {
          if (seen.has(item)) problems.push(`${ty} ${id}.${name} holds ${item} twice`)
          seen.add(item)
          checkTarget(item, 'holds')
        }
      } else if (field.kind === 'tree') {
        const stack = [...array(value)]
        while (stack.length > 0) {
          const node = stack.pop()
          const target = member(node, 'object')
          if (typeof target === 'string') {
            const place = `${id}.${name}`
            const other = inTrees.get(target)
            if (other !== undefined) problems.push(`${target} is in a tree twice (${other} and ${place})`)
            inTrees.set(target, place)
            // A tree keeps a deleted object's node (standard 2.0 OM2a); readers skip it.
            if (typeOfId(target) !== null) checkTarget(target, 'has a node for')
          }
          stack.push(...array(member(node, 'children')))
        }
      }
    }
  }
  if (problems.length === 0) return
  const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''
  throw new Error(`invalid references: ${problems.slice(0, 5).join('; ')}${more}`)
}

/** A register a state holds: an object's register field, or one key of a map field (`field/key`). */
export type Slot = readonly [id: string, field: string]

/** Registers with their values, in slot order (id, then field). */
export class Registers {
  private readonly entries = new Map<string, { slot: Slot; value: unknown }>()

  private static key(slot: Slot) {
    return `${slot[0]}\u0000${slot[1]}`
  }

  set(slot: Slot, value: unknown) {
    this.entries.set(Registers.key(slot), { slot, value })
  }

  has(slot: Slot) {
    return this.entries.has(Registers.key(slot))
  }

  get(slot: Slot): unknown {
    return this.entries.get(Registers.key(slot))?.value
  }

  get size() {
    return this.entries.size
  }

  /** The registers in slot order. */
  list(): Array<{ slot: Slot; value: unknown }> {
    return sorted(this.entries.keys()).map((key) => this.entries.get(key) as { slot: Slot; value: unknown })
  }

  filter(keep: (slot: Slot, value: unknown) => boolean): Registers {
    const out = new Registers()
    for (const { slot, value } of this.list()) if (keep(slot, value)) out.set(slot, value)
    return out
  }
}

/** The registers that differ from `before` in `after` (new objects' registers included), with their values in `after`. */
export function registerChanges(schema: SchemaInfo, before: unknown, after: unknown): Registers {
  const old = objects(before)
  const out = new Registers()
  const now = objects(after)
  for (const id of sorted(Object.keys(now))) {
    const object = now[id]
    const fields = schema.types.get(typeOf(object) ?? '')
    if (!fields) continue
    const previous = Object.hasOwn(old, id) ? old[id] : undefined
    for (const [name, field] of fields) {
      const value = member(object, name)
      const was = previous === undefined ? undefined : member(previous, name)
      if (isRegister(field)) {
        if (was === undefined || !sameValue(was, value)) out.set([id, name], value)
      } else if (field.kind === 'map' && isObject(value)) {
        for (const key of sorted(Object.keys(value))) {
          if (was === undefined || !sameValue(member(was, key), value[key])) out.set([id, `${name}/${key}`], value[key])
        }
      }
    }
  }
  return out
}

/** A register's value in `state` (see `registerChanges`), `null` when absent. */
export function register(schema: SchemaInfo, state: unknown, slot: Slot): unknown {
  const all = objects(state)
  const object = Object.hasOwn(all, slot[0]) ? all[slot[0]] : null
  if (schema.field(typeOf(object) ?? '', slot[1])) return member(object, slot[1])
  const at = slot[1].indexOf('/')
  if (at < 0) return null
  return member(member(object, slot[1].slice(0, at)), slot[1].slice(at + 1))
}

/** Ids in `after` that are not in `before`, in order. */
export function created(before: unknown, after: unknown): string[] {
  const old = objects(before)
  return sorted(Object.keys(objects(after)).filter((id) => !Object.hasOwn(old, id)))
}

/** Ids in `before` that are not in `after`, in order. */
export function deleted(before: unknown, after: unknown): string[] {
  return created(after, before)
}

/** Every list field's items as a set, by `id.field`, in key order. */
export function listSets(schema: SchemaInfo, state: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const all = objects(state)
  for (const id of sorted(Object.keys(all))) {
    const object = all[id]
    for (const [name, field] of schema.fieldsOf(typeOf(object) ?? '')) {
      if (field.kind === 'list') out.set(`${id}.${name}`, new Set(strings(member(object, name))))
    }
  }
  return new Map(sorted(out.keys()).map((key) => [key, out.get(key) as Set<string>]))
}

/** Every tree's count of nodes, by `id.field`, in key order. */
export function treeNodes(schema: SchemaInfo, state: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const all = objects(state)
  for (const id of sorted(Object.keys(all))) {
    const object = all[id]
    for (const [name, field] of schema.fieldsOf(typeOf(object) ?? '')) {
      if (field.kind !== 'tree') continue
      let count = 0
      const stack = [...array(member(object, name))]
      while (stack.length > 0) {
        const node = stack.pop()
        count += 1
        stack.push(...array(member(node, 'children')))
      }
      out.set(`${id}.${name}`, count)
    }
  }
  return new Map(sorted(out.keys()).map((key) => [key, out.get(key) as number]))
}

/** The first place where `a` and `b` differ, as a JSON path with both values (abbreviated), or `null`. */
export function firstDifference(a: unknown, b: unknown): string | null {
  const walk = (a: unknown, b: unknown, path: string): string | null => {
    if (isObject(a) && isObject(b)) {
      for (const key of sorted(new Set([...Object.keys(a), ...Object.keys(b)]))) {
        const left = Object.hasOwn(a, key) ? a[key] : null
        const right = Object.hasOwn(b, key) ? b[key] : null
        if (!sameValue(left, right)) return walk(left, right, `${path}.${key}`)
      }
      return null
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (let index = 0; index < a.length; index += 1) {
        if (!sameValue(a[index], b[index])) return walk(a[index], b[index], `${path}[${index}]`)
      }
      return null
    }
    if (sameValue(a, b)) return null
    return `${path || '(root)'}: ${abbreviate(a)} vs ${abbreviate(b)}`
  }
  return walk(a, b, '')
}

function abbreviate(value: unknown): string {
  const text = canonicalText(value ?? null)
  const chars = Array.from(text)
  return chars.length > 160 ? `${chars.slice(0, 160).join('')}...` : text
}

/**
 * For reports only (the suite compares states directly): a short FNV-1a digest of the canonical
 * text, the same as the Rust `state::digest`.
 */
export function digest(state: unknown): string {
  const mask = (1n << 64n) - 1n
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(canonicalText(state ?? null))) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
