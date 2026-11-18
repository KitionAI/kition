// Copied from kition-sdk packages/kdm/src/toolIds.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Tool ids (rule OM9 of `KitObjectModel`, Kition platform `docs/platform/sets/object-model.md`): the
 * ids a kit's own tools give its objects, which the object model answers and takes in place of KDM
 * object ids, so a document has one id space at the tool interface (KHP A47). The twin of the Rust
 * crate's `tool_ids` module; both run `crates/kition-kdm/tests/fixtures/tool-ids.json`.
 *
 * An object of a type declaring `toolId: { field, prefix?, parent? }` is named `<prefix><value>`
 * (its read-only `field`), after its parent's tool id and a `/` when the type declares a `parent`:
 * the object of that type holding it in a `list`, `tree`, or `ref` field. An object has a tool id
 * when its field holds a value, it has exactly one holder of its parent type that has a tool id,
 * and no other live object renders the same id. Every other object answers its KDM object id.
 *
 * An object without a tool id of its own is a part of the nearest object holding it that has one
 * (`attributed`): held through a `list` or `tree` field or a `ref` or `map` declared `owns`, one holder at each
 * step. Change sets name its changes under that object, at a path of field names and positions
 * (`body.paragraphs.0`), the way the tools' `follow` paths read.
 */
import { compareKeys } from './canonical'
import type { ObjectId } from './ids'
import type { Replica } from './replica'
import { mapHeld, owning, sortedKeys, type FieldKind, type Schema, type ToolIdDef } from './schema'

/** How many candidates a refusal lists. */
const CANDIDATES = 8

/** What the ids are read from: a replica, or a canonical state. */
interface Source {
  objectsOfType(ty: string): ObjectId[]
  /** A register's value (`null` when it holds none). */
  register(id: ObjectId, field: string): unknown
  /** The live objects a `list`, `tree`, or `ref` field of `owner` holds. */
  held(owner: ObjectId, field: string, kind: FieldKind): ObjectId[]
  /** A `map` field's entries, as an object. */
  map(owner: ObjectId, field: string): unknown
  /** Whether `id` names a live object. */
  exists(id: ObjectId): boolean
}

const attempt = <T>(read: () => T, fallback: T): T => {
  try {
    return read()
  } catch {
    return fallback
  }
}

function replicaSource(replica: Replica): Source {
  return {
    objectsOfType: (ty) => replica.objectsOfType(ty),
    register: (id, field) => attempt(() => replica.get(id, field), null),
    held: (owner, field, kind) => {
      if (kind === 'list') return attempt(() => replica.list(owner, field), [])
      if (kind === 'tree') return attempt(() => replica.tree(owner, field), []).map((entry) => entry.object).filter((object) => replica.exists(object))
      if (kind === 'ref') {
        const value = attempt(() => replica.get(owner, field), null)
        return typeof value === 'string' ? [value] : []
      }
      return []
    },
    map: (owner, field) => Object.fromEntries(attempt(() => replica.mapEntries(owner, field), [])),
    exists: (id) => replica.exists(id),
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function stateSource(state: unknown): Source {
  const objects: Json = isObject(state) && isObject(state.objects) ? state.objects : {}
  const register = (id: ObjectId, field: string): unknown => {
    const object = Object.hasOwn(objects, id) ? objects[id] : undefined
    return isObject(object) && Object.hasOwn(object, field) ? object[field] : null
  }
  const treeObjects = (nodes: unknown, out: ObjectId[]) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!isObject(node)) continue
      if (typeof node.object === 'string') out.push(node.object)
      treeObjects(node.children, out)
    }
  }
  return {
    objectsOfType: (ty) => Object.keys(objects).filter((id) => isObject(objects[id]) && (objects[id] as Json).$type === ty).sort(compareKeys),
    register,
    held: (owner, field, kind) => {
      const value = register(owner, field)
      const out: ObjectId[] = []
      if (kind === 'list' && Array.isArray(value)) out.push(...value.filter((item): item is string => typeof item === 'string'))
      else if (kind === 'tree') treeObjects(value, out)
      else if (kind === 'ref' && typeof value === 'string') out.push(value)
      return out.filter((id) => Object.hasOwn(objects, id))
    },
    map: (owner, field) => register(owner, field),
    exists: (id) => Object.hasOwn(objects, id),
  }
}

/** One object's tool id as rendered: its type, the id, and the value it ends with. */
type Named = { id: ObjectId; type: string; value: string }

/** An object holding another through an owning field: the holder, the field, and its place there: a position in a list or tree (depth-first), a map's key (and member), nothing for a ref. */
type Holder = { owner: ObjectId; field: string; at: string | null; name: string | null }

/**
 * As the Rust `path_names`: the names the items of one list have in a path when their type declares
 * a `pathName`: that field's text (or a member of its json value); `#<n>` when it is empty, a
 * number, or holds `/`, `.`, `#` or `@`; `<name>#<n>` for the n-th item of one name after the first.
 */
function pathNames(schema: Schema, source: Source, items: Array<[ObjectId, string | undefined]>): Array<string | null> {
  const raw: Array<{ text: string | null } | null> = items.map(([id, ty]) => {
    const declared = ty === undefined ? undefined : schema.types[ty]?.pathName
    if (declared === undefined) return null
    const [first, ...members] = declared.split('.')
    let value: unknown = source.register(id, first)
    for (const member of members) value = isObject(value) ? (value as Record<string, unknown>)[member] ?? null : null
    return { text: typeof value === 'string' ? value : null }
  })
  return raw.map((name, index) => {
    if (name === null) return null
    const text = name.text
    const safe = text !== null && text !== '' && !/[/.#@]/.test(text) && !/^\d+$/.test(text) ? text : null
    if (safe === null) return `#${index + 1}`
    const before = raw.slice(0, index).filter((other) => other !== null && other.text === safe).length
    return before === 0 ? safe : `${safe}#${before + 1}`
  })
}

/** Why a target names no single object. */
export type Unresolved = { reason: 'not-found' | 'ambiguous'; message: string }

/** A field value as the end of a tool id: an integer's digits, or a non-empty string. */
function valueText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value === 'string' && value !== '') return value
  return null
}

/** The value a typed id ends with: what follows its last `:` or `/`. */
const valuePart = (text: string): string => text.split(/[:/]/).pop() ?? text

/** `a`, `b`, and `c`, each in backticks (as the Rust `listed`). */
function listed(items: string[]): string {
  const quoted = items.map((item) => `\`${item}\``)
  if (quoted.length <= 1) return quoted.join('')
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/** The tool ids of one document state. */
export class ToolIds {
  private constructor(
    /** Whether the schema declares any tool id; when not, every method answers object ids. */
    private readonly active: boolean,
    /** Each object's tool id, when it is its own. */
    private readonly own: Map<ObjectId, string>,
    /** Every rendered tool id to the objects rendering it. */
    private readonly named: Map<string, Named[]>,
    /** Each object held through an owning field: its holders. */
    private readonly owners: Map<ObjectId, Holder[]>,
  ) {}

  static none(): ToolIds {
    return new ToolIds(false, new Map(), new Map(), new Map())
  }

  /** The tool ids of a replica's current state. */
  static ofReplica(replica: Replica): ToolIds {
    return ToolIds.build(replica.schema, replicaSource(replica))
  }

  /** The tool ids of a canonical state (`Replica.stateJson`) read with `schema`. */
  static ofState(schema: Schema, state: unknown): ToolIds {
    return ToolIds.build(schema, stateSource(state))
  }

  private static build(schema: Schema, source: Source): ToolIds {
    const declared: Array<[string, ToolIdDef]> = sortedKeys(schema.types).flatMap((ty) => {
      const tool = schema.types[ty].toolId
      return tool ? [[ty, tool] as [string, ToolIdDef]] : []
    })
    if (declared.length === 0) return ToolIds.none()
    const parts = new Map<ObjectId, { type: string; tool: ToolIdDef; value: string }>()
    for (const [ty, tool] of declared) {
      for (const id of source.objectsOfType(ty)) {
        const value = valueText(source.register(id, tool.field))
        if (value !== null) parts.set(id, { type: ty, tool, value })
      }
    }
    const holders = new Map<ObjectId, ObjectId[]>()
    for (const [ty, tool] of declared) {
      const parent = tool.parent
      if (parent === undefined || !Object.hasOwn(schema.types, parent)) continue
      const parentDef = schema.types[parent]
      for (const field of sortedKeys(parentDef.fields)) {
        const def = parentDef.fields[field]
        if (!(def.kind === 'list' || def.kind === 'tree' || def.kind === 'ref') || def.of !== ty) continue
        for (const owner of source.objectsOfType(parent)) {
          for (const child of source.held(owner, field, def.kind)) {
            const entry = holders.get(child) ?? []
            if (!entry.includes(owner)) entry.push(owner)
            holders.set(child, entry)
          }
        }
      }
    }
    const full = new Map<ObjectId, string | null>()
    const rendered = (id: ObjectId, depth: number): string | null => {
      const known = full.get(id)
      if (known !== undefined) return known
      const part = parts.get(id)
      let text: string | null = null
      if (part !== undefined) {
        const own = `${part.tool.prefix}${part.value}`
        if (part.tool.parent === undefined) text = own
        else {
          const holder = holders.get(id)
          if (holder !== undefined && holder.length === 1 && depth <= 64) {
            const parent = rendered(holder[0], depth + 1)
            if (parent !== null) text = `${parent}/${own}`
          }
        }
      }
      full.set(id, text)
      return text
    }
    for (const id of [...parts.keys()].sort(compareKeys)) rendered(id, 0)
    const named = new Map<string, Named[]>()
    for (const [id, text] of full) {
      const part = parts.get(id)
      if (text === null || part === undefined) continue
      const list = named.get(text) ?? []
      list.push({ id, type: part.type, value: part.value })
      named.set(text, list)
    }
    const own = new Map<ObjectId, string>()
    const sorted = new Map<string, Named[]>()
    for (const text of [...named.keys()].sort(compareKeys)) {
      const objects = named.get(text)!.sort((a, b) => compareKeys(a.type, b.type) || compareKeys(a.id, b.id))
      sorted.set(text, objects)
      if (objects.length === 1) own.set(objects[0].id, text)
    }
    const owners = new Map<ObjectId, Holder[]>()
    const namedTypes = Object.values(schema.types).some((def) => def.pathName !== undefined)
    const typeOf = new Map<ObjectId, string>()
    if (namedTypes) for (const ty of sortedKeys(schema.types)) for (const id of source.objectsOfType(ty)) typeOf.set(id, ty)
    for (const ty of sortedKeys(schema.types)) {
      const fields = schema.types[ty].fields
      for (const field of sortedKeys(fields)) {
        const def = fields[field]
        if (!owning(def)) continue
        for (const owner of source.objectsOfType(ty)) {
          const held: Array<[ObjectId, string | null]> =
            def.kind === 'map'
              ? mapHeld(source.map(owner, field), (id) => source.exists(id))
              : source.held(owner, field, def.kind).map((child, index) => [child, def.kind === 'ref' ? null : String(index)])
          const names = namedTypes && def.kind === 'list' ? pathNames(schema, source, held.map(([child]) => [child, typeOf.get(child)])) : []
          held.forEach(([child, at], index) => {
            const entry = owners.get(child) ?? []
            if (!entry.some((known) => known.owner === owner && known.field === field)) entry.push({ owner, field, at, name: names[index] ?? null })
            owners.set(child, entry)
          })
        }
      }
    }
    // A map's key made of object ids (`<row id>:<column id>`, a holder's place `<key>` or
    // `<key>.<member>`) names, in a path, each object by what the tools use: its tool id, else its
    // position in the list holding it (`0:1`), when the whole key or every segment names such an
    // object; any other key stays as it is (the Rust `ToolIds::build`).
    const name = (id: string): string | null => {
      const tool = own.get(id)
      if (tool !== undefined) return tool
      const holders = owners.get(id)
      return holders !== undefined && holders.length === 1 && holders[0].at !== null && /^\d+$/.test(holders[0].at) ? holders[0].at : null
    }
    const shown = (at: string): string | null => {
      const dot = at.indexOf('.')
      const key = dot < 0 ? at : at.slice(0, dot)
      const member = dot < 0 ? null : at.slice(dot + 1)
      let named = name(key)
      if (named === null) {
        const segments = key.split(':').map(name)
        if (segments.some((segment) => segment === null)) return null
        named = segments.join(':')
      }
      return member === null ? named : `${named}.${member}`
    }
    const renamed: Array<[Holder, string]> = []
    for (const holders of owners.values()) {
      for (const holder of holders) {
        const next = holder.at === null ? null : shown(holder.at)
        if (next !== null) renamed.push([holder, next])
      }
    }
    for (const [holder, next] of renamed) holder.at = next
    return new ToolIds(true, own, sorted, owners)
  }

  /**
   * As the Rust `ToolIds::attributed`: for an object without a tool id of its own, the nearest
   * object holding it that has one and the path from it (`body.paragraphs.0`); `null` for an object
   * with a tool id, without tool ids in the schema, or when an object on the way has no single holder.
   */
  attributed(id: ObjectId): { holder: string; path: string } | null {
    if (!this.active || this.own.has(id)) return null
    const segments: string[] = []
    let current = id
    for (let step = 0; step < 64; step += 1) {
      const holders = this.owners.get(current)
      if (holders === undefined || holders.length !== 1) return null
      const [holder] = holders
      if (holder.at !== null) segments.push(holder.at)
      segments.push(holder.field)
      const tool = this.own.get(holder.owner)
      if (tool !== undefined) return { holder: tool, path: segments.reverse().join('.') }
      current = holder.owner
    }
    return null
  }

  /**
   * As the Rust `ToolIds::named_path`: `attributed`'s path in the words of the kit's commands, the names
   * of the objects on the way whose type declares a `pathName` joined by `/`, then the path below the
   * last of them; `null` when no object on the way is named so.
   */
  namedPath(id: ObjectId): string | null {
    if (!this.active || this.own.has(id)) return null
    const names: string[] = []
    const below: string[] = []
    let current = id
    for (let step = 0; step < 64; step += 1) {
      const holders = this.owners.get(current)
      if (holders === undefined || holders.length !== 1) return null
      const [holder] = holders
      if (holder.name !== null) names.push(holder.name)
      else if (names.length === 0) {
        if (holder.at !== null) below.push(holder.at)
        below.push(holder.field)
      }
      if (this.own.has(holder.owner)) {
        if (names.length === 0) return null
        const out = names.reverse().join('/')
        return below.length === 0 ? out : `${out}.${below.reverse().join('.')}`
      }
      current = holder.owner
    }
    return null
  }

  /** The type of the object a tool id names, when it names one. */
  typeOf(toolId: string): string | null {
    const named = this.named.get(toolId)
    return named !== undefined && named.length === 1 ? named[0].type : null
  }

  /** Whether the schema declares tool ids. */
  isActive(): boolean {
    return this.active
  }

  /** The object's tool id, when it has one of its own. */
  toolId(id: ObjectId): string | null {
    return this.own.get(id) ?? null
  }

  /** How the object is named at the tool interface: its tool id, else its object id. */
  showJson(value: unknown): unknown {
    if (typeof value === 'string') return this.show(value)
    if (Array.isArray(value)) return value.map((item) => this.showJson(item))
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      this.toolId(key) ?? key.split(':').map((part) => this.show(part)).join(':'), this.showJson(item),
    ]))
    return value
  }

  show(id: ObjectId): string {
    return this.own.get(id) ?? id
  }

  /** References in marks share the tool id space; inserted characters stay literal. */
  showText(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    return value.map(run => isObject(run) && Object.hasOwn(run, 'attributes')
      ? { ...run, attributes: this.showJson(run.attributes) } : run)
  }

  /**
   * The object `text` names: a tool id, else an object id for which `exists` holds; an `Unresolved`
   * when it names none or several. Without declared tool ids, `text` as an object id.
   */
  resolve(text: string, exists: (id: ObjectId) => boolean): ObjectId | Unresolved {
    if (!this.active) return text
    const many = this.named.get(text)
    if (many !== undefined && many.length === 1) return many[0].id
    if (many !== undefined && many.length > 1) {
      const objects = many.map((named) => `the \`${named.type}\` \`${named.id}\``)
      const joined = `${objects.slice(0, -1).join(', ')} and ${objects[objects.length - 1]}`
      return {
        reason: 'ambiguous',
        message: `\`${text}\` names ${many.length} objects (${joined}), so it names none of them: give one of their object ids, which they answer until the kit gives each an id of its own`,
      }
    }
    if (exists(text)) return text
    return { reason: 'not-found', message: this.notFound(text) }
  }

  /** Why `text` names no object, with the ids it may have meant (KHP A44, A48). */
  notFound(text: string): string {
    const value = valuePart(text)
    const sameValue = [...this.named.entries()].filter(([, objects]) => objects.some((named) => named.value === value)).map(([id]) => id)
    if (sameValue.length > 0) {
      const shown = sameValue.slice(0, CANDIDATES)
      const more = sameValue.length > shown.length ? `, and ${sameValue.length - shown.length} more` : ''
      return `no object has the id \`${text}\`; these end in \`${value}\`: ${listed(shown)}${more} (an id is written whole, as query and load answer it)`
    }
    const head = text.slice(0, text.length - value.length)
    if (head !== '') {
      const domain = [...this.named.keys()].filter((id) => id.startsWith(head))
      if (domain.length > 0 && domain.length <= CANDIDATES) return `no object has the id \`${text}\`; the ids starting \`${head}\` are ${listed(domain)}`
      if (domain.length > 0) return `no object has the id \`${text}\`; ${domain.length} ids start \`${head}\`: query or load answers them`
    }
    return `no object has the id \`${text}\`: give an id that query or load answers, \`root\`, or the \`$name\` of an object created earlier in the batch`
  }
}

/** Whether a `resolve` answer is a refusal. */
export const isUnresolved = (answer: ObjectId | Unresolved): answer is Unresolved => typeof answer !== 'string'
