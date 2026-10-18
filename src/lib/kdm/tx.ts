// Copied from kition-sdk packages/kdm/src/tx.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Transactions. Nothing is written to the engine while a transaction runs: every operation
 * validates against the committed document plus an overlay of the transaction's own earlier
 * operations, and is buffered. `Replica.transact` applies the buffer only if the whole transaction
 * succeeds, because the engine cannot abort (its operations take effect as they are applied).
 */
import { LoroMap, type LoroDoc, type LoroTreeNode } from 'loro-crdt'
import { checkIndex as checkWhole, checkObjectIdSyntax, checkRecord, checkString } from './args'
import { canonical, compareKeys, setKey } from './canonical'
import { errors, KdmError } from './errors'
import { committedNode, newObjectId, nodeState, pendingNode, type NodeRef, type ObjectId } from './ids'
import { apply, type JsonFields, type Op } from './op'
import { committedKey, ListState, pendingIndex, pendingKey, TextState, treeId, TreeState, type NodeKey } from './overlay'
import type { TreeEntry } from './replica'
import * as read from './read'
import { checkedValue, isContainer, sortedKeys, type FieldDef, type FieldKind, type Schema } from './schema'
import { toJson, wellFormed } from './value'

type Fields = Record<string, unknown>

/** Checks the object id and field name every field operation takes. */
function checkField(id: unknown, field: unknown): void {
  checkString('an object id', id)
  checkString('a field name', field)
}

const fieldKey = (id: ObjectId, field: string): string => JSON.stringify([id, field])

/** Distinguishes transactions, so a node handle from one is never taken for another's. */
let nextSerial = 1

/** A successful transaction's operations, ready to apply. */
export interface Staged {
  readonly empty: boolean
  /** Whether the transaction raises the document's minimum schema version. */
  readonly raisesSchema: boolean
  /**
   * Applies the operations without committing, calling `touched` with each changed object. On
   * success the transaction's node handles resolve. Throws the engine's refusal as a `KdmError`.
   */
  apply(doc: LoroDoc, schema: Schema, touched: (id: ObjectId) => void): void
}

/**
 * The operations of one transaction.
 *
 * Nothing is written to the document while the transaction runs. Every operation validates
 * against the committed document plus the transaction's own earlier operations, and is buffered;
 * reads on `Tx` see those pending effects. An operation that throws changes nothing, so a
 * transaction may catch the error and continue. Positions in text are UTF-16 code units
 * (CodeMirror and DOM positions); one that would split a surrogate pair is `out-of-range`.
 */
export class Tx {
  private readonly serial = nextSerial++
  private readonly ops: Op[] = []
  /** Objects this transaction created: their type and the index of their `create` operation. */
  private readonly created = new Map<ObjectId, { ty: string; op: number }>()
  private readonly deleted = new Set<ObjectId>()
  /** Register writes: the index of the latest `set` operation of each field. */
  private readonly registers = new Map<string, number>()
  private readonly texts = new Map<string, TextState>()
  private readonly lists = new Map<string, ListState>()
  private readonly trees = new Map<string, TreeState>()
  /** Map writes by field: for each key written, the index of its latest `mapSet` operation, or `null` when the latest write deleted it. */
  private readonly maps = new Map<string, Map<string, number | null>>()
  /** The ids of `created` by type, in creation order (deleted ones included). */
  private readonly createdByType = new Map<string, ObjectId[]>()
  private readonly nodes: NodeRef[] = []
  /** The largest schema version this transaction raised the document to. */
  private raised: number | null = null
  private ended = false

  private constructor(
    private readonly doc: LoroDoc,
    private readonly schema: Schema,
  ) {}

  /** @internal Runs `build` on a new transaction; answers its result and its staged operations. */
  static stage<R>(doc: LoroDoc, schema: Schema, build: (tx: Tx) => R): { result: R; staged: Staged } {
    const tx = new Tx(doc, schema)
    let result: R
    try {
      result = build(tx)
    } finally {
      tx.ended = true
    }
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      throw errors.engine('a transaction runs synchronously; its function returned a promise')
    }
    const { ops, nodes } = tx
    return {
      result,
      staged: {
        empty: ops.length === 0,
        raisesSchema: ops.some((op) => op.op === 'raiseSchema'),
        apply: (target, applySchema, touched) => apply(target, applySchema, ops, nodes, touched),
      },
    }
  }

  /**
   * Raises the document's minimum schema version to `version` (rule M20): replicas whose schema is
   * older then refuse to load the document or import its changes (`newer-schema`). A migration
   * raises the version in the transaction that rewrites the document into the new form. Answers
   * whether the version rose: raising to a version the document already has, or a lower one,
   * changes nothing. Concurrent raises keep the largest.
   *
   * Only a `system` transaction raises the version, so it is never an undo step (`transact`
   * refuses others as `invalid-value`). `version` is at most the transaction's schema version: a
   * build cannot require a schema it does not read.
   */
  raiseSchemaVersion(version: number): boolean {
    this.live()
    if (!(typeof version === 'number' && Number.isInteger(version) && version >= 0)) {
      throw errors.invalidValue('$meta', 'schemaVersion', 'cannot be raised to a value that is not a non-negative integer')
    }
    if (version > this.schema.schemaVersion) {
      throw errors.invalidValue('$meta', 'schemaVersion', `cannot be raised to ${version}: this kit reads schema versions up to ${this.schema.schemaVersion}`)
    }
    if (version <= this.minSchemaVersion()) return false
    this.raised = version
    this.ops.push({ op: 'raiseSchema', version })
    return true
  }

  /** The document's minimum schema version (rule M20), including this transaction's raises. */
  minSchemaVersion(): number {
    return Math.max(read.minSchemaVersion(this.doc) ?? 0, this.raised ?? 0)
  }

  /**
   * Creates an object of type `ty` with its register fields; container fields start empty. Its id
   * is a new UUID v7, or `options.id`: an id the host chose, matching
   * `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}` and naming no object of the document or of this
   * transaction (one it deleted included); otherwise `invalid-value`. Replicas that create one id
   * concurrently keep one of the objects.
   */
  create(ty: string, fields: Fields, options?: { id?: string }): ObjectId {
    this.live()
    checkString('a type name', ty)
    checkRecord('the fields', fields)
    let chosen: string | undefined
    if (options !== undefined) {
      checkRecord('the options', options)
      const unknown = Object.keys(options).find((key) => key !== 'id')
      if (unknown !== undefined) throw new KdmError('invalid-value', `the options take only \`id\`, not \`${unknown}\``)
      chosen = options.id
      if (chosen !== undefined) checkString('an object id', chosen)
    }
    if (!Object.hasOwn(this.schema.types, ty)) throw errors.unknownType(ty)
    const def = this.schema.types[ty]
    const names = sortedKeys(fields)
    const copy: JsonFields = {}
    for (const name of names) {
      const value = checkedValue(this.schema, ty, name, fields[name])
      if (typeof value === 'string') this.checkOf(ty, name, def.fields[name], value)
      setKey(copy, name, value)
    }
    for (const name of sortedKeys(def.fields)) {
      const field = def.fields[name]
      if (!isContainer(field.kind) && !field.optional && !Object.hasOwn(fields, name)) throw errors.invalidValue(ty, name, 'is required')
    }
    const id = chosen === undefined ? newObjectId() : this.freeId(ty, chosen)
    this.created.set(id, { ty, op: this.ops.length })
    const ofType = this.createdByType.get(ty)
    if (ofType) ofType.push(id)
    else this.createdByType.set(ty, [id])
    this.ops.push({ op: 'create', id, ty, fields: copy })
    return id
  }

  /** Sets one register field. Concurrent sets of one field resolve to one winner; sets of different fields both survive. */
  set(id: ObjectId, field: string, value: unknown): void {
    this.live()
    checkField(id, field)
    const { ty, def } = this.field(id, field)
    const stored = checkedValue(this.schema, ty, field, value)
    if (typeof stored === 'string') this.checkOf(ty, field, def, stored)
    this.registers.set(fieldKey(id, field), this.ops.length)
    this.ops.push({ op: 'set', id, field, value: stored })
  }

  /** Deletes an object. References to it dangle; kits treat that as a validation state. */
  delete(id: ObjectId): void {
    if (!this.exists(id)) throw errors.notFound(id)
    this.deleted.add(id)
    this.ops.push({ op: 'delete', id })
  }

  exists(id: ObjectId): boolean {
    this.live()
    checkString('an object id', id)
    return !this.deleted.has(id) && (this.created.has(id) || this.doc.getMap(read.OBJECTS).get(id) instanceof LoroMap)
  }

  /** The type of a live object, including one this transaction created; not-found for an object it deleted. */
  objectType(id: ObjectId): string {
    this.live()
    checkString('an object id', id)
    return this.typeOf(id)
  }

  get(id: ObjectId, field: string): unknown {
    this.live()
    checkField(id, field)
    const { ty, def } = this.field(id, field)
    if (isContainer(def.kind)) throw errors.invalidValue(ty, field, 'is a container; read it with its accessor')
    const pending = this.pendingRegister(id, field)
    return pending !== undefined ? pending : read.register(this.doc, this.schema, id, field)
  }

  /** Inserts `content` at `index`, counted in UTF-16 code units. */
  textInsert(id: ObjectId, field: string, index: number, content: string): void {
    this.live()
    checkField(id, field)
    checkWhole('index', index)
    checkString('the content', content)
    this.containerField(id, field, 'text')
    const text = this.textState(id, field, true)
    if (index > text.len) throw errors.outOfRange(index, text.len)
    if (text.splits(index)) throw splitError(index)
    const stored = wellFormed(content)
    this.texts.set(fieldKey(id, field), text)
    text.insert(index, stored)
    this.ops.push({ op: 'textInsert', id, field, index, content: stored })
  }

  /** Deletes `count` UTF-16 code units starting at `index`. */
  textDelete(id: ObjectId, field: string, index: number, count: number): void {
    this.live()
    checkField(id, field)
    checkWhole('index', index)
    checkWhole('count', count)
    this.containerField(id, field, 'text')
    const text = this.textState(id, field, true)
    const end = index + count
    if (end > text.len) throw errors.outOfRange(end, text.len)
    if (text.splits(index)) throw splitError(index)
    if (text.splits(end)) throw splitError(end)
    this.texts.set(fieldKey(id, field), text)
    text.delete(index, count)
    this.ops.push({ op: 'textDelete', id, field, index, count })
  }

  /** The length of a text field in UTF-16 code units, including this transaction's edits. */
  textLength(id: ObjectId, field: string): number {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'text')
    return this.textState(id, field, false).len
  }

  /** A text field including this transaction's edits. Reads the whole text. */
  text(id: ObjectId, field: string): string {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'text')
    return this.textState(id, field, false).text()
  }

  /**
   * Sets mark `key` to `value` over the code units `start..end` of a text field (rule M19). The
   * field declares `key` in its schema `marks`; `value` is plain JSON and not `null` (remove a
   * mark with `textUnmark`). An empty range changes nothing. Concurrent marks of one key over
   * overlapping ranges resolve to one value per character; marks of different keys all apply.
   */
  textMark(id: ObjectId, field: string, start: number, end: number, key: string, value: unknown): void {
    this.live()
    checkField(id, field)
    checkWhole('index', start)
    checkWhole('index', end)
    checkString('a mark key', key)
    const ty = this.markKey(id, field, key)
    if (value === null || value === undefined) throw errors.invalidValue(ty, field, `mark \`${key}\` takes a value; remove a mark with textUnmark`)
    const stored = toJson(value, (reason) => errors.invalidValue(ty, field, `mark \`${key}\` ${reason}`))
    if (!this.markRange(id, field, start, end)) return
    this.ops.push({ op: 'textMark', id, field, start, end, key, value: stored })
  }

  /** Removes mark `key` from the code units `start..end` of a text field. Characters without the mark are left as they are; an empty range changes nothing. */
  textUnmark(id: ObjectId, field: string, start: number, end: number, key: string): void {
    this.live()
    checkField(id, field)
    checkWhole('index', start)
    checkWhole('index', end)
    checkString('a mark key', key)
    this.markKey(id, field, key)
    if (!this.markRange(id, field, start, end)) return
    this.ops.push({ op: 'textUnmark', id, field, start, end, key })
  }

  listInsert(id: ObjectId, field: string, index: number, item: ObjectId): void {
    this.live()
    checkField(id, field)
    checkWhole('index', index)
    checkString('a list item', item)
    const { ty, def } = this.containerField(id, field, 'list')
    this.checkOf(ty, field, def, item)
    const list = this.listState(id, field)
    if (index > list.len) throw errors.outOfRange(index, list.len)
    list.len += 1
    list.edits.push({ insert: index, item })
    this.ops.push({ op: 'listInsert', id, field, index, item })
  }

  /** Moves the item at `from` so that it ends at index `to`. */
  listMove(id: ObjectId, field: string, from: number, to: number): void {
    this.live()
    checkField(id, field)
    checkWhole('index', from)
    checkWhole('index', to)
    this.containerField(id, field, 'list')
    const list = this.listState(id, field)
    if (from >= list.len || to >= list.len) throw errors.outOfRange(Math.max(from, to), list.len)
    list.edits.push({ move: from, to })
    this.ops.push({ op: 'listMove', id, field, from, to })
  }

  listRemove(id: ObjectId, field: string, index: number): void {
    this.live()
    checkField(id, field)
    checkWhole('index', index)
    this.containerField(id, field, 'list')
    const list = this.listState(id, field)
    if (index >= list.len) throw errors.outOfRange(index, list.len)
    list.len -= 1
    list.edits.push({ remove: index })
    this.ops.push({ op: 'listRemove', id, field, index })
  }

  /** The list's items including this transaction's edits. Reads the whole list: call it only when the items themselves are wanted. */
  listItems(id: ObjectId, field: string): ObjectId[] {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'list')
    const committed = read.asContainer(this.stored(id, field, false), 'list', id, field)
    const items = committed ? read.listItems(committed.toArray()) : []
    return this.lists.get(fieldKey(id, field))?.replay(items) ?? items
  }

  /** `listItems` under the name `Replica` uses. */
  list(id: ObjectId, field: string): ObjectId[] {
    return this.listItems(id, field)
  }

  /** Sets `key` of a map field. Concurrent sets of one key resolve to one winner. */
  mapSet(id: ObjectId, field: string, key: string, value: unknown): void {
    this.live()
    checkField(id, field)
    checkString('a map key', key)
    const ty = this.writableMap(id, field)
    const stored = toJson(value, (reason) => errors.invalidValue(ty, field, reason))
    const storedKey = wellFormed(key)
    this.mapWrites(id, field).set(storedKey, this.ops.length)
    this.ops.push({ op: 'mapSet', id, field, key: storedKey, value: stored })
  }

  mapDelete(id: ObjectId, field: string, key: string): void {
    this.live()
    checkField(id, field)
    checkString('a map key', key)
    this.writableMap(id, field)
    const storedKey = wellFormed(key)
    this.mapWrites(id, field).set(storedKey, null)
    this.ops.push({ op: 'mapDelete', id, field, key: storedKey })
  }

  /**
   * One key of a map field including this transaction's writes, or `null`, as `Replica.mapGet`
   * reads it. Costs one lookup in the transaction's writes of the field and at most one in the
   * document, however large the transaction.
   */
  mapGet(id: ObjectId, field: string, key: string): unknown {
    this.live()
    checkField(id, field)
    checkString('a map key', key)
    this.containerField(id, field, 'map')
    const storedKey = wellFormed(key)
    const write = this.maps.get(fieldKey(id, field))?.get(storedKey)
    if (write !== undefined) return this.pendingMapValue(write)
    const committed = read.asContainer(this.stored(id, field, false), 'map', id, field)
    return committed ? read.storedValue(committed.get(storedKey)) : null
  }

  /**
   * A map field's keys and values including this transaction's writes, sorted by key (code point
   * order, as in the canonical state), each as `mapGet` reads it. Reads the whole map and sorts
   * the result on every call, O(n log n) in its keys: call it only when every entry is wanted.
   */
  mapEntries(id: ObjectId, field: string): Array<[string, unknown]> {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'map')
    const committed = read.asContainer(this.stored(id, field, false), 'map', id, field)
    const entries = committed ? read.mapEntries(committed) : []
    const writes = this.maps.get(fieldKey(id, field))
    if (!writes) return entries
    const merged = new Map(entries)
    for (const [key, write] of writes) {
      if (write === null) merged.delete(key)
      else merged.set(key, this.pendingMapValue(write))
    }
    return [...merged].sort((a, b) => compareKeys(a[0], b[0]))
  }

  /**
   * Ids of the live objects of type `ty`, including those this transaction created and without
   * those it deleted, sorted as `Replica.objectsOfType` sorts them. One pass over every object of
   * the document, O(objects) per call, plus this transaction's creations of `ty`; when it created
   * any, the whole result is sorted again, O(n log n) per call.
   */
  objectsOfType(ty: string): ObjectId[] {
    this.live()
    checkString('a type name', ty)
    const live = (id: ObjectId) => !this.deleted.has(id)
    let ids = read.objectsOfType(this.doc, ty)
    if (this.deleted.size > 0) ids = ids.filter(live)
    const created = this.createdByType.get(ty)
    if (!created) return ids
    return ids.concat(created.filter(live)).sort(compareKeys)
  }

  /** Adds a node naming `object` under `parent` (`null`: a root), last among its siblings. The handle resolves when the transaction commits. */
  treeCreate(id: ObjectId, field: string, parent: NodeRef | null, object: ObjectId): NodeRef {
    this.live()
    checkField(id, field)
    checkString('a tree node object', object)
    const { ty, def } = this.containerField(id, field, 'tree')
    this.checkOf(ty, field, def, object)
    const parentKey = parent === null || parent === undefined ? null : this.nodeKey(parent)
    const index = this.nodes.length
    const tree = this.treeState(id, field)
    if (parentKey !== null && !tree.contains(parentKey)) throw errors.notFound(`parent node in ${id}.${field}`)
    tree.parents.set(pendingKey(index), parentKey)
    const node = pendingNode(this.serial, index)
    this.nodes.push(node)
    this.ops.push({ op: 'treeCreate', id, field, parent: parentKey, object, node: index })
    return node
  }

  /**
   * Moves `node` under `parent` (`null`: a root), last among its siblings. A move that would make a
   * node its own ancestor (counting this transaction's earlier moves) is a `cycle` error; concurrent
   * moves that would form a cycle are resolved by the engine.
   */
  treeMove(id: ObjectId, field: string, node: NodeRef, parent: NodeRef | null): void {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'tree')
    const nodeKey = this.nodeKey(node)
    const parentKey = parent === null || parent === undefined ? null : this.nodeKey(parent)
    const tree = this.treeState(id, field)
    if (!tree.contains(nodeKey) || (parentKey !== null && !tree.contains(parentKey))) throw errors.notFound(`node in ${id}.${field}`)
    if (parentKey !== null && tree.wouldCycle(nodeKey, parentKey)) throw errors.cycle()
    tree.parents.set(nodeKey, parentKey)
    this.ops.push({ op: 'treeMove', id, field, node: nodeKey, parent: parentKey })
  }

  /**
   * The tree's nodes in pre-order as this transaction sees it: the document's nodes plus the nodes
   * it created, each node it created or moved last among its new siblings, as they will be once it
   * applies. A node that names no object is skipped with its subtree, as in `Replica.tree`. Reads
   * the whole tree: O(nodes + this transaction's operations).
   */
  tree(id: ObjectId, field: string): TreeEntry[] {
    this.live()
    checkField(id, field)
    this.containerField(id, field, 'tree')
    const committed = read.asContainer(this.stored(id, field, false), 'tree', id, field)
    type Key = NodeKey | null
    const children = new Map<Key, NodeKey[]>()
    const parentOf = new Map<NodeKey, Key>()
    const objects = new Map<NodeKey, ObjectId | null>()
    const add = (parent: Key, child: NodeKey) => {
      const list = children.get(parent)
      if (list) list.push(child)
      else children.set(parent, [child])
      parentOf.set(child, parent)
    }
    const visit = (nodes: LoroTreeNode[] | undefined, parent: Key) => {
      for (const node of nodes ?? []) {
        const key = committedKey(node.id)
        add(parent, key)
        objects.set(key, read.nodeObject(node))
        visit(node.children(), key)
      }
    }
    if (committed) visit(committed.roots(), null)
    for (const op of this.ops) {
      if (op.op === 'treeCreate' && op.id === id && op.field === field) {
        const key = pendingKey(op.node)
        add(op.parent, key)
        objects.set(key, op.object)
      } else if (op.op === 'treeMove' && op.id === id && op.field === field) {
        const old = parentOf.get(op.node)
        if (old !== undefined) children.set(old, (children.get(old) ?? []).filter((child) => child !== op.node))
        add(op.parent, op.node)
      }
    }
    const handle = (key: NodeKey): NodeRef => {
      const index = pendingIndex(key)
      if (index === null) return committedNode(treeId(key))
      const node = this.nodes[index]
      if (!node) throw errors.engine(`tree node ${index} was not staged`)
      return node
    }
    const out: TreeEntry[] = []
    const walk = (parent: Key, parentRef: NodeRef | null) => {
      for (const key of children.get(parent) ?? []) {
        const object = objects.get(key)
        if (object === null || object === undefined) continue
        const node = handle(key)
        out.push({ node, object, parent: parentRef })
        walk(key, node)
      }
    }
    walk(null, null)
    return out
  }

  /** Checks an id the host chose for a new object of type `ty`. */
  private freeId(ty: string, id: string): ObjectId {
    checkObjectIdSyntax(ty, id)
    if (this.created.has(id) || this.deleted.has(id) || this.doc.getMap(read.OBJECTS).get(id) !== undefined) {
      throw errors.invalidValue(ty, '$id', `cannot be \`${id}\`: that object id is taken`)
    }
    return id
  }

  private live(): void {
    if (this.ended) throw errors.engine('the transaction has ended')
  }

  /** The type of a live object, declared by the schema. */
  private typeOf(id: ObjectId): string {
    if (this.deleted.has(id)) throw errors.notFound(id)
    const created = this.created.get(id)
    if (created) return created.ty
    const ty = read.objectType(this.doc, id)
    if (!Object.hasOwn(this.schema.types, ty)) throw errors.unknownType(ty)
    return ty
  }

  /** The object's type and the definition of `field`. */
  private field(id: ObjectId, field: string): { ty: string; def: FieldDef } {
    const ty = this.typeOf(id)
    const fields = this.schema.types[ty].fields
    if (!Object.hasOwn(fields, field)) throw errors.unknownField(ty, field)
    return { ty, def: fields[field] }
  }

  private containerField(id: ObjectId, field: string, kind: FieldKind): { ty: string; def: FieldDef } {
    const found = this.field(id, field)
    if (found.def.kind !== kind) throw read.wrongKind(found.ty, field, kind)
    return found
  }

  /** Refuses a target that exists but is not of the field's `of` type. A missing target is accepted: a dangling reference is a validation state. */
  private checkOf(ty: string, field: string, def: FieldDef | undefined, target: ObjectId): void {
    const of = def?.of
    if (of === undefined) return
    let found: string | null = null
    if (!this.deleted.has(target)) {
      found = this.created.get(target)?.ty ?? null
      if (found === null) {
        try {
          found = read.objectType(this.doc, target)
        } catch {
          found = null
        }
      }
    }
    if (found !== null && found !== of) throw errors.invalidValue(ty, field, `expects an object of type \`${of}\`, and \`${target}\` is a \`${found}\``)
  }

  /**
   * The document's container for a field, or `null` when it starts empty: the object was created
   * by this transaction, or (for reads) it predates the field. Writes to a field the stored object
   * lacks are `not-found`.
   */
  private stored(id: ObjectId, field: string, write: boolean): unknown {
    if (this.created.has(id)) return undefined
    const found = read.objectMap(this.doc, id).get(field)
    if (found === undefined && write) throw errors.notFound(`${id}.${field}`)
    return found
  }

  /** The pending writes of a map field, made on first use. */
  private mapWrites(id: ObjectId, field: string): Map<string, number | null> {
    const key = fieldKey(id, field)
    let writes = this.maps.get(key)
    if (!writes) this.maps.set(key, (writes = new Map()))
    return writes
  }

  /** The value of the `mapSet` operation at `index` (`null`: a deletion), as the engine will store it. */
  private pendingMapValue(index: number | null): unknown {
    if (index === null) return null
    const op = this.ops[index]
    return op.op === 'mapSet' ? canonical(op.value) : null
  }

  private pendingRegister(id: ObjectId, field: string): unknown {
    const set = this.registers.get(fieldKey(id, field))
    if (set !== undefined) {
      const op = this.ops[set]
      if (op.op === 'set') return canonical(op.value)
    }
    const created = this.created.get(id)
    if (!created) return undefined
    const op = this.ops[created.op]
    return op.op === 'create' ? canonical(op.fields[field] ?? null) : undefined
  }

  /** The text's state: this transaction's, or a fresh one over the document's text (not recorded until an edit succeeds). */
  private textState(id: ObjectId, field: string, write: boolean): TextState {
    const pending = this.texts.get(fieldKey(id, field))
    if (pending) return pending
    const committed = read.asContainer(this.stored(id, field, write), 'text', id, field)
    return new TextState(committed, committed?.length ?? 0)
  }

  /** Checks that `field` is a text field declaring mark `key`; answers the object's type. */
  private markKey(id: ObjectId, field: string, key: string): string {
    const { ty, def } = this.containerField(id, field, 'text')
    if (!def.marks || !Object.hasOwn(def.marks, key)) throw errors.invalidValue(ty, field, `declares no mark \`${key}\``)
    return ty
  }

  /** Checks a mark's range against the text including this transaction's edits; answers whether it holds any character. */
  private markRange(id: ObjectId, field: string, start: number, end: number): boolean {
    const text = this.textState(id, field, true)
    if (end > text.len) throw errors.outOfRange(end, text.len)
    if (start > end) throw errors.outOfRange(start, end)
    if (text.splits(start)) throw splitError(start)
    if (text.splits(end)) throw splitError(end)
    return start < end
  }

  private listState(id: ObjectId, field: string): ListState {
    const key = fieldKey(id, field)
    let list = this.lists.get(key)
    if (!list) {
      const committed = read.asContainer(this.stored(id, field, true), 'list', id, field)
      list = new ListState(committed?.length ?? 0)
      this.lists.set(key, list)
    }
    return list
  }

  /** Checks a map field for writing; answers the object's type. */
  private writableMap(id: ObjectId, field: string): string {
    const { ty } = this.containerField(id, field, 'map')
    read.asContainer(this.stored(id, field, true), 'map', id, field)
    return ty
  }

  private treeState(id: ObjectId, field: string): TreeState {
    const key = fieldKey(id, field)
    let tree = this.trees.get(key)
    if (!tree) {
      tree = new TreeState(read.asContainer(this.stored(id, field, true), 'tree', id, field))
      this.trees.set(key, tree)
    }
    return tree
  }

  /** A handle as this transaction sees it. A handle of another transaction that never applied (it failed) names no node. */
  private nodeKey(node: NodeRef): NodeKey {
    const state = nodeState(node)
    if (!state) throw errors.notFound('a tree node the KDM did not make')
    if (state.id !== null) return committedKey(state.id)
    if (state.pending?.tx === this.serial) return pendingKey(state.pending.index)
    throw errors.notFound('a tree node from a transaction that did not commit')
  }
}


const splitError = (index: number): KdmError => new KdmError('out-of-range', `index ${index} splits a character`)
