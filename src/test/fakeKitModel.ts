// Copied from kition-sdk packages/script/test/fakeKitModel.ts (68dd08b, unchanged since 91cf510), which no npm package ships,
// with its imports from @kition/sdk/kdm and one statement split for this repository's lint. A kit editor's object model for tests that need no engine.
/**
 * A kit's document for tests, in plain objects: it answers `model/describe` and `model/batch` the
 * way a kit's engine does (each batch atomic and one undo step), for the ops the object model's
 * proxies send. Reads use the KDM replica's names (`get`, `text`, `list`, `tree`), so assertions
 * read as they would on a kit's replica.
 */
import { BatchError, OBJECT_MODEL_CAPABILITY, type BatchOp, type BatchRequest, type BatchResult, type LoadedObject, type Origin, type Schema } from '@kition/sdk/kdm'

type FakeObject = { type: string; fields: Record<string, unknown> }
type TreeNode = { object: string; parent: string | null }
export type FakeCommandInfo = { id: string; title?: string; mutates?: boolean; enabled?: boolean }
/** Runs a kit command inside the batch (its edits are the batch's); answers its result. */
export type FakeCommand = (id: string, params: unknown, origin: Origin, kit: FakeKitModel) => unknown

const WRITES = new Set(['create', 'set', 'delete', 'text.insert', 'text.delete', 'text.set', 'list.insert', 'list.move', 'list.remove', 'map.set', 'map.delete', 'tree.insert', 'tree.move', 'command'])

export class FakeKitModel {
  private objects = new Map<string, FakeObject>()
  private history: Array<Map<string, FakeObject>> = []
  private seq = 0
  private made = 0
  private readonly listeners = new Set<(version: Uint8Array) => void>()

  constructor(
    readonly schema: Schema,
    readonly rootId: string,
    rootFields: Record<string, unknown>,
    private readonly options: { readOnly?: boolean; commands?: FakeCommandInfo[]; command?: FakeCommand } = {},
  ) {
    this.objects.set(rootId, { type: schema.root, fields: { ...this.defaults(schema.root), ...rootFields } })
  }

  // Reads.
  exists(id: string) {
    return this.objects.has(id)
  }
  get(id: string, field: string): unknown {
    return this.object(id).fields[field] ?? null
  }
  text(id: string, field: string): string {
    return String(this.object(id).fields[field] ?? '')
  }
  list(id: string, field: string): string[] {
    return [...((this.object(id).fields[field] as string[] | undefined) ?? [])]
  }
  /** The tree in pre-order, each node with its parent. */
  tree(id: string, field: string): TreeNode[] {
    const nodes = (this.object(id).fields[field] as TreeNode[] | undefined) ?? []
    const out: TreeNode[] = []
    const walk = (parent: string | null) => {
      for (const node of nodes) {
        if (node.parent !== parent) continue
        out.push({ ...node })
        walk(node.object)
      }
    }
    walk(null)
    return out
  }

  /** The document's version: how many steps it took. */
  version(): Uint8Array {
    return Uint8Array.of(0, 0, 0, this.seq)
  }

  onChanged(listener: (version: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A write outside any batch (a command's edit runs inside its batch's step). */
  set(id: string, field: string, value: unknown) {
    this.object(id).fields[field] = value
  }

  /** A person's edit in the editor: one undo step, announced. */
  edit(write: (kit: FakeKitModel) => void) {
    const before = this.copy()
    write(this)
    this.step(before)
  }

  /** Undoes the last step (a batch or a person's edit). */
  undo(): boolean {
    const before = this.history.pop()
    if (!before) return false
    this.objects = before
    this.seq += 1
    this.announce()
    return true
  }

  describe(): Record<string, unknown> {
    const { kit, schemaVersion, root, types } = this.schema
    return { capability: OBJECT_MODEL_CAPABILITY, kit, schemaVersion, root, rootId: this.rootId, types, commands: this.options.commands ?? [] }
  }

  /** `model/batch`: every op or none; a batch that writes is one step, announced before it answers. */
  async batch(request: BatchRequest): Promise<BatchResult> {
    const before = this.copy()
    const origin = request.origin ?? { kind: 'extension', principal: 'script' }
    const refs: Record<string, string> = {}
    const results: unknown[] = []
    const ops = request.ops ?? []
    let loaded: LoadedObject[]
    try {
      for (const [index, op] of ops.entries()) {
        if (this.options.readOnly && WRITES.has(op.op)) throw new BatchError('read-only', index, 'the document is read-only')
        results.push(await this.run(op, index, refs, origin))
      }
      loaded = (request.load ?? []).map((entry) => this.load(entry.target, entry.fields, refs))
    } catch (error) {
      this.objects = before
      throw error
    }
    if (ops.some((op) => WRITES.has(op.op))) this.step(before)
    return { refs, results, loaded }
  }

  private step(before: Map<string, FakeObject>) {
    this.history.push(before)
    this.seq += 1
    this.announce()
  }

  private announce() {
    const version = this.version()
    for (const listener of [...this.listeners]) listener(version)
  }

  private copy() {
    return new Map([...this.objects].map(([id, object]) => [id, structuredClone(object)]))
  }

  private object(id: string): FakeObject {
    const object = this.objects.get(id)
    if (!object) throw new Error(`no object ${id}`)
    return object
  }

  private defaults(type: string): Record<string, unknown> {
    const def = this.schema.types[type]
    const fields: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.kind === 'text') fields[name] = ''
      else if (field.kind === 'list' || field.kind === 'tree') fields[name] = []
      else if (field.kind === 'map') fields[name] = {}
    }
    return fields
  }

  private resolve(target: unknown, index: number | null, refs: Record<string, string>): string {
    const id = target === 'root' ? this.rootId : typeof target === 'string' && target.startsWith('$') ? refs[target] : target
    if (typeof id !== 'string' || !this.objects.has(id)) throw new BatchError('not-found', index, `no object ${String(target)}`)
    return id
  }

  /** Values with this batch's `$` references replaced by their ids. */
  private value(value: unknown, refs: Record<string, string>): unknown {
    if (typeof value === 'string' && value.startsWith('$') && refs[value]) return refs[value]
    if (Array.isArray(value)) return value.map((item) => this.value(item, refs))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.value(item, refs)]))
    return value
  }

  private field(id: string, field: unknown, index: number) {
    const object = this.object(id)
    if (typeof field !== 'string' || !this.schema.types[object.type].fields[field]) throw new BatchError('invalid-op', index, `${object.type} has no field ${String(field)}`)
    return { object, field }
  }

  private async run(op: BatchOp, index: number, refs: Record<string, string>, origin: Origin): Promise<unknown> {
    switch (op.op) {
      case 'create': {
        const type = String(op.type)
        if (!this.schema.types[type]) throw new BatchError('invalid-op', index, `no type ${type}`)
        const [target, name] = String(op.in).split(/\.(?=[^.]*$)/)
        const { object, field } = this.field(this.resolve(target, index, refs), name, index)
        const id = `${type.toLowerCase()}-${(this.made += 1)}`
        const fields = this.value(op.fields ?? {}, refs) as Record<string, unknown>
        this.objects.set(id, { type, fields: { ...this.defaults(type), ...fields } })
        if (this.schema.types[object.type].fields[field].kind === 'tree') {
          const nodes = object.fields[field] as TreeNode[]
          nodes.push({ object: id, parent: op.parent == null ? null : this.resolve(this.value(op.parent, refs), index, refs) })
        } else {
          const items = object.fields[field] as string[]
          items.splice(typeof op.at === 'number' ? op.at : items.length, 0, id)
        }
        if (typeof op.ref === 'string') refs[op.ref] = id
        return id
      }
      case 'set': {
        const { object, field } = this.field(this.resolve(op.target, index, refs), op.field, index)
        object.fields[field] = this.value(op.value, refs)
        return null
      }
      case 'delete': {
        const id = this.resolve(op.target, index, refs)
        for (const object of this.objects.values())
          for (const value of Object.values(object.fields))
            if (Array.isArray(value) && value.some((node) => (node as TreeNode | null)?.parent === id)) throw new BatchError('invalid-value', index, `${id} has children in a tree`)
        this.objects.delete(id)
        for (const object of this.objects.values())
          for (const [name, value] of Object.entries(object.fields)) {
            if (!Array.isArray(value)) continue
            object.fields[name] = value.filter((item) => item !== id && (item as TreeNode | null)?.object !== id)
          }
        return null
      }
      case 'text.insert':
      case 'text.delete':
      case 'text.set': {
        const { object, field } = this.field(this.resolve(op.target, index, refs), op.field, index)
        const text = String(object.fields[field] ?? '')
        const at = Number(op.index ?? 0)
        if (op.op === 'text.set') object.fields[field] = String(op.text)
        else if (op.op === 'text.insert') object.fields[field] = text.slice(0, at) + String(op.text) + text.slice(at)
        else object.fields[field] = text.slice(0, at) + text.slice(at + Number(op.count))
        return null
      }
      case 'list.insert': {
        const { object, field } = this.field(this.resolve(op.target, index, refs), op.field, index)
        const items = object.fields[field] as string[]
        items.splice(typeof op.index === 'number' ? op.index : items.length, 0, this.resolve(this.value(op.item, refs), index, refs))
        return null
      }
      case 'tree.insert':
      case 'tree.move': {
        const { object, field } = this.field(this.resolve(op.target, index, refs), op.field, index)
        const item = this.resolve(this.value(op.item, refs), index, refs)
        const parent = op.parent == null ? null : this.resolve(this.value(op.parent, refs), index, refs)
        // A moved node becomes its new parent's last child.
        const nodes = (object.fields[field] as TreeNode[]).filter((node) => node.object !== item)
        object.fields[field] = [...nodes, { object: item, parent }]
        return null
      }
      case 'command': {
        const command = this.options.command
        if (!command) throw new BatchError('command-failed', index, `unknown command \`${String(op.id)}\``)
        try {
          return (await command(String(op.id), this.value(op.params ?? {}, refs), origin, this)) ?? null
        } catch (error) {
          if (error instanceof BatchError) throw error
          throw new BatchError('command-failed', index, error instanceof Error ? error.message : String(error))
        }
      }
      default:
        throw new BatchError('invalid-op', index, `unknown op ${op.op}`)
    }
  }

  private load(target: string, wanted: string[] | undefined, refs: Record<string, string>): LoadedObject {
    const id = this.resolve(target, null, refs)
    const { type } = this.object(id)
    const defs = this.schema.types[type].fields
    const fields: Record<string, unknown> = {}
    for (const name of wanted ?? Object.keys(defs).sort()) {
      const kind = defs[name]?.kind
      fields[name] = kind === 'text' ? this.text(id, name) : kind === 'list' ? this.list(id, name) : kind === 'tree' ? this.tree(id, name) : kind === 'map' ? { ...(this.get(id, name) as object) } : this.get(id, name)
    }
    return { id, type, fields }
  }
}
