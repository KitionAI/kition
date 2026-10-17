// Copied from kition-sdk packages/kdm/src/replica.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { isContainer as isEngineContainer, LoroDoc, UndoManager, type ImportStatus, type LoroEventBatch, type LoroTreeNode, type PeerID } from 'loro-crdt'
import { canonicalText, compareKeys } from './canonical'
import { checkString } from './args'
import { open, sameBytes, Version, wrap } from './envelope'
import { errors, KdmError } from './errors'
import { checkActor, committedNode, uuidFromBytes, uuidToBytes, type NodeRef, type ObjectId } from './ids'
import { configure, type TextRun } from './marks'
import { checkOrigin, encodeOrigin, system, type Origin } from './origin'
import * as read from './read'
import { KDM_VERSION, type Schema } from './schema'
import { Tx } from './tx'

/**
 * The origin given to the partial operations of a transaction the engine refused while applying
 * it, and to their reversal, so the undo history never records either.
 */
const ROLLBACK = 'kdm-rollback'

/**
 * The commit origin of `system` transactions (repairs, migrations). They are not undo steps: undo
 * skips them like changes from another replica, and they survive the undo of earlier transactions.
 */
const SYSTEM: Origin['kind'] = 'system'
const IMPORT: Origin['kind'] = 'import'

/** A text change as the engine reports it, in UTF-16 code units; `attributes` are the marks it sets (`null`: removed). */
export type TextDelta =
  | { retain: number; attributes?: Record<string, unknown> }
  | { insert: string; attributes?: Record<string, unknown> }
  | { delete: number }

/** One node of a tree field, as `Replica.tree` lists it. */
export interface TreeEntry {
  node: NodeRef
  /** The object the node names. */
  object: ObjectId
  /** `null` for a root. */
  parent: NodeRef | null
}

/** An engine failure while applying operations that validation accepted. */
const applyingFailed = (error: unknown): KdmError => errors.engine(`applying a validated transaction failed: ${error instanceof Error ? error.message : String(error)}`)

const engineMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Runs `run` while observing which objects change. Change events are observed only during the
 * call: a document-wide subscription makes large local transactions slow to commit.
 */
function observeChanges<T>(doc: LoroDoc, run: () => T): { value: T; changed: Set<ObjectId> } {
  const found = new Set<ObjectId>()
  const unsubscribe = doc.subscribe((batch: LoroEventBatch) => {
    for (const event of batch.events) {
      if (event.path[0] !== read.OBJECTS) continue
      if (event.path.length >= 2) found.add(String(event.path[1]))
      else if (event.diff.type === 'map') for (const key of Object.keys(event.diff.updated)) found.add(key)
    }
  })
  try {
    return { value: run(), changed: found }
  } finally {
    unsubscribe()
  }
}

const sorted = (ids: Iterable<ObjectId>): Set<ObjectId> => new Set([...ids].sort(compareKeys))

/** Checks the object id and field name a read takes. */
function checkField(id: unknown, field: unknown): void {
  checkString('an object id', id)
  checkString('a field name', field)
}

function checkFunction(f: unknown): void {
  if (typeof f !== 'function') throw new KdmError('invalid-value', 'a transaction needs a function')
}

/** One copy of one document; the TypeScript twin of the Rust `Replica`. */
export class Replica {
  private readonly docIdBytes: Uint8Array
  private readonly undoManager: UndoManager
  private changed = new Set<ObjectId>()
  /** Set while a transaction's function runs: nothing else may change the document then. */
  private busy = false
  /** Set between `beginUndoGroup` and `endUndoGroup`. */
  private grouping = false
  /**
   * For each replica whose changes an import could not apply yet, the counter just past the last
   * of them. They are applied (and no longer pending) once `version` reaches it.
   */
  private readonly pending = new Map<PeerID, number>()

  private constructor(
    private readonly doc: LoroDoc,
    docIdBytes: Uint8Array,
    readonly schema: Schema,
    readonly actor: bigint,
  ) {
    this.docIdBytes = docIdBytes.slice()
    doc.setPeerId(actor)
    this.undoManager = new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: [ROLLBACK, SYSTEM, IMPORT] })
  }

  /** A new, empty document. Only one replica creates a document; others `load` it. */
  static create(schema: Schema, docId: string, actor: bigint): Replica {
    return Replica.createWith(schema, docId, actor, system('create'), () => undefined).replica
  }

  /**
   * A new document whose initial content `build` writes in the creating commit, before undo
   * history starts: file imports and other bulk builds. Undo bookkeeping grows faster than
   * linearly with a transaction's size, so bulk content must not go through `transact`.
   * `build` is staged like a transaction; if it throws, no document is made.
   */
  static createWith<R>(schema: Schema, docId: string, actor: bigint, origin: Origin, build: (tx: Tx) => R): { replica: Replica; result: R } {
    checkOrigin(origin)
    checkFunction(build)
    const idBytes = uuidToBytes(docId)
    checkActor(actor)
    const doc = new LoroDoc()
    doc.setPeerId(actor)
    configure(doc, schema)
    const { result, staged } = Tx.stage(doc, schema, build)
    const meta = doc.getMap(read.META)
    meta.set('docId', uuidFromBytes(idBytes))
    meta.set('kit', schema.kit)
    meta.set('schemaVersion', schema.schemaVersion)
    meta.set('kdm', KDM_VERSION)
    // The new document is discarded on failure, so nothing needs reverting.
    try {
      staged.apply(doc, schema, () => undefined)
    } catch (error) {
      throw applyingFailed(error)
    }
    doc.commit({ origin: origin.kind, message: encodeOrigin(origin) })
    return { replica: new Replica(doc, idBytes, schema, actor), result }
  }

  /**
   * Opens a snapshot (or a full change export) as a new writable replica of `actor`. Refuses
   * (`schema`) a document of another kit, of another KDM version, or written under a newer version
   * of the schema than `schema`; bytes that are not a KDM snapshot are `encoding` errors.
   *
   * A snapshot holds the changes its replica applied, not those still pending on it (see
   * `hasPendingChanges`): the loaded replica has none pending, and fetches those changes again
   * when it syncs.
   */
  static load(schema: Schema, bytes: Uint8Array, actor: bigint): Replica {
    checkActor(actor)
    const { docId, engine } = open(bytes)
    const doc = new LoroDoc()
    configure(doc, schema)
    let status: ImportStatus
    try {
      status = doc.import(engine)
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    const metaMap = doc.getMap(read.META)
    const meta = (key: string): unknown => {
      const value = metaMap.get(key)
      return value === undefined || isEngineContainer(value) ? null : value
    }
    const kit = meta('kit')
    if (kit === null) throw errors.encoding('not a snapshot: meta.kit is missing (load a snapshot or a full export, not changes only)')
    if (kit !== schema.kit) throw errors.schema(`the document belongs to ${canonicalText(kit)}, not \`${schema.kit}\``)
    const kdm = meta('kdm')
    if (kdm !== KDM_VERSION) throw errors.schema(`the document uses kdm ${canonicalText(kdm)}; this build reads ${KDM_VERSION}`)
    const version = meta('schemaVersion')
    if (!(typeof version === 'number' && Number.isInteger(version) && version >= 0 && version <= schema.schemaVersion)) {
      throw errors.schema(`the document has schema version ${canonicalText(version)}; this kit reads schema versions up to ${schema.schemaVersion}`)
    }
    // The envelope and the document must agree; anything else is corrupt or forged bytes.
    const stored = meta('docId')
    let storedBytes: Uint8Array | null = null
    try {
      storedBytes = typeof stored === 'string' ? uuidToBytes(stored) : null
    } catch {
      storedBytes = null
    }
    if (!storedBytes || !sameBytes(storedBytes, docId)) throw errors.encoding(`the bytes are labelled as document ${uuidFromBytes(docId)}, but hold another`)
    const replica = new Replica(doc, docId, schema, actor)
    replica.notePending(status)
    return replica
  }

  /** The document's durable identity, as a lowercase hyphenated UUID. */
  get docId(): string {
    return uuidFromBytes(this.docIdBytes)
  }

  version(): Version {
    return Version.fromEngine(this.doc.oplogVersion())
  }

  /**
   * Runs `f` as one transaction: one commit, one undo step, one origin. Operations are staged while
   * `f` runs and applied only if it returns: if `f` throws, the document, its version, and its
   * exports are unchanged and the error propagates. `f` must be synchronous.
   */
  transact<R>(origin: Origin, f: (tx: Tx) => R): R {
    this.idle()
    checkOrigin(origin)
    checkFunction(f)
    this.busy = true
    let stage: { result: R; staged: ReturnType<typeof Tx.stage>['staged'] }
    try {
      stage = Tx.stage(this.doc, this.schema, f)
    } finally {
      this.busy = false
    }
    const { result, staged } = stage
    if (staged.empty) return result
    const before = this.doc.frontiers()
    const touched = new Set<ObjectId>()
    try {
      staged.apply(this.doc, this.schema, (id) => touched.add(id))
    } catch (error) {
      // Validation should have made this impossible: an operation the overlay accepted was refused
      // by the engine, so this is a validation bug. Some operations may already be applied and the
      // engine cannot abort, so they are committed and reverted. Both commits reach other replicas,
      // and the reversal can overwrite a collaborator's concurrent edits to the same fields; that
      // is the cost of this last-resort path.
      this.doc.commit({ origin: ROLLBACK })
      if (!sameFrontiers(this.doc.frontiers(), before)) {
        try {
          this.doc.revertTo(before)
        } catch (revertError) {
          throw errors.engine(engineMessage(revertError))
        }
        this.doc.commit({ origin: ROLLBACK, message: encodeOrigin(system('rollback')) })
      }
      throw applyingFailed(error)
    }
    this.doc.commit({ origin: origin.kind, message: encodeOrigin(origin) })
    for (const id of touched) this.changed.add(id)
    return result
  }

  exists(id: ObjectId): boolean {
    checkString('an object id', id)
    try {
      read.objectMap(this.doc, id)
      return true
    } catch {
      return false
    }
  }

  objectType(id: ObjectId): string {
    checkString('an object id', id)
    return read.objectType(this.doc, id)
  }

  get(id: ObjectId, field: string): unknown {
    checkField(id, field)
    return read.register(this.doc, this.schema, id, field)
  }

  text(id: ObjectId, field: string): string {
    checkField(id, field)
    return read.container(this.doc, this.schema, id, field, 'text')?.toString() ?? ''
  }

  /**
   * A text field as runs of characters with equal marks (rule M19), in order: adjacent runs differ
   * in their marks, no run is empty, and only the field's declared marks appear. A field that
   * declares no marks reads as one unmarked run (none when empty). Positions are counted in UTF-16
   * code units (`insert.length`).
   */
  textDelta(id: ObjectId, field: string): TextRun[] {
    checkField(id, field)
    return read.textRuns(this.doc, this.schema, id, field)
  }

  /** The length of a text field in UTF-16 code units. */
  textLength(id: ObjectId, field: string): number {
    checkField(id, field)
    return read.container(this.doc, this.schema, id, field, 'text')?.length ?? 0
  }

  list(id: ObjectId, field: string): ObjectId[] {
    checkField(id, field)
    const list = read.container(this.doc, this.schema, id, field, 'list')
    return list ? read.listItems(list.toArray()) : []
  }

  /** One key of a map field, or `null`. */
  mapGet(id: ObjectId, field: string, key: string): unknown {
    checkField(id, field)
    checkString('a map key', key)
    const map = read.container(this.doc, this.schema, id, field, 'map')
    return map ? read.storedValue(map.get(key)) : null
  }

  /**
   * A map field's keys and values, sorted by key (code point order, as in the canonical state),
   * each as `mapGet` reads it. Reads the whole map.
   */
  mapEntries(id: ObjectId, field: string): Array<[string, unknown]> {
    checkField(id, field)
    const map = read.container(this.doc, this.schema, id, field, 'map')
    return map ? read.mapEntries(map) : []
  }

  /**
   * The tree's nodes in pre-order (each parent before its children, siblings in order). A node
   * that names no object is skipped with its subtree, as in `stateJson`.
   */
  tree(id: ObjectId, field: string): TreeEntry[] {
    checkField(id, field)
    const out: TreeEntry[] = []
    const tree = read.container(this.doc, this.schema, id, field, 'tree')
    const visit = (nodes: LoroTreeNode[] | undefined, parent: NodeRef | null) => {
      for (const node of nodes ?? []) {
        const object = read.nodeObject(node)
        if (object === null) continue
        const ref = committedNode(node.id)
        out.push({ node: ref, object, parent })
        visit(node.children(), ref)
      }
    }
    if (tree) visit(tree.roots(), null)
    return out
  }

  /**
   * Ids of the objects of type `ty`, sorted. One pass over the objects, so it suits large
   * documents; it costs O(objects) per call.
   */
  objectsOfType(ty: string): ObjectId[] {
    checkString('a type name', ty)
    return read.objectsOfType(this.doc, ty)
  }

  /** The changes this replica has that a replica at `since` lacks, labelled with this document's id. */
  exportChanges(since: Version = Version.empty()): Uint8Array {
    if (!(since instanceof Version)) throw new KdmError('invalid-value', 'a version must be a `Version`')
    let bytes: Uint8Array
    try {
      bytes = this.doc.export({ mode: 'update', from: since.toEngine() })
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    return wrap(this.docIdBytes, bytes)
  }

  /**
   * Applies changes from another replica or from storage, in any order, any number of times.
   * Answers the objects whose state changed. Bytes that are not a KDM export are `encoding`
   * errors; changes of another document are `wrong-document` errors and change nothing.
   */
  importChanges(bytes: Uint8Array): Set<ObjectId> {
    this.idle()
    const { docId, engine } = open(bytes)
    if (!sameBytes(docId, this.docIdBytes)) throw errors.wrongDocument(this.docId, uuidFromBytes(docId))
    const { value: status, changed } = observeChanges(this.doc, () => {
      try {
        return this.doc.import(engine)
      } catch (error) {
        throw errors.encoding(engineMessage(error))
      }
    })
    this.notePending(status)
    for (const id of changed) this.changed.add(id)
    this.reopenUndoGroup()
    return sorted(changed)
  }

  /**
   * Whether this replica holds imported changes it could not apply yet, because they depend on
   * changes it has not received. Importing changes out of order is legitimate (they are applied as
   * soon as what they depend on arrives); a replica that stays in this state is missing changes,
   * which a sync from `version` fetches. Pending changes are not in `version`, the state, or the
   * exports.
   */
  hasPendingChanges(): boolean {
    const applied = this.doc.oplogVersion()
    for (const [peer, end] of this.pending) if ((applied.get(peer) ?? 0) < end) return true
    return false
  }

  /** The objects changed since the last call, by local transactions, imports, undo, and redo. */
  takeChanged(): Set<ObjectId> {
    const out = sorted(this.changed)
    this.changed = new Set()
    return out
  }

  /** A compacted copy of the whole document, for fast loading and new replicas. */
  snapshot(): Uint8Array {
    let bytes: Uint8Array
    try {
      bytes = this.doc.export({ mode: 'snapshot' })
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    return wrap(this.docIdBytes, bytes)
  }

  /**
   * Undoes this replica's last transaction. Changes from other replicas are kept, including later
   * changes to the same object. The objects it changes are reported by `takeChanged`.
   */
  undo(): boolean {
    return this.history(() => this.undoManager.undo())
  }

  /** Redoes the last undone transaction, reporting what it changes like `undo`. */
  redo(): boolean {
    return this.history(() => this.undoManager.redo())
  }

  /** Whether `undo` has a transaction of this replica to undo. */
  canUndo(): boolean {
    this.idle()
    return this.undoManager.canUndo()
  }

  /** Whether `redo` has an undone transaction to redo. */
  canRedo(): boolean {
    this.idle()
    return this.undoManager.canRedo()
  }

  /**
   * Starts an undo group: the transactions until `endUndoGroup` undo and redo as one step. Groups
   * do not nest (`invalid-value`). An undo or a redo ends the open group first, so undo while
   * grouping reverts the group as one step. An import that changes what the group changed splits
   * it in two undo steps: the transactions before the import and those after it.
   */
  beginUndoGroup(): void {
    this.idle()
    if (this.grouping) throw errors.invalidValue('$undo', 'group', 'is already open')
    try {
      this.undoManager.groupStart()
    } catch (error) {
      throw errors.engine(engineMessage(error))
    }
    this.grouping = true
  }

  /** Ends the open undo group; does nothing when none is open. */
  endUndoGroup(): void {
    this.idle()
    this.closeUndoGroup()
  }

  /** Drops the redo stack, keeping the undo stack. */
  clearRedo(): void {
    this.idle()
    this.undoManager.clearRedo()
  }

  /** Follows one text field: `listener` gets each change with whether this replica made it. */
  subscribeText(id: ObjectId, field: string, listener: (delta: TextDelta[], local: boolean) => void): () => void {
    checkField(id, field)
    const text = read.container(this.doc, this.schema, id, field, 'text')
    if (!text) throw errors.notFound(`${id}.${field}`)
    return text.subscribe((batch) => {
      for (const event of batch.events) {
        if (event.diff.type === 'text') listener(event.diff.diff as TextDelta[], batch.by === 'local')
      }
    })
  }

  /** The whole document in canonical form; see `stateText`. */
  stateJson(): unknown {
    return read.stateJson(this.doc, this.schema)
  }

  /** The canonical state as text; equal to the Rust `state_json().to_string()` for the same changes. */
  stateText(): string {
    return canonicalText(this.stateJson())
  }

  /** Records the changes an import left pending, and forgets those applied since. */
  private notePending(status: ImportStatus): void {
    for (const [peer, { end }] of status.pending ?? []) this.pending.set(peer, Math.max(end, this.pending.get(peer) ?? 0))
    if (this.pending.size === 0) return
    const applied = this.doc.oplogVersion()
    for (const [peer, end] of this.pending) if ((applied.get(peer) ?? 0) >= end) this.pending.delete(peer)
  }

  private idle(): void {
    if (this.busy) throw errors.engine('the document cannot change while a transaction runs; transactions do not nest')
  }

  private closeUndoGroup(): void {
    if (!this.grouping) return
    this.undoManager.groupEnd()
    this.grouping = false
  }

  /**
   * After an import, makes sure the open group is still open in the engine: the engine ends it
   * when the import changes what the group changed, and then the group goes on as a new one.
   * Starting a group the engine still has open changes nothing; if the engine can start none, no
   * group is open any more.
   */
  private reopenUndoGroup(): void {
    if (!this.grouping) return
    try {
      this.undoManager.groupStart()
    } catch (error) {
      if (!engineMessage(error).includes('already an active undo group')) this.grouping = false
    }
  }

  private history(run: () => boolean): boolean {
    this.idle()
    this.closeUndoGroup()
    const { value, changed } = observeChanges(this.doc, () => {
      try {
        return run()
      } catch (error) {
        throw errors.engine(engineMessage(error))
      }
    })
    for (const id of changed) this.changed.add(id)
    return value
  }
}

type Frontiers = ReturnType<LoroDoc['frontiers']>

const sameFrontiers = (a: Frontiers, b: Frontiers): boolean => {
  const key = (frontiers: Frontiers) => frontiers.map((id) => `${id.counter}@${id.peer}`).sort().join(',')
  return key(a) === key(b)
}
