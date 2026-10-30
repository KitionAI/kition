// Copied from kition-sdk packages/kdm/src/schema.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { compareKeys, setKey } from './canonical'
import { errors } from './errors'
import { toJson, type JsonValue } from './value'

/** The KDM schema format version this build reads. */
export const KDM_VERSION = 1

/** The largest integer magnitude an `integer` field holds, exact in every implementation. */
const MAX_SAFE_INTEGER = 2 ** 53

/** The largest `kdm` and `schemaVersion`: the Rust crate reads them as `u32`. */
const MAX_U32 = 2 ** 32 - 1

/**
 * What a field holds. Registers hold one value (last writer wins); containers merge their
 * contents (text characters, list items, tree nodes, map keys).
 */
export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json' | 'blob' | 'ref' | 'text' | 'list' | 'tree' | 'map'

export interface FieldDef {
  kind: FieldKind
  /** The type a `ref`, `list`, or `tree` field names. */
  of?: string
  /** The allowed values of an `enum` field. */
  values?: string[]
  optional?: boolean
  /**
   * The marks a `text` field takes (rich-text run properties), by key (rule M19). A field without
   * marks reads as a plain string in the canonical state; one with marks reads as its runs.
   */
  marks?: Record<string, MarkDef>
  /**
   * Content the kit keeps verbatim but does not model (rule OM8): the object model reads the
   * field and never writes it. The kit's own transactions and commands still do.
   */
  readOnly?: boolean
}

/** How a mark grows when text is inserted at one of its ends. */
export type Expand = 'after' | 'before' | 'both' | 'none'

/** One mark a `text` field declares. */
export interface MarkDef {
  expand: Expand
}

export interface TypeDef {
  fields: Record<string, FieldDef>
  /** Every object of the type is read-only through the object model (rule OM8). */
  readOnly?: boolean
  /** The objects whose enum `field` holds one of `values` are read-only through the object model (rule OM8). */
  readOnlyWhen?: ReadOnlyWhen
}

/** `{ field: <an enum field of the type>, values }`: the objects holding one of the values are read-only. */
export interface ReadOnlyWhen {
  field: string
  values: string[]
}

/**
 * Whether the object model may not write an object of type `def` (rule OM8). `field` answers a
 * register's value (for `readOnlyWhen`).
 */
export function objectReadOnly(def: TypeDef, field: (name: string) => unknown): boolean {
  if (def.readOnly) return true
  const when = def.readOnlyWhen
  if (when === undefined) return false
  const value = field(when.field)
  return typeof value === 'string' && when.values.includes(value)
}

/** A kit's document schema (`model/schema.json` in its package). Built by `parseSchema`, which checks it. */
export interface Schema {
  readonly kdm: number
  readonly kit: string
  readonly schemaVersion: number
  readonly root: string
  readonly types: Readonly<Record<string, TypeDef>>
}

const EXPANDS: readonly string[] = ['after', 'before', 'both', 'none']
const KINDS: readonly string[] = ['string', 'number', 'integer', 'boolean', 'enum', 'json', 'blob', 'ref', 'text', 'list', 'tree', 'map']
const CONTAINERS: readonly FieldKind[] = ['text', 'list', 'tree', 'map']
const TAKES_OF: readonly FieldKind[] = ['ref', 'list', 'tree']

export const isContainer = (kind: FieldKind): boolean => CONTAINERS.includes(kind)

/** Keys in the order the Rust crate visits them (`BTreeMap`: code point order), whatever JavaScript's own order. */
export const sortedKeys = (value: object): string[] => Object.keys(value).sort(compareKeys)

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const isU32 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_U32

/** Refuses keys outside `allowed`, as the Rust parser does (`deny_unknown_fields`). */
function onlyKeys(where: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw errors.schema(`${where}: unknown field \`${key}\``)
  }
}

/** One field definition as written, checked for shape only. */
function readField(where: string, raw: unknown): FieldDef {
  if (!isRecord(raw)) throw errors.schema(`${where}: a field definition is an object`)
  onlyKeys(where, raw, ['kind', 'of', 'values', 'optional', 'marks', 'readOnly'])
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) throw errors.schema(`${where}: unknown kind \`${String(raw.kind)}\``)
  const field: FieldDef = { kind: raw.kind as FieldKind }
  if (raw.of !== undefined && raw.of !== null) {
    if (typeof raw.of !== 'string') throw errors.schema(`${where}: \`of\` is a type name`)
    field.of = raw.of
  }
  if (raw.values !== undefined) {
    if (!Array.isArray(raw.values) || !raw.values.every((value) => typeof value === 'string')) throw errors.schema(`${where}: \`values\` is a list of strings`)
    field.values = [...raw.values]
  }
  if (raw.optional !== undefined) {
    if (typeof raw.optional !== 'boolean') throw errors.schema(`${where}: \`optional\` is a boolean`)
    field.optional = raw.optional
  }
  if (raw.marks !== undefined) {
    if (!isRecord(raw.marks)) throw errors.schema(`${where}: \`marks\` is an object of mark definitions`)
    const marks: Record<string, MarkDef> = {}
    for (const key of sortedKeys(raw.marks)) {
      const mark = raw.marks[key]
      if (!isRecord(mark)) throw errors.schema(`${where} mark \`${key}\`: a mark definition is an object`)
      onlyKeys(`${where} mark \`${key}\``, mark, ['expand'])
      if (typeof mark.expand !== 'string' || !EXPANDS.includes(mark.expand)) throw errors.schema(`${where} mark \`${key}\`: \`expand\` is after, before, both, or none`)
      setKey(marks, key, { expand: mark.expand as Expand })
    }
    field.marks = marks
  }
  if (raw.readOnly !== undefined) {
    if (typeof raw.readOnly !== 'boolean') throw errors.schema(`${where}: \`readOnly\` is a boolean`)
    if (raw.readOnly) field.readOnly = true
  }
  return field
}

/** Why `key` cannot name a mark, or `null`: the engine reserves `:` in style keys, and a `__proto__` attribute is lost by reads. */
function badMarkKey(key: string): string | null {
  if (key === '') return 'a mark key is not empty'
  if (key.startsWith('$')) return 'names starting with `$` are reserved'
  if (key.includes(':')) return 'a mark key holds no `:`'
  if (key === '__proto__') return '`__proto__` is not a mark key'
  return null
}

/** Whether `def` is a `text` field that declares marks. */
export const hasMarks = (def: FieldDef): boolean => def.kind === 'text' && def.marks !== undefined && Object.keys(def.marks).length > 0

/** Every mark key the schema declares with its expand: each key has one expand in a schema. */
export function markExpands(schema: Schema): Map<string, Expand> {
  const out = new Map<string, Expand>()
  for (const ty of sortedKeys(schema.types)) {
    const fields = schema.types[ty].fields
    for (const name of sortedKeys(fields)) {
      const marks = fields[name].marks ?? {}
      for (const key of sortedKeys(marks)) out.set(key, marks[key].expand)
    }
  }
  return out
}

/** The schema as written, checked for shape only: what the Rust crate's deserialization accepts. */
function readSchema(raw: unknown): Schema {
  if (!isRecord(raw)) throw errors.schema('a schema is a JSON object')
  onlyKeys('schema', raw, ['kdm', 'kit', 'schemaVersion', 'root', 'types'])
  if (!isU32(raw.kdm)) throw errors.schema('`kdm` is required and is a whole number')
  if (typeof raw.kit !== 'string') throw errors.schema('`kit` is required and is a string')
  if (!isU32(raw.schemaVersion)) throw errors.schema('`schemaVersion` is required and is a whole number')
  if (typeof raw.root !== 'string') throw errors.schema('`root` is required and is a string')
  if (!isRecord(raw.types)) throw errors.schema('`types` is required and is an object')
  const types: Record<string, TypeDef> = {}
  for (const ty of sortedKeys(raw.types)) {
    const def = raw.types[ty]
    if (!isRecord(def)) throw errors.schema(`type \`${ty}\` is an object`)
    onlyKeys(`type \`${ty}\``, def, ['fields', 'readOnly', 'readOnlyWhen'])
    if (!isRecord(def.fields)) throw errors.schema(`type \`${ty}\` needs \`fields\``)
    const fields: Record<string, FieldDef> = {}
    for (const name of sortedKeys(def.fields)) setKey(fields, name, readField(`\`${ty}.${name}\``, def.fields[name]))
    const out: TypeDef = { fields }
    if (def.readOnly !== undefined) {
      if (typeof def.readOnly !== 'boolean') throw errors.schema(`type \`${ty}\`: \`readOnly\` is a boolean`)
      if (def.readOnly) out.readOnly = true
    }
    if (def.readOnlyWhen !== undefined && def.readOnlyWhen !== null) {
      const when = def.readOnlyWhen
      if (!isRecord(when)) throw errors.schema(`type \`${ty}\`: \`readOnlyWhen\` is { field, values }`)
      onlyKeys(`type \`${ty}\` readOnlyWhen`, when, ['field', 'values'])
      if (typeof when.field !== 'string') throw errors.schema(`type \`${ty}\`: \`readOnlyWhen.field\` is a field name`)
      if (!Array.isArray(when.values) || !when.values.every((value) => typeof value === 'string')) throw errors.schema(`type \`${ty}\`: \`readOnlyWhen.values\` is a list of strings`)
      out.readOnlyWhen = { field: when.field, values: [...when.values] }
    }
    setKey(types, ty, out)
  }
  return { kdm: raw.kdm, kit: raw.kit, schemaVersion: raw.schemaVersion, root: raw.root, types }
}

/** The rules of the Rust `Schema::check`, in the same order. */
function checkSchema(schema: Schema): void {
  if (schema.kdm !== KDM_VERSION) throw errors.schema(`kdm ${schema.kdm} is not supported; this build reads ${KDM_VERSION}`)
  if (!Object.hasOwn(schema.types, schema.root)) throw errors.schema(`root type \`${schema.root}\` is not declared`)
  const expands = new Map<string, Expand>()
  for (const ty of sortedKeys(schema.types)) {
    if (ty.startsWith('$')) throw errors.schema(`type \`${ty}\`: names starting with \`$\` are reserved`)
    const def = schema.types[ty]
    const when = def.readOnlyWhen
    if (when !== undefined) {
      if (def.readOnly) throw errors.schema(`type \`${ty}\`: \`readOnly\` and \`readOnlyWhen\` exclude each other`)
      if (!Object.hasOwn(def.fields, when.field)) throw errors.schema(`type \`${ty}\`: \`readOnlyWhen\` names undeclared field \`${when.field}\``)
      const field = def.fields[when.field]
      if (field.kind !== 'enum') throw errors.schema(`type \`${ty}\`: \`readOnlyWhen\` names \`${when.field}\`, which is not an enum`)
      if (when.values.length === 0) throw errors.schema(`type \`${ty}\`: \`readOnlyWhen\` needs \`values\``)
      const stray = when.values.find((value) => !(field.values ?? []).includes(value))
      if (stray !== undefined) throw errors.schema(`type \`${ty}\`: \`readOnlyWhen\` value \`${stray}\` is not a value of \`${ty}.${when.field}\``)
    }
    for (const name of sortedKeys(def.fields)) {
      const field = def.fields[name]
      if (name.startsWith('$')) throw errors.schema(`\`${ty}.${name}\`: names starting with \`$\` are reserved`)
      const takesOf = TAKES_OF.includes(field.kind)
      if (field.of !== undefined && !takesOf) throw errors.schema(`\`${ty}.${name}\`: only ref, list, and tree fields take \`of\``)
      if (field.values?.length && field.kind !== 'enum') throw errors.schema(`\`${ty}.${name}\`: only enum fields take \`values\``)
      if (field.kind === 'enum' && !field.values?.length) throw errors.schema(`\`${ty}.${name}\`: an enum needs \`values\``)
      if (takesOf) {
        if (field.of === undefined) throw errors.schema(`\`${ty}.${name}\` needs \`of\``)
        if (!Object.hasOwn(schema.types, field.of)) throw errors.schema(`\`${ty}.${name}\` refers to undeclared type \`${field.of}\``)
      }
      const marks = field.marks ?? {}
      const keys = sortedKeys(marks)
      if (keys.length > 0 && field.kind !== 'text') throw errors.schema(`\`${ty}.${name}\`: only text fields take \`marks\``)
      for (const key of keys) {
        const reason = badMarkKey(key)
        if (reason !== null) throw errors.schema(`\`${ty}.${name}\` mark \`${key}\`: ${reason}`)
        const expand = marks[key].expand
        const other = expands.get(key)
        if (other !== undefined && other !== expand) {
          throw errors.schema(`\`${ty}.${name}\` mark \`${key}\` expands \`${expand}\`, but it is declared elsewhere expanding \`${other}\`; a mark key has one expand in a schema`)
        }
        expands.set(key, expand)
      }
    }
  }
}

/** Parses and checks a schema with the same rules as the Rust `Schema::parse`. The result is a checked copy. */
export function parseSchema(input: string | object): Schema {
  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (error) {
      throw errors.schema(String(error))
    }
  }
  const schema = readSchema(raw)
  checkSchema(schema)
  return schema
}

export function typeDef(schema: Schema, ty: string): TypeDef {
  if (!Object.hasOwn(schema.types, ty)) throw errors.unknownType(ty)
  return schema.types[ty]
}

export function fieldDef(schema: Schema, ty: string, field: string): FieldDef {
  const def = typeDef(schema, ty)
  if (!Object.hasOwn(def.fields, field)) throw errors.unknownField(ty, field, Object.keys(def.fields).sort())
  return def.fields[field]
}

/** Checks a value for a register field, as the Rust `Schema::check_value`. Container fields take no value. */
export function checkValue(schema: Schema, ty: string, field: string, value: unknown): void {
  checkedValue(schema, ty, field, value)
}

/** `checkValue` answering the value as the KDM stores it: a checked JSON copy (see `toJson`). */
export function checkedValue(schema: Schema, ty: string, field: string, value: unknown): JsonValue {
  const def = fieldDef(schema, ty, field)
  if (isContainer(def.kind)) throw errors.invalidValue(ty, field, containerAdvice(def.kind))
  if (value === null || value === undefined) {
    if (def.optional) return null
    throw errors.invalidValue(ty, field, 'is required')
  }
  const json = toJson(value, (reason) => errors.invalidValue(ty, field, reason))
  let ok: boolean
  switch (def.kind) {
    case 'string':
    case 'ref':
      ok = typeof json === 'string'
      break
    case 'number':
      ok = typeof json === 'number'
      break
    case 'integer':
      ok = typeof json === 'number' && Number.isInteger(json) && Math.abs(json) <= MAX_SAFE_INTEGER
      break
    case 'boolean':
      ok = typeof json === 'boolean'
      break
    case 'enum':
      ok = typeof json === 'string' && (def.values ?? []).includes(json)
      break
    case 'blob':
      ok =
        isRecord(json) &&
        typeof json.hash === 'string' &&
        typeof json.mime === 'string' &&
        typeof json.size === 'number' &&
        Number.isInteger(json.size) &&
        json.size >= 0 &&
        json.size <= MAX_SAFE_INTEGER
      break
    default:
      ok = true
  }
  if (!ok) throw errors.invalidValue(ty, field, `expects a ${def.kind} value`)
  return json
}

/** As the Rust `Schema::check_value`: which operations change a container field. */
function containerAdvice(kind: string): string {
  const ops: Record<string, string> = {
    text: 'text.insert, text.delete, text.set, text.mark, text.unmark',
    list: 'list.insert, list.move, list.remove',
    tree: 'tree.insert, tree.move',
    map: 'map.set, map.delete',
  }
  return `is a container, not a value: change it with ${ops[kind] ?? 'its operations'}, or set the fields of the objects it holds`
}
