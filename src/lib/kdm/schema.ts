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
  /** The field's wording in instructions; a boolean's positive state. */
  label?: string
  minimum?: number
  maximum?: number
  multipleOf?: number
  members?: Record<string, { minimum?: number; maximum?: number; multipleOf?: number; nullable?: boolean }>
  /** The type a ref, list, tree or typed owning map names. Typed map entries are object IDs. */
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
  /**
   * A `ref` field whose object is part of the object holding it (a shape's text body), as the items
   * of a `list` or `tree` field always are; a ref without it only points (a picture's shared media).
   * A `map` field declared `owns` holds, under each key, the objects its value names (`mapHeld`):
   * a table's cells, each value naming the cell's text body. Change sets attribute a change of an
   * object without a tool id to the nearest object holding it (`diffWithToolIds`).
   */
  owns?: boolean
  /** Batch deletion of a node also deletes descendants of this tree, child-first. */
  cascade?: boolean
  /**
   * A field that says where its object is rather than what it is (a clip's `start` and `duration`
   * on its track): agent tools treat its change as a move of the object, never as a change of its
   * content (as the Rust `FieldDef::position`).
   */
  position?: boolean
  /** How a person reads the value, as the Rust `FieldDef::display`. */
  display?: { kind: 'time'; perSecond: number; fps?: number }
  /** Whether a training environment may sample an edit of it, as the Rust `FieldDef::sample`. */
  sample?: boolean
}

/** Whether the objects `def` holds are parts of its object: a `list` or `tree` field, or a `ref` or `map` declared `owns` (as the Rust `FieldDef::owning`). */
export const owning = (def: FieldDef): boolean => def.kind === 'list' || def.kind === 'tree' || ((def.kind === 'ref' || def.kind === 'map') && def.owns === true)

/**
 * As the Rust `FieldDef::map_held`: the objects an owning `map` field's value `map` holds, each with
 * its place: the value under a key when it is a string naming an object (`<key>`), else each member
 * of an object value that is one (`<key>.<member>`), keys and members in order.
 */
export function mapHeld(map: unknown, exists: (id: string) => boolean): Array<[string, string]> {
  const isEntries = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  const names = (value: unknown): string | null => (typeof value === 'string' && value !== '' && exists(value) ? value : null)
  const out: Array<[string, string]> = []
  if (!isEntries(map)) return out
  for (const key of Object.keys(map).sort(compareKeys)) {
    const value = map[key]
    const id = names(value)
    if (id !== null) {
      out.push([id, key])
    } else if (isEntries(value)) {
      for (const member of Object.keys(value).sort(compareKeys)) {
        const held = names(value[member])
        if (held !== null) out.push([held, `${key}.${member}`])
      }
    }
  }
  return out
}

/** How a mark grows when text is inserted at one of its ends. */
export type Expand = 'after' | 'before' | 'both' | 'none'

/** One mark a `text` field declares. */
export interface MarkDef {
  expand: Expand
}

export interface TypeDef {
  fields: Record<string, FieldDef>
  projected?: boolean
  projectedOps?: Record<string, { command: string; params?: Record<string, string> }>
  batchOps?: Record<string, { direct: true } | { command: string; params?: Record<string, string> }>
  creation?: { fields?: Record<string, unknown>; command?: { command: string; params?: Record<string, string> }; fixtures?: Record<string, unknown> }
  /** Position field paths regenerated by a move, including on owned descendants. */
  moveConsequences?: string[]
  structuralConsequences?: Array<{ container: string; on: Array<'create' | 'delete' | 'move' | 'rename' | 'set'>; fields: string[] }>
  /** Every object of the type is read-only through the object model (rule OM8). */
  readOnly?: boolean
  /** The objects whose enum `field` holds one of `values` are read-only through the object model (rule OM8). */
  readOnlyWhen?: ReadOnlyWhen
  /**
   * The type's tool id (rule OM9): the field holding the id the kit's own tools give its objects,
   * which the object model then answers and takes as their `id`.
   */
  toolId?: ToolIdDef
  /**
   * How an object of the type is named in a path, as the kit's commands name it: a
   * field (`name`), or a member of a json field (`meta.match`); change sets then give an edit inside
   * a held object `named` beside its `field` (as the Rust `TypeDef::path_name`).
   */
  pathName?: string
  /** What names an object of the type to a person, as the Rust `TypeDef::label`. */
  label?: string
  /**
   * Values the kit computes for an object of the type on request and never stores: a
   * mesh's topology, its local bounds; change sets name one `~<name>` (as the Rust
   * `TypeDef::derived`).
   */
  derived?: Record<string, DerivedDef>
  /** The field or JSON member path containing the object's displayed text. */
  text?: string
  /** Raw field writes depend only on identity and the written fields, not placement. */
  batchIndependent?: boolean
}

/** One derived value a type declares: what it says, for the agent (as the Rust `DerivedDef`). */
export interface DerivedDef {
  description?: string
  premiseOnly?: boolean
  onDemand?: boolean
}

/**
 * `{ field, prefix?, parent? }`: an object of the type is named at the tool interface by `prefix`
 * and the value of its read-only `integer` or `string` `field` (`item:` and `10` give `item:10`),
 * after its `parent`'s tool id and a `/` when the type's values are unique only within a parent
 * (`story:11/table:2`). As the Rust `ToolIdDef`.
 */
export interface ToolIdDef {
  field: string
  prefix: string
  /** The type whose object holds an object of this type in a `list`, `tree`, or `ref` field. */
  parent?: string
}

/** The longest tool-id prefix a schema declares. */
const MAX_PREFIX = 32

/** Why `prefix` cannot start a tool id, or `null` when it can (as the Rust `bad_prefix`). */
function badPrefix(prefix: string): string | null {
  if (prefix === '') return null
  if (prefix.length > MAX_PREFIX) return 'a prefix has at most 32 characters'
  if (!/^[A-Za-z]/.test(prefix)) return 'a prefix starts with a letter'
  if (!/^[A-Za-z0-9_:/-]*$/.test(prefix)) return 'a prefix holds ASCII letters, digits, `_`, `-`, `:`, and `/` only'
  return null
}

/** Whether any type declares a tool id (rule OM9). */
export const hasToolIds = (schema: Schema): boolean => Object.values(schema.types).some((def) => def.toolId !== undefined)

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
  onlyKeys(where, raw, ['kind', 'of', 'values', 'optional', 'marks', 'readOnly', 'owns', 'cascade', 'position', 'display', 'sample', 'minimum', 'maximum', 'multipleOf', 'label', 'members'])
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind)) throw errors.schema(`${where}: unknown kind \`${String(raw.kind)}\``)
  const field: FieldDef = { kind: raw.kind as FieldKind }
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== 'string') throw errors.schema(`${where}: label is a string`)
    field.label = raw.label
  }
  for (const key of ['minimum', 'maximum', 'multipleOf'] as const) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (!['number', 'integer', 'json'].includes(field.kind) || typeof value !== 'number' || !Number.isFinite(value) || (key === 'multipleOf' && value <= 0)) throw errors.schema(`${where}: invalid numeric limit ${key}`)
    field[key] = value
  }
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) throw errors.schema(`${where}: minimum exceeds maximum`)
  if (raw.members !== undefined) {
    if (!isRecord(raw.members) || (!['json', 'map'].includes(field.kind) && Object.keys(raw.members).length > 0)) throw errors.schema(`${where}: members requires json or map and an object`)
    field.members = {}
    for (const [name, limits] of Object.entries(raw.members)) {
      if (name.split('.').some((segment) => !/^[^.[\]]+(?:\[\])*$/.test(segment))) throw errors.schema(`${where}: invalid member path ${name}`)
      if (!isRecord(limits)) throw errors.schema(`${where}: member limits must be an object`)
      onlyKeys(where, limits, ['minimum', 'maximum', 'multipleOf', 'nullable'])
      const { nullable, ...numeric } = limits
      if (nullable !== undefined && typeof nullable !== 'boolean') throw errors.schema(`${where}: nullable is a boolean`)
      const parsed = readField(`${where}.${name}`, { kind: 'number', ...numeric })
      const member: { minimum?: number; maximum?: number; multipleOf?: number; nullable?: boolean } = {}
      if (nullable === true) member.nullable = true
      for (const key of ['minimum', 'maximum', 'multipleOf'] as const) if (parsed[key] !== undefined) member[key] = parsed[key]
      setKey(field.members, name, member)
    }
  }
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
  if (raw.owns !== undefined) {
    if (typeof raw.owns !== 'boolean') throw errors.schema(`${where}: \`owns\` is a boolean`)
    if (raw.owns) field.owns = true
  }
  if (raw.cascade !== undefined) {
    if (typeof raw.cascade !== 'boolean' || (raw.cascade && field.kind !== 'tree')) throw errors.schema(`${where}: cascade requires a tree and a boolean`)
    if (raw.cascade) field.cascade = true
  }
  if (raw.position !== undefined) {
    if (typeof raw.position !== 'boolean') throw errors.schema(`${where}: \`position\` is a boolean`)
    if (raw.position) field.position = true
  }
  if (raw.display !== undefined && raw.display !== null) {
    const display = raw.display
    const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
    if (!isRecord(display) || display.kind !== 'time' || !positive(display.perSecond) || (display.fps !== undefined && display.fps !== null && !positive(display.fps))) {
      throw errors.schema(`${where}: \`display\` is { kind: "time", perSecond, fps? } with positive numbers`)
    }
    onlyKeys(`${where} display`, display, ['kind', 'perSecond', 'fps'])
    field.display = { kind: 'time', perSecond: display.perSecond as number, ...(positive(display.fps) ? { fps: display.fps as number } : {}) }
  }
  if (raw.sample !== undefined && raw.sample !== null) {
    if (typeof raw.sample !== 'boolean') throw errors.schema(`${where}: \`sample\` is a boolean`)
    field.sample = raw.sample
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
  const declaredTypes = raw.types
  const types: Record<string, TypeDef> = {}
  for (const ty of sortedKeys(raw.types)) {
    const def = raw.types[ty]
    if (!isRecord(def)) throw errors.schema(`type \`${ty}\` is an object`)
    onlyKeys(`type \`${ty}\``, def, ['fields', 'projected', 'projectedOps', 'batchOps', 'creation', 'readOnly', 'readOnlyWhen', 'toolId', 'pathName', 'label', 'derived', 'text', 'batchIndependent', 'moveConsequences', 'structuralConsequences'])
    if (!isRecord(def.fields)) throw errors.schema(`type \`${ty}\` needs \`fields\``)
    const fields: Record<string, FieldDef> = {}
    for (const name of sortedKeys(def.fields)) setKey(fields, name, readField(`\`${ty}.${name}\``, def.fields[name]))
    const out: TypeDef = { fields }
    if (def.projected !== undefined) {
      if (typeof def.projected !== 'boolean') throw errors.schema(`type \`${ty}\`: projected is a boolean`)
      if (def.projected) out.projected = true
    }
    if (def.projectedOps !== undefined) {
      if (!out.projected || !isRecord(def.projectedOps)) throw errors.schema(`type \`${ty}\`: projectedOps requires projected:true`)
      const mappings: NonNullable<TypeDef['projectedOps']> = {}
      for (const [op, mapping] of Object.entries(def.projectedOps)) {
        if (!op || !isRecord(mapping) || typeof mapping.command !== 'string' || !mapping.command
          || Object.keys(mapping).some(key => !['command', 'params'].includes(key))
          || (mapping.params !== undefined && (!isRecord(mapping.params) || Object.entries(mapping.params).some(([name, path]) => !name || typeof path !== 'string' || path.split('.').some(part => !part))))) {
          throw errors.schema(`type \`${ty}\`: projectedOps needs an operation, command and parameter paths`)
        }
        setKey(mappings, op, { command: mapping.command, ...(isRecord(mapping.params) ? { params: { ...mapping.params } as Record<string, string> } : {}) })
      }
      if (Object.keys(mappings).length) out.projectedOps = mappings
    }
    if (def.structuralConsequences !== undefined) {
      const rules = def.structuralConsequences
      if (!Array.isArray(rules) || rules.some(rule => !isRecord(rule)
        || Object.keys(rule).some(key => !['container', 'on', 'fields'].includes(key))
        || typeof rule.container !== 'string' || !Object.hasOwn(declaredTypes, rule.container)
        || !Array.isArray(rule.on) || !rule.on.length || rule.on.some((action: unknown) => !['create', 'delete', 'move', 'rename'].includes(action as string)
          && !(action === 'set' && Object.values(declaredTypes).some(type => isRecord(type) && type.projected === true)))
        || !Array.isArray(rule.fields) || !rule.fields.length || rule.fields.some((path: unknown) => typeof path !== 'string'
          || path.split('.').some(part => !part) || !fields[path.split('.')[0]]
          || (path.includes('.') && !['json', 'map'].includes(fields[path.split('.')[0]].kind)))
      )) throw errors.schema(`type \`${ty}\`: structuralConsequences needs a declared container, structural actions and stored field paths`)
      if (rules.length) out.structuralConsequences = rules.map(rule => ({ container: rule.container, on: [...rule.on], fields: [...rule.fields] }))
    }
    if (def.moveConsequences !== undefined) {
      if (!Array.isArray(def.moveConsequences) || def.moveConsequences.some((path: unknown) => {
        if (typeof path !== 'string' || path.split('.').some(part => !part)) return true
        const field = fields[path.split('.')[0]]
        return !field?.position || (path.includes('.') && field.kind !== 'json')
      })) throw errors.schema(`type \`${ty}\`: moveConsequences must name position fields or their JSON members`)
      if (def.moveConsequences.length) out.moveConsequences = [...def.moveConsequences] as string[]
    }
    if (def.creation !== undefined) {
      if (!isRecord(def.creation)) throw errors.schema('creation is an object')
      onlyKeys('creation',def.creation,['fields','command','fixtures'])
      for (const name of ['fields','fixtures']) if (def.creation[name] !== undefined && !isRecord(def.creation[name])) throw errors.schema(`creation.${name} is an object`)
      const command=def.creation.command
      if (command !== undefined) {
        if (!isRecord(command) || typeof command.command !== 'string' || !command.command) throw errors.schema('creation command required')
        onlyKeys('creation command',command,['command','params'])
        if (command.params !== undefined && (!isRecord(command.params) || Object.entries(command.params).some(([name,path])=>!name || typeof path!=='string' || path.split('.').some(part=>!part)))) throw errors.schema('invalid creation command paths')
      }
      out.creation=structuredClone(def.creation) as TypeDef['creation']
    }
    if (def.batchOps !== undefined) {
      if (!isRecord(def.batchOps)) throw errors.schema(`type \`${ty}\`: batchOps is a mapping`)
      const mappings: NonNullable<TypeDef['batchOps']> = {}
      for (const [op, mapping] of Object.entries(def.batchOps)) {
        if (!op || !isRecord(mapping)) throw errors.schema('invalid batchOps operation')
        if (mapping.direct === true) {
          onlyKeys('direct batchOps', mapping, ['direct'])
          mappings[op] = { direct: true }
        } else {
          onlyKeys('command batchOps', mapping, ['command', 'params'])
          if (typeof mapping.command !== 'string' || !mapping.command || (mapping.params !== undefined && (!isRecord(mapping.params) || Object.entries(mapping.params).some(([name, path]) => !name || typeof path !== 'string' || path.split('.').some((part) => !part))))) throw errors.schema('invalid batchOps command')
          mappings[op] = { command: mapping.command, params: mapping.params as Record<string, string> | undefined }
        }
      }
      out.batchOps = mappings
    }
    if (def.batchIndependent !== undefined) {
      if (typeof def.batchIndependent !== 'boolean') throw errors.schema(`type \`${ty}\`: \`batchIndependent\` is a boolean`)
      if (def.batchIndependent) out.batchIndependent = true
    }
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
    if (def.toolId !== undefined && def.toolId !== null) {
      const tool = def.toolId
      if (!isRecord(tool)) throw errors.schema(`type \`${ty}\`: \`toolId\` is { field, prefix?, parent? }`)
      onlyKeys(`type \`${ty}\` toolId`, tool, ['field', 'prefix', 'parent'])
      if (typeof tool.field !== 'string') throw errors.schema(`type \`${ty}\`: \`toolId.field\` is a field name`)
      if (tool.prefix !== undefined && typeof tool.prefix !== 'string') throw errors.schema(`type \`${ty}\`: \`toolId.prefix\` is a string`)
      if (tool.parent !== undefined && tool.parent !== null && typeof tool.parent !== 'string') throw errors.schema(`type \`${ty}\`: \`toolId.parent\` is a type name`)
      out.toolId = { field: tool.field, prefix: typeof tool.prefix === 'string' ? tool.prefix : '', ...(typeof tool.parent === 'string' ? { parent: tool.parent } : {}) }
    }
    if (def.pathName !== undefined && def.pathName !== null) {
      const path = def.pathName
      const kind = typeof path === 'string' ? fields[path.split('.')[0]]?.kind : undefined
      const fits = kind === 'json' || ((kind === 'string' || kind === 'enum') && typeof path === 'string' && !path.includes('.'))
      if (typeof path !== 'string' || !fits) throw errors.schema(`type \`${ty}\`: \`pathName\` \`${String(path)}\` names no string or enum field, nor a member of a json field`)
      out.pathName = path
    }
    for (const name of ['label', 'text'] as const) if (def[name] !== undefined && def[name] !== null) {
      const path = def[name]
      const kind = typeof path === 'string' ? fields[path.split('.')[0]]?.kind : undefined
      const fits = kind === 'json' || ((kind === 'string' || kind === 'text' || kind === 'enum') && typeof path === 'string' && !path.includes('.'))
      if (typeof path !== 'string' || !fits) throw errors.schema(`type \`${ty}\`: \`${name}\` \`${String(path)}\` names no string, text or enum field, nor a member of a json field`)
      out[name] = path
    }
    if (def.derived !== undefined && def.derived !== null) {
      if (!isRecord(def.derived)) throw errors.schema(`type \`${ty}\`: \`derived\` is an object of names`)
      const derived: Record<string, DerivedDef> = {}
      for (const name of sortedKeys(def.derived)) {
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw errors.schema(`type \`${ty}\`: derived \`${name}\` is no name (ASCII letters, digits and \`_\`)`)
        const one = def.derived[name]
        if (!isRecord(one)) throw errors.schema(`type \`${ty}\`: derived \`${name}\` is { description? }`)
        onlyKeys(`type \`${ty}\` derived \`${name}\``, one, ['description', 'premiseOnly', 'onDemand'])
        if (one.description !== undefined && typeof one.description !== 'string') throw errors.schema(`type \`${ty}\`: derived \`${name}\`.description is a string`)
        if (one.premiseOnly !== undefined && typeof one.premiseOnly !== 'boolean') throw errors.schema(`type \`${ty}\`: derived \`${name}\`.premiseOnly is a boolean`)
        if (one.onDemand !== undefined && typeof one.onDemand !== 'boolean') throw errors.schema(`type \`${ty}\`: derived \`${name}\`.onDemand is a boolean`)
        if (one.onDemand && !one.premiseOnly) throw errors.schema(`type \`${ty}\`: onDemand derived facts require premiseOnly`)
        setKey(derived, name, { ...(typeof one.description === 'string' ? { description: one.description } : {}), ...(one.premiseOnly ? { premiseOnly: true } : {}), ...(one.onDemand ? {onDemand:true} : {}) })
      }
      if (Object.keys(derived).length > 0) out.derived = derived
    }
    setKey(types, ty, out)
  }
  return { kdm: raw.kdm, kit: raw.kit, schemaVersion: raw.schemaVersion, root: raw.root, types }
}

/** The rules of the Rust `Schema::check`, in the same order. */
function checkSchema(schema: Schema): void {
  if (schema.kdm !== KDM_VERSION) throw errors.schema(`kdm ${schema.kdm} is not supported; this build reads ${KDM_VERSION}`)
  if (!Object.hasOwn(schema.types, schema.root)) throw errors.schema(`root type \`${schema.root}\` is not declared`)
  if (schema.types[schema.root].projected) throw errors.schema('the root type cannot be projected')
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
    if (def.toolId !== undefined) checkToolId(schema, ty, def.toolId)
    for (const name of sortedKeys(def.fields)) {
      const field = def.fields[name]
      if (name.startsWith('$') || name.startsWith('~')) throw errors.schema(`\`${ty}.${name}\`: names starting with \`$\` or \`~\` are reserved`)
      const takesOf = TAKES_OF.includes(field.kind)
      const typedMap = field.kind === 'map' && field.owns === true
      if (field.of !== undefined && !takesOf && !typedMap) throw errors.schema(`\`${ty}.${name}\`: only ref, list, and tree fields take \`of\``)
      if (field.owns && (field.kind === 'list' || field.kind === 'tree')) {
        throw errors.schema(`\`${ty}.${name}\`: only ref fields take \`owns\` (list and tree fields always own their items)`)
      }
      if (field.owns && field.kind !== 'ref' && field.kind !== 'map') throw errors.schema(`\`${ty}.${name}\`: only ref and map fields take \`owns\``)
      if (field.values?.length && field.kind !== 'enum') throw errors.schema(`\`${ty}.${name}\`: only enum fields take \`values\``)
      if (field.kind === 'enum' && !field.values?.length) throw errors.schema(`\`${ty}.${name}\`: an enum needs \`values\``)
      if (takesOf || (typedMap && field.of !== undefined)) {
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

/** As the Rust `Schema::check_tool_id` (rule OM9). */
function checkToolId(schema: Schema, ty: string, tool: ToolIdDef): void {
  const bad = (reason: string) => errors.schema(`type \`${ty}\`: \`toolId\` ${reason}`)
  const fields = schema.types[ty].fields
  if (!Object.hasOwn(fields, tool.field)) throw bad(`names undeclared field \`${tool.field}\``)
  const field = fields[tool.field]
  if (field.kind !== 'integer' && field.kind !== 'string') throw bad(`names \`${tool.field}\`, which is not an integer or a string`)
  if (!field.readOnly) throw bad(`names \`${tool.field}\`, which is not \`readOnly\`: only the kit writes an object's tool id`)
  const reason = badPrefix(tool.prefix)
  if (reason !== null) throw bad(`prefix \`${tool.prefix}\`: ${reason}`)
  const parent = tool.parent
  if (parent === undefined) return
  if (!Object.hasOwn(schema.types, parent)) throw bad(`names undeclared parent type \`${parent}\``)
  const parentDef = schema.types[parent]
  if (parentDef.toolId === undefined) throw bad(`names parent \`${parent}\`, which declares no \`toolId\``)
  if (!Object.values(parentDef.fields).some((field) => (field.kind === 'list' || field.kind === 'tree' || field.kind === 'ref' || (field.kind === 'map' && field.owns)) && field.of === ty)) {
    throw bad(`names parent \`${parent}\`, which has no list, tree, or ref field of \`${ty}\``)
  }
  // A chain of parents that comes back to this type; a loop elsewhere is its own types' error.
  const seen: string[] = []
  let next: string | undefined = parent
  while (next !== undefined) {
    if (next === ty) throw bad(`parent \`${parent}\` leads back to \`${ty}\`: parents form no cycle`)
    if (seen.includes(next)) break
    seen.push(next)
    next = Object.hasOwn(schema.types, next) ? schema.types[next].toolId?.parent : undefined
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
  checkLimits(ty, field, json, def)
  if (def.members !== undefined && Object.keys(def.members).length > 0) {
    for (const [path, limits] of Object.entries(def.members)) for (const value of memberValues(json, path)) {
      if (Array.isArray(value) || isRecord(value) || (value === null && limits.nullable)) continue
      if (typeof value !== 'number') throw errors.invalidValue(ty, field, 'bounded members require a number or an explicitly nullable null')
      checkLimits(ty, field, value, limits)
    }
  }
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
  if (!ok && def.kind === 'enum') throw errors.invalidValue(ty, field, enumRefusal(def.values ?? [], json))
  if (!ok) throw errors.invalidValue(ty, field, `expects ${/^[aeiou]/.test(def.kind) ? 'an' : 'a'} ${def.kind} value`)
  return json
}

function memberValues(value: JsonValue, path: string): JsonValue[] {
  if (path === '') return [value]
  const end = path.search(/[.\[]/)
  const name = end < 0 ? path : path.slice(0, end)
  if (name === '*') return isRecord(value) ? Object.values(value).flatMap((value) => memberValues(value as JsonValue, path.slice(name.length))) : []
  if (name !== '') return isRecord(value) && Object.hasOwn(value, name) ? memberValues(value[name] as JsonValue, path.slice(name.length)) : []
  if (path.startsWith('[]')) return Array.isArray(value) ? value.flatMap((item) => memberValues(item, path.slice(2))) : []
  return path.startsWith('.') ? memberValues(value, path.slice(1)) : []
}

function checkLimits(ty: string, field: string, value: JsonValue, limits: { minimum?: number; maximum?: number; multipleOf?: number }): void {
  if (typeof value !== 'number') return
  const units = limits.multipleOf !== undefined ? value / limits.multipleOf : 0
  if ((limits.minimum !== undefined && value < limits.minimum) || (limits.maximum !== undefined && value > limits.maximum) || !Number.isFinite(units) || Math.abs(units - Math.round(units)) > 1e-9) throw errors.invalidValue(ty, field, 'is outside minimum/maximum or is not a multipleOf the declared step')
}

export function checkMapEntry(schema: Schema, ty: string, field: string, key: string, value: JsonValue): void {
  const def = fieldDef(schema, ty, field)
  if (def.of !== undefined && (typeof value !== 'string' || value === '')) throw errors.invalidValue(ty, field, `map entry \`${key}\` expects the id of a \`${def.of}\``)
  for (const [path, limits] of Object.entries(def.members ?? {})) {
    for (const leaf of memberValues({ [key]: value }, path)) {
      if (Array.isArray(leaf) || isRecord(leaf) || (leaf === null && limits.nullable)) continue
      if (typeof leaf !== 'number') throw errors.invalidValue(ty, field, `map entry \`${key}\` requires a number`)
      checkLimits(ty, field, leaf, limits)
    }
  }
}

/** How many of an enum's values a refusal lists before it counts the rest. */
const ENUM_VALUES_SHOWN = 20

/** As the Rust `enum_refusal`: why `value` is not one of an enum's `values`, naming them (KHP A48). */
function enumRefusal(values: readonly string[], value: JsonValue): string {
  const shown = values.slice(0, ENUM_VALUES_SHOWN).map((one) => `\`${one}\``)
  const more = Math.max(0, values.length - ENUM_VALUES_SHOWN)
  const rest = more > 0 ? `, and ${more} more (\`describe\` lists them all)` : ''
  const given =
    typeof value === 'string'
      ? `\`${value}\``
      : typeof value === 'number'
        ? 'a number'
        : typeof value === 'boolean'
          ? 'a boolean'
          : Array.isArray(value)
            ? 'an array'
            : value === null
              ? 'null'
              : 'an object'
  return `takes one of ${shown.join(', ')}${rest}, not ${given}`
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
