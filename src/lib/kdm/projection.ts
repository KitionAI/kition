// Copied from kition-sdk packages/kdm/src/projection.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { BatchError, type LoadedObject } from './batch'
import type { Replica } from './replica'
import { checkValue, type Schema } from './schema'
import { ToolIds } from './toolIds'

export interface ProjectedObject {
  id: string
  type: string
  fields: Record<string, unknown>
  at?: { parent: string; field: string; index?: number; node?: string }
}

export const hasProjections = (schema: Schema): boolean => Object.values(schema.types).some(def => def.projected)
const invalid = (message: string) => new BatchError('invalid-value', null, message)
const set = (object: object, key: string, value: unknown) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
const virtualContainer = (schema: Schema, field: Schema['types'][string]['fields'][string]) =>
  (field.kind === 'list' || field.kind === 'tree' || field.kind === 'ref' && field.owns) && !!field.of && !!schema.types[field.of]?.projected

/** A computed read view; never writes to the replica. */
export class ProjectionView {
  readonly state: { objects: Record<string, Record<string, unknown>> }
  readonly objects = new Map<string, ProjectedObject>()

  constructor(replica: Replica, projected: ProjectedObject[]) {
    this.state = ToolIds.ofReplica(replica).showJson(replica.stateJson()) as typeof this.state
    const stored = this.state.objects
    const schema = replica.schema
    for (const object of projected) {
      if (!object.id || object.id === 'root' || object.id.startsWith('$') || Object.hasOwn(stored, object.id) || this.objects.has(object.id)) {
        throw invalid(`projected id \`${object.id}\` is reserved, duplicated or shadows a stored object`)
      }
      const def = Object.hasOwn(schema.types, object.type) ? schema.types[object.type] : undefined
      if (!def?.projected) throw invalid(`\`${object.type}\` is not a projected type`)
      for (const [name, value] of Object.entries(object.fields)) {
        const field = Object.hasOwn(def.fields, name) ? def.fields[name] : undefined
        if (!field) throw invalid(`unknown projected field \`${object.type}.${name}\``)
        let valid: boolean
        if (field.kind === 'text') valid = typeof value === 'string' || (!!field.marks && Object.keys(field.marks).length > 0 && Array.isArray(value))
        else if (field.kind === 'list' || field.kind === 'tree') valid = Array.isArray(value)
        else if (field.kind === 'map') valid = typeof value === 'object' && value !== null && !Array.isArray(value)
        else { try { checkValue(schema, object.type, name, value); valid = true } catch { valid = false } }
        if (!valid) throw invalid(`invalid projected value \`${object.type}.${name}\``)
      }
      for (const [name, field] of Object.entries(def.fields)) {
        const virtual = virtualContainer(schema, field)
        if (!field.optional && !virtual && !Object.hasOwn(object.fields, name)) throw invalid(`missing projected field \`${object.type}.${name}\``)
      }
      set(stored, object.id, { ...structuredClone(object.fields), $type: object.type })
      this.objects.set(object.id, structuredClone(object))
    }
    const containers = new Map<string, { parent: string; field: string; kind: string; groups: Map<string | undefined, Array<[number, string]>> }>()
    const key = (parent: string, field: string) => JSON.stringify([parent, field])
    for (const [id, object] of Object.entries(stored)) {
      for (const [name, field] of Object.entries(schema.types[object.$type as string].fields)) {
        if (virtualContainer(schema, field)) {
          if (object[name] !== null && object[name] !== undefined && (!Array.isArray(object[name]) || object[name].length)) throw invalid(`\`${id}.${name}\`: projected membership must come from object placements`)
          containers.set(key(id, name), { parent: id, field: name, kind: field.kind, groups: new Map() })
        }
      }
    }
    for (const object of this.objects.values()) {
      if (!object.at) continue
      const at = object.at
      const container = containers.get(key(at.parent, at.field))
      if (!container) throw invalid(`\`${object.id}\` has no projected container \`${at.parent}.${at.field}\``)
      if (at.node !== undefined) {
        const parent = this.objects.get(at.node)?.at
        if (container.kind !== 'tree' || parent?.parent !== at.parent || parent.field !== at.field) throw invalid('projected tree parent belongs to another container')
      }
      const parent = stored[at.parent]
      if (schema.types[parent.$type as string].fields[at.field].of !== object.type) throw invalid(`projected placement has the wrong type for \`${object.id}\``)
      const index = at.index ?? 0
      if (!Number.isSafeInteger(index) || index < 0) throw invalid('projected index is a nonnegative integer')
      const siblings = container.groups.get(at.node) ?? []
      siblings.push([index, object.id])
      container.groups.set(at.node, siblings)
    }
    for (const { parent, field, kind, groups } of containers.values()) {
      for (const items of groups.values()) {
        items.sort(([a, aid], [b, bid]) => a - b || aid.localeCompare(bid))
        if (items.some(([at], index) => at !== index)) throw invalid(`\`${parent}.${field}\`: projected indexes must be contiguous and unique`)
      }
      const roots = groups.get(undefined) ?? []
      let value: unknown
      if (kind === 'ref') {
        if (roots.length > 1) throw invalid('a projected owning ref holds at most one object')
        value = roots[0]?.[1] ?? null
      } else if (kind === 'tree') {
        const seen = new Set<string>()
        const tree = (node: string | undefined, depth: number): unknown[] => {
          if (depth > 64) throw invalid('projected tree exceeds depth limit')
          return (groups.get(node) ?? []).map(([, id]) => {
            if (seen.has(id)) throw invalid('projected placements contain a cycle')
            seen.add(id)
            return { object: id, children: tree(id, depth + 1) }
          })
        }
        value = tree(undefined, 0)
        if (seen.size !== [...groups.values()].reduce((total, items) => total + items.length, 0)) throw invalid('projected placements contain an unreachable tree cycle')
      } else value = roots.map(([, id]) => id)
      set(stored[parent], field, value)
    }
    for (const object of this.objects.values()) {
      const seen = new Set([object.id])
      let cursor: ProjectedObject | undefined = object
      while (cursor.at && (cursor = this.objects.get(cursor.at.parent))) {
        if (seen.has(cursor.id)) throw invalid('projected placements contain a cycle')
        seen.add(cursor.id)
      }
    }
  }

  load(root: string | null, target: string, fields?: unknown): LoadedObject {
    const id = target === 'root' ? root ?? '' : target
    if (!Object.hasOwn(this.state.objects, id)) throw new BatchError('not-found', null, `no object \`${target}\``)
    const object = this.state.objects[id]
    const wanted = fields === undefined || fields === null ? Object.keys(object).filter(name => name !== '$type') : fields
    if (!Array.isArray(wanted) || wanted.some(name => typeof name !== 'string')) throw invalid('fields lists names')
    const loaded = Object.fromEntries(wanted.map(name => {
      if (!Object.hasOwn(object, name)) throw invalid(`unknown field \`${name}\``)
      return [name, structuredClone(object[name])]
    }))
    const projected = this.objects.get(id)
    return { id, type: object.$type as string, fields: loaded, ...(projected ? { projected: true, ...(projected.at ? { at: { ...projected.at } } : {}) } : {}) }
  }
}

export function routeProjection(schema: Schema, view: ProjectionView, root: string, operation: Record<string, unknown>): { command: string; params: Record<string, unknown>; creates?: string } | undefined {
  const op = structuredClone(operation)
  let name = op.op as string
  const target = op.target === 'root' ? root : typeof op.target === 'string' ? op.target : ''
  let ty = view.objects.get(target)?.type
  if (name === 'create') ty = typeof op.type === 'string' && schema.types[op.type]?.projected ? op.type : undefined
  else if ((!ty || name === 'set' || name.startsWith('list.') || name.startsWith('tree.')) && Object.hasOwn(view.state.objects, target) && typeof op.field === 'string') {
    const parent = view.state.objects[target]
    const field = schema.types[parent.$type as string].fields[op.field]
    if (field?.of && schema.types[field.of]?.projected) {
      const parentDef=schema.types[parent.$type as string]
      if(field.readOnly || parentDef.readOnly || (parentDef.readOnlyWhen && parentDef.readOnlyWhen.values.includes(parent[parentDef.readOnlyWhen.field] as string))) throw new BatchError('read-only',null,'the projected container is read-only')
      ty = field.of
      const index = name === 'list.move' ? op.from : op.index
      const items = parent[op.field]
      const item = op.item ?? op.node ?? (field.kind === 'ref' ? op.value : undefined) ?? (Array.isArray(items) && typeof index === 'number' ? items[index] : undefined)
      if (item !== undefined) {
        op.in = `${target}.${op.field}`
        op.target = item
        if (field.kind === 'ref' && name === 'set') {
          name = 'ref.set'
          op.op = name
          delete op.field
        }
      }
    }
  }
  if (!ty) return undefined
  if (typeof op.in === 'string') {
    const dot = op.in.lastIndexOf('.')
    if (dot < 1) throw invalid('a projected destination names parent.field')
    const parentId = op.in.slice(0, dot)
    const parent = view.state.objects[parentId === 'root' ? root : parentId]
    const parentDef = parent && schema.types[parent.$type as string]
    const fieldDef = parentDef?.fields[op.in.slice(dot + 1)]
    if (!fieldDef || !virtualContainer(schema, fieldDef) || fieldDef.of !== ty) throw invalid("projected destination must own the object's type")
    if (fieldDef.readOnly || parentDef.readOnly || (parentDef.readOnlyWhen && parentDef.readOnlyWhen.values.includes(parent[parentDef.readOnlyWhen.field] as string))) throw new BatchError('read-only', null, 'the projected container is read-only')
  }
  const def = schema.types[ty]
  const field = typeof op.field === 'string' ? op.field : undefined
  const values = view.state.objects[typeof op.target==='string'?op.target:target]
  if (def.readOnly || (def.readOnlyWhen && def.readOnlyWhen.values.includes(values?.[def.readOnlyWhen.field] as string)) || (field && def.fields[field]?.readOnly)) throw new BatchError('read-only', null, `projected \`${ty}\` is read-only`)
  if (name === 'set') {
    if (!field) throw invalid('a projected set needs a field')
    try { checkValue(schema, ty, field, op.value) } catch (error) { throw invalid(String(error)) }
  }
  const mapping = (field ? def.projectedOps?.[`${name}.${field}`] : undefined) ?? def.projectedOps?.[name]
  if (!mapping) throw new BatchError('read-only', null, `no projected command mapping for \`${ty}.${name}\``)
  const params: Record<string, unknown> = {}
  for (const [parameter, path] of Object.entries(mapping.params ?? {})) {
    let value: unknown = op
    for (const key of path.split('.')) value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
    if (value !== undefined) set(params, parameter, value)
  }
  return { command: mapping.command, params, ...(name === 'create' ? { creates: ty } : {}) }
}
