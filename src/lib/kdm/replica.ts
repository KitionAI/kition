// Copied from kition-sdk packages/kdm/src/replica.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { isContainer as isEngineContainer, LoroDoc, UndoManager, type ContainerID, type ImportStatus, type LoroEventBatch, type LoroTreeNode, type PeerID } from 'loro-crdt'
import { canonicalText, compareKeys } from './canonical'
import { checkString } from './args'
import { open, sameBytes, Version, wrap } from './envelope'
import { errors, KdmError } from './errors'
import { checkActor, committedNode, uuidFromBytes, uuidToBytes, type NodeRef, type ObjectId, type TreeEntry } from './ids'
import { configure, type TextRun } from './marks'
import { checkOrigin, decodeCommit, encodeCommit, system, type Origin } from './origin'
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

/** An engine failure while applying operations that validation accepted. */
const applyingFailed = (error: unknown): KdmError => errors.engine(`applying a validated transaction failed: ${error instanceof Error ? error.message : String(error)}`)

const engineMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What an import into a shallow replica answers for changes that depend on history before its root; the Rust crate says the same. */
const CHANGES_BEFORE_ROOT = "the changes depend on history before this shallow replica's root; rebase it on a newer snapshot"
/** What a shallow replica answers for a fork at an earlier version; the Rust crate says the same. */
const VERSION_BEFORE_ROOT = 'a shallow replica forks only at its current version; read earlier versions from the server'
/** What `rebase` answers for a snapshot older than a shallow replica's root; the Rust crate says the same. */
const SNAPSHOT_BEFORE_ROOT = "the snapshot is older than this shallow replica's root; rebase it on a newer one"

/** An engine failure while importing bytes: `history-missing` for changes a shallow replica lacks the history of, `encoding` otherwise. */
const importing = (error: unknown): KdmError =>
  engineMessage(error).includes('not included in the shallow history') ? errors.historyMissing(CHANGES_BEFORE_ROOT) : errors.encoding(engineMessage(error))

/**
 * Runs `run` while observing which objects change. Change events are observed only during the
 * call: a document-wide subscription makes large local transactions slow to commit.
 */
function observeChanges<T>(doc: LoroDoc, run: () => T): { value: T; changed: Set<ObjectId>; registers: Register[] } {
  const found = new Set<ObjectId>()
  const registers: Register[] = []
  const unsubscribe = doc.subscribe((batch: LoroEventBatch) => {
    for (const event of batch.events) {
      if (event.path[0] !== read.OBJECTS) continue
      if (event.path.length >= 2) {
        found.add(String(event.path[1]))
        if (event.diff.type === 'map') {
          for (const [key, value] of Object.entries(event.diff.updated)) if (!isEngineContainer(value)) registers.push(registerKey(event.target, key))
        }
      } else if (event.diff.type === 'map') for (const key of Object.keys(event.diff.updated)) found.add(key)
    }
  })
  try {
    return { value: run(), changed: found, registers }
  } finally {
    unsubscribe()
  }
}

/**
 * A register: one key of a map container inside an object (a register field, or one key of a
 * `map` field), as `<container id>\u0000<key>`.
 */
type Register = string

const registerKey = (container: string, key: string): Register => `${container}\u0000${key}`

const registerParts = (register: Register): [string, string] => {
  const at = register.indexOf('\u0000')
  return [register.slice(0, at), register.slice(at + 1)]
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
  private undoManager: UndoManager
  private changed = new Set<ObjectId>()
  /** Set while a transaction's function runs: nothing else may change the document then. */
  private busy = false
  /** Set between `beginUndoGroup` and `endUndoGroup`. */
  private grouping = false
  /**
   * Set when a shallow replica refused an import (`newer-schema`) after the engine applied it: the
   * engine cannot rebuild a shallow document at an earlier version, so the replica refuses every
   * later change and export with the same error (standard 2.0 rule M16a).
   */
  private closedBy: KdmError | null = null
  /**
   * For each replica whose changes an import could not apply yet, the counter just past the last
   * of them. They are applied (and no longer pending) once `version` reaches it.
   */
  private readonly pending = new Map<PeerID, number>()
  /**
   * Registers an import changed: the candidates for another replica's later write, which an undo
   * or redo must keep (M12). Pruned at each undo and redo.
   */
  private importedRegisters = new Set<Register>()
  /**
   * Registers an undo or redo put back to another replica's value, with that value: still that
   * replica's write for the next undo or redo, though this replica wrote it last.
   */
  private keptRegisters = new Map<Register, unknown>()
  /**
   * The value this replica last wrote to each register (`undefined`: deleted it). Another
   * replica's later write of the same value is not a change an undo must keep (a script's own undo
   * that puts back this replica's value, for instance).
   */
  private ownRegisters = new Map<Register, unknown>()

  private constructor(
    private doc: LoroDoc,
    docIdBytes: Uint8Array,
    readonly schema: Schema,
    readonly actor: bigint,
  ) {
    this.docIdBytes = docIdBytes.slice()
    doc.setPeerId(actor)
    this.undoManager = undoManagerOf(doc)
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
    // Written before `build` runs, so its transaction reads the document's schema version.
    const meta = doc.getMap(read.META)
    meta.set('docId', uuidFromBytes(idBytes))
    meta.set('kit', schema.kit)
    meta.set(read.SCHEMA_VERSION, schema.schemaVersion)
    meta.set('kdm', KDM_VERSION)
    const { result, staged } = Tx.stage(doc, schema, build)
    // The new document is discarded on failure, so nothing needs reverting.
    try {
      staged.apply(doc, schema, () => undefined)
    } catch (error) {
      throw applyingFailed(error)
    }
    doc.commit({ origin: origin.kind, message: encodeCommit(origin, schema.schemaVersion) })
    return { replica: new Replica(doc, idBytes, schema, actor), result }
  }

  /**
   * Opens a snapshot (or a full change export) as a new writable replica of `actor`. Refuses
   * (`schema`) a document of another kit or of another KDM version, and (`newer-schema`) one whose
   * minimum schema version (rule M20) is newer than `schema`'s; bytes that are not a KDM snapshot
   * are `encoding` errors.
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
    const found = read.minSchemaVersion(doc)
    if (found === null) {
      throw errors.schema(`the document has schema version ${canonicalText(meta(read.SCHEMA_VERSION))}; this kit reads schema versions up to ${schema.schemaVersion}`)
    }
    if (found > schema.schemaVersion) throw errors.newerSchema(found, schema.schemaVersion)
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
   * The document's minimum schema version (rule M20): the version it was created with, or the
   * largest one a transaction raised it to (`Tx.raiseSchemaVersion`). Never more than this
   * replica's schema version: loads and imports refuse such documents.
   */
  minSchemaVersion(): number {
    return read.minSchemaVersion(this.doc) ?? 0
  }

  /**
   * The newest schema version any change of this replica was written under (rule M5a: every
   * commit records its author's schema version), or `null` when no change records one (they all
   * predate the rule). A version above this replica's schema means someone edits the document
   * with a newer kit: objects of types this schema lacks read as their `$type` only and refuse
   * edits here (`unknown-type`), and a host asks the person to update the kit. A shallow replica
   * (rule M16a) sees only the changes after its root.
   */
  authorSchemaVersion(): number | null {
    let newest: number | null = null
    for (const changes of this.doc.getAllChanges().values()) {
      for (const change of changes) {
        const version = change.message ? (decodeCommit(change.message)?.schemaVersion ?? null) : null
        if (version !== null && (newest === null || version > newest)) newest = version
      }
    }
    return newest
  }

  /**
   * Runs `f` as one transaction: one commit, one undo step, one origin. Operations are staged while
   * `f` runs and applied only if it returns: if `f` throws, the document, its version, and its
   * exports are unchanged and the error propagates. `f` must be synchronous.
   */
  transact<R>(origin: Origin, f: (tx: Tx) => R): R {
    this.idle()
    this.checkOpen()
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
    if (staged.raisesSchema && origin.kind !== SYSTEM) {
      throw errors.invalidValue('$meta', 'schemaVersion', `is raised only in a \`system\` transaction, not \`${origin.kind}\``)
    }
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
        this.doc.commit({ origin: ROLLBACK, message: encodeCommit(system('rollback'), this.schema.schemaVersion) })
      }
      throw applyingFailed(error)
    }
    this.doc.commit({ origin: origin.kind, message: encodeCommit(origin, this.schema.schemaVersion) })
    for (const id of touched) this.changed.add(id)
    this.noteOwnWrites(staged.registerWrites)
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
    this.checkOpen()
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
   *
   * Changes that raise the document's minimum schema version (rule M20) above this replica's
   * schema are `newer-schema` errors and change nothing: the state, the version, the exports, and
   * the changes still pending are as before the import. The engine cannot check changes without
   * applying them, so the replica is rebuilt from its history before the import; that clears its
   * undo and redo history, and `subscribeText` listeners stop receiving changes. A build that
   * meets this error is too old for the document: the host stops syncing and asks for an update.
   * A shallow replica cannot be rebuilt so: it keeps the changes and refuses every later change
   * and export with this error, and the host reopens the document from what it stored.
   *
   * On a shallow replica, changes that depend on history before its root (made by a replica that
   * had not seen the root yet) are `history-missing` errors and change nothing; see `rebase`.
   */
  importChanges(bytes: Uint8Array): Set<ObjectId> {
    this.idle()
    this.checkOpen()
    const { docId, engine } = open(bytes)
    if (!sameBytes(docId, this.docIdBytes)) throw errors.wrongDocument(this.docId, uuidFromBytes(docId))
    const before = this.doc.oplogFrontiers()
    let failure: unknown = null
    const { value: status, changed, registers } = observeChanges(this.doc, () => {
      try {
        return this.doc.import(engine)
      } catch (error) {
        failure = error
        return null
      }
    })
    const found = read.minSchemaVersion(this.doc)
    if (found !== null && found > this.schema.schemaVersion) {
      const error = errors.newerSchema(found, this.schema.schemaVersion)
      if (this.doc.isShallow()) {
        this.closedBy = error
        throw error
      }
      this.restore(before)
      throw error
    }
    if (status === null) throw importing(failure)
    for (const register of registers) this.importedRegisters.add(register)
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
    this.checkOpen()
    let bytes: Uint8Array
    try {
      bytes = this.doc.export({ mode: 'snapshot' })
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    return wrap(this.docIdBytes, bytes)
  }
  /**
   * A **shallow snapshot** (standard 2.0 rule M16a): the document's current state with only the
   * history after `at`, for a device that holds a large document without its whole history. `load`
   * opens it as a shallow replica, which edits, exports, imports, and merges like a full one;
   * history before its root stays with whoever holds it (the sync server).
   *
   * The root is the latest version at or before `at` that every later change descends from (the
   * engine moves it back past changes made concurrently with `at`, so they stay in the retained
   * history); `Version.empty()` keeps the whole history. `at` must be a version this replica has
   * (`invalid-value` otherwise); on a shallow replica, an `at` before its own root is its root.
   */
  shallowSnapshot(at: Version): Uint8Array {
    this.checkOpen()
    if (!(at instanceof Version)) throw new KdmError('invalid-value', 'a version must be a `Version`')
    if (!this.version().includes(at)) throw errors.invalidValue('$shallow', 'version', 'names changes this replica does not have')
    const frontiers = this.reaches(at) ? this.doc.vvToFrontiers(at.toEngine()) : this.doc.shallowSinceFrontiers()
    let bytes: Uint8Array
    try {
      bytes = this.doc.export({ mode: 'shallow-snapshot', frontiers })
    } catch (error) {
      throw errors.encoding(engineMessage(error))
    }
    return wrap(this.docIdBytes, bytes)
  }

  /** Whether this replica holds only part of the document's history: it was loaded from a `shallowSnapshot` (or a snapshot of a shallow replica). */
  isShallow(): boolean {
    return this.doc.isShallow()
  }

  /**
   * The version a shallow replica's retained history starts at (its root): it has every change
   * after it, and none of the history it summarizes. `null` for a full replica.
   */
  shallowRoot(): Version | null {
    return this.doc.isShallow() ? Version.fromEngine(this.doc.shallowSinceVV()) : null
  }

  /** Whether `version` is at or after this replica's shallow root: always, on a full replica. */
  private reaches(version: Version): boolean {
    const root = this.shallowRoot()
    return root === null || version.includes(root)
  }

  /**
   * Replaces this replica's document with `snapshot` (a full or shallow snapshot of the same
   * document, as a server answers it) plus every change this replica has that `snapshot` lacks,
   * and answers the objects whose state changed. For a shallow replica whose import failed with
   * `history-missing`: a newer snapshot from the server holds the changes it could not take,
   * rooted early enough for them, and this replica's own changes (pushed or not) are kept on top.
   * The state is what importing every change of both would give.
   *
   * Refuses (`wrong-document`) a snapshot of another document, what `load` refuses, and
   * (`history-missing`) a shallow snapshot whose root is after changes of this replica it lacks; a
   * refused rebase changes nothing. Clears the undo and redo history, like any load, and
   * `subscribeText` listeners stop receiving changes.
   */
  rebase(snapshot: Uint8Array): Set<ObjectId> {
    this.idle()
    this.checkOpen()
    const { docId } = open(snapshot)
    if (!sameBytes(docId, this.docIdBytes)) throw errors.wrongDocument(this.docId, uuidFromBytes(docId))
    const base = Replica.load(this.schema, snapshot, this.actor)
    if (!base.version().includes(this.version())) {
      base.importChanges(this.exportChanges(base.version()))
      // This replica is shallow and the snapshot is older than its root: the changes in between
      // are in neither.
      if (!base.version().includes(this.version())) throw errors.historyMissing(SNAPSHOT_BEFORE_ROOT)
    }
    const objects = (state: unknown): Record<string, unknown> => ((state as { objects?: Record<string, unknown> }).objects ?? {})
    const before = objects(this.stateJson())
    const after = objects(base.stateJson())
    const changed = new Set<ObjectId>()
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonicalText(before[id] ?? null) !== canonicalText(after[id] ?? null) || (id in before) !== (id in after)) changed.add(id)
    }
    this.undoManager.free()
    this.doc = base.doc
    this.undoManager = base.undoManager
    this.importedRegisters.clear()
    this.keptRegisters.clear()
    this.ownRegisters.clear()
    for (const [peer, end] of base.pending) this.pending.set(peer, Math.max(end, this.pending.get(peer) ?? 0))
    this.prunePending()
    this.reopenUndoGroup()
    for (const id of changed) this.changed.add(id)
    return sorted(changed)
  }


  /**
   * Undoes this replica's last transaction. Changes from other replicas are kept, including later
   * changes to the same object and to the same field: a register another replica wrote after the
   * undone transaction keeps that value (M12). The objects it changes are reported by
   * `takeChanged`.
   */
  undo(): boolean {
    return this.history(() => this.undoManager.undo())
  }

  /** Redoes the last undone transaction, keeping other replicas' later changes and reporting what it changes like `undo`. */
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

  /**
   * A draft of this document (standard 2.0 A12): a new writable replica of `actor` holding every
   * change this one has, with no undo history. Edits made on it stay there until `mergeChanges`
   * takes them into another replica of the document.
   */
  fork(actor: bigint): Replica {
    return this.forkAt(this.version(), actor)
  }

  /** A draft of this document as it was at `version` (see `fork`); `version` must be one this replica has reached. */
  forkAt(version: Version, actor: bigint): Replica {
    this.idle()
    this.checkOpen()
    checkActor(actor)
    if (!(version instanceof Version)) throw new KdmError('invalid-value', 'a version must be a `Version`')
    if (!this.version().includes(version)) throw errors.invalidValue('$draft', 'version', 'names changes this replica does not have')
    // The engine forks a shallow document only as a whole.
    if (this.doc.isShallow() && !version.equals(this.version())) throw errors.historyMissing(VERSION_BEFORE_ROOT)
    let doc: LoroDoc
    try {
      doc = this.doc.isShallow() ? this.doc.fork() : this.doc.forkAt(this.doc.vvToFrontiers(version.toEngine()))
    } catch (error) {
      throw errors.engine(engineMessage(error))
    }
    configure(doc, this.schema)
    return new Replica(doc, this.docIdBytes, this.schema, actor)
  }

  /**
   * The canonical state this replica would have after importing `changes`, without changing it:
   * the "after" of a draft's comparison (`diffStates`). Refuses what `mergeChanges` refuses.
   */
  mergedState(changes: Uint8Array): unknown {
    this.idle()
    this.checkOpen()
    return read.stateJson(this.mergedDoc(changes), this.schema)
  }

  /**
   * Takes another replica's changes (a draft's, made on a `fork`) into this one as one transaction
   * of its own, with `origin`: one undo step (unless `origin` is `system` or `import`). The result
   * is the state a CRDT import would give, so edits made here (or imported) since the draft was
   * forked are kept; only the operations that turn this state into the merged one are written,
   * under this replica's actor. Answers the objects that changed.
   *
   * The draft's changes themselves are not imported: merging the same changes twice writes their
   * effect twice, so a host merges a draft once. Refuses (`invalid-value`) changes that depend on
   * changes this replica lacks, changes of another document (`wrong-document`), and changes that
   * raise the minimum schema version beyond this replica's (`newer-schema`); a refused merge
   * changes nothing.
   */
  mergeChanges(changes: Uint8Array, origin: Origin): Set<ObjectId> {
    this.idle()
    this.checkOpen()
    checkOrigin(origin)
    const merged = this.mergedDoc(changes)
    const from = this.doc.oplogFrontiers()
    const to = merged.oplogFrontiers()
    if (sameFrontiers(from, to)) return new Set()
    let diff: ReturnType<LoroDoc['diff']>
    try {
      diff = merged.diff(from, to)
    } catch (error) {
      throw errors.engine(engineMessage(error))
    }
    let failure: unknown = null
    const { changed, registers } = observeChanges(this.doc, () => {
      try {
        this.doc.applyDiff(diff)
      } catch (error) {
        failure = error
        return
      }
      this.doc.commit({ origin: origin.kind, message: encodeCommit(origin, this.schema.schemaVersion) })
    })
    if (failure !== null) {
      // The engine refused part of a difference it computed itself: put back what it applied,
      // outside the undo history, as `transact` does.
      this.doc.commit({ origin: ROLLBACK })
      if (!sameFrontiers(this.doc.oplogFrontiers(), from)) {
        this.doc.revertTo(from)
        this.doc.commit({ origin: ROLLBACK, message: encodeCommit(system('rollback'), this.schema.schemaVersion) })
      }
      throw errors.engine(engineMessage(failure))
    }
    for (const register of registers) {
      const now = this.registerValue(register)
      if (!now.container) this.ownRegisters.set(register, now.value)
    }
    for (const id of changed) this.changed.add(id)
    return sorted(changed)
  }

  /** A copy of this document with `changes` imported, checked as `mergeChanges` checks them. */
  private mergedDoc(changes: Uint8Array): LoroDoc {
    const { docId, engine } = open(changes)
    if (!sameBytes(docId, this.docIdBytes)) throw errors.wrongDocument(this.docId, uuidFromBytes(docId))
    const merged = this.doc.fork()
    configure(merged, this.schema)
    let status: ImportStatus
    try {
      status = merged.import(engine)
    } catch (error) {
      throw importing(error)
    }
    if (status.pending && status.pending.size > 0) throw errors.invalidValue('$draft', 'changes', 'depend on changes this replica does not have')
    const found = read.minSchemaVersion(merged)
    if (found !== null && found > this.schema.schemaVersion) throw errors.newerSchema(found, this.schema.schemaVersion)
    return merged
  }

  /** The whole document in canonical form; see `stateText`. */
  stateJson(): unknown {
    return read.stateJson(this.doc, this.schema)
  }

  /** The canonical state as text; equal to the Rust `state_json().to_string()` for the same changes. */
  stateText(): string {
    return canonicalText(this.stateJson())
  }

  /**
   * Replaces the document with its history up to `frontiers`, dropping every change applied since.
   * Changes still pending stay recorded in `pending`: they are missing again, and a sync fetches
   * them.
   */
  private restore(frontiers: Frontiers): void {
    let doc: LoroDoc
    try {
      doc = this.doc.forkAt(frontiers)
    } catch (error) {
      throw errors.engine(engineMessage(error))
    }
    configure(doc, this.schema)
    doc.setPeerId(this.actor)
    this.undoManager.free()
    this.doc = doc
    this.undoManager = undoManagerOf(doc)
    // No undo history is left to protect registers from.
    this.importedRegisters.clear()
    this.keptRegisters.clear()
    this.ownRegisters.clear()
    this.reopenUndoGroup()
  }

  /** Records the changes an import left pending, and forgets those applied since. */
  private notePending(status: ImportStatus): void {
    for (const [peer, { end }] of status.pending ?? []) this.pending.set(peer, Math.max(end, this.pending.get(peer) ?? 0))
    this.prunePending()
  }

  /** Forgets the pending changes applied since they were recorded. */
  private prunePending(): void {
    if (this.pending.size === 0) return
    const applied = this.doc.oplogVersion()
    for (const [peer, end] of this.pending) if ((applied.get(peer) ?? 0) >= end) this.pending.delete(peer)
  }

  /** Throws the error that closed this shallow replica, if one did (see `importChanges`). */
  private checkOpen(): void {
    if (this.closedBy) throw this.closedBy
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
    this.checkOpen()
    this.closeUndoGroup()
    const others = this.othersRegisters()
    const { value, changed, registers } = observeChanges(this.doc, () => {
      try {
        return run()
      } catch (error) {
        throw errors.engine(engineMessage(error))
      }
    })
    for (const id of changed) this.changed.add(id)
    for (const register of registers) {
      const now = this.registerValue(register)
      if (!now.container) this.ownRegisters.set(register, now.value)
    }
    // The engine's inverse operation sets a register back even when another replica wrote it
    // later; put those back to the other replica's value, in a `system` commit (not an undo
    // step), so the result is as if the undo had skipped them.
    const touched = new Set(registers)
    let restored = false
    for (const [register, value] of others) {
      if (!touched.has(register)) continue
      const now = this.registerValue(register)
      if (now.container || sameValue(now.value, value)) continue
      const [container, key] = registerParts(register)
      const map = this.doc.getContainerById(container as ContainerID) as unknown as { set(key: string, value: unknown): void; delete(key: string): void }
      if (value === undefined) map.delete(key)
      else map.set(key, value)
      this.keptRegisters.set(register, value)
      restored = true
    }
    if (restored) this.doc.commit({ origin: SYSTEM, message: encodeCommit(system('keep-later-changes'), this.schema.schemaVersion) })
    return value
  }

  /** A register's value now (`undefined`: absent), and whether it holds a container instead. */
  private registerValue(register: Register): { value: unknown; container: boolean; lastEditor: PeerID | undefined } {
    const [container, key] = registerParts(register)
    const map = this.doc.getContainerById(container as ContainerID) as unknown as
      | { get(key: string): unknown; getLastEditor(key: string): PeerID | undefined }
      | undefined
    if (!map) return { value: undefined, container: false, lastEditor: undefined }
    const value = map.get(key)
    return { value, container: isEngineContainer(value), lastEditor: map.getLastEditor(key) }
  }

  /**
   * The registers whose current value another replica wrote, with that value (`undefined`:
   * deleted there): an import changed them and another peer wrote them last, or an earlier undo or
   * redo kept them for another replica and nothing changed them since. Prunes both candidate sets
   * of registers that are this replica's own again.
   */
  private othersRegisters(): Array<[Register, unknown]> {
    const out: Array<[Register, unknown]> = []
    const me = String(this.actor) as PeerID
    for (const [register, kept] of this.keptRegisters) {
      const now = this.registerValue(register)
      if (!now.container && sameValue(now.value, kept)) out.push([register, kept])
      else this.keptRegisters.delete(register)
    }
    for (const register of this.importedRegisters) {
      if (this.keptRegisters.has(register)) continue
      const now = this.registerValue(register)
      if (now.container || now.lastEditor === undefined || now.lastEditor === me) this.importedRegisters.delete(register)
      // Another replica wrote this replica's own value again: nothing to keep.
      else if (!(this.ownRegisters.has(register) && sameValue(this.ownRegisters.get(register), now.value))) out.push([register, now.value])
    }
    return out
  }

  /** Records the registers a local transaction wrote, with their values. */
  private noteOwnWrites(writes: ReadonlyArray<{ id: ObjectId; field: string | null; key: string; value: unknown }>): void {
    for (const { id, field, key, value } of writes) {
      let container: string
      try {
        const object = read.objectMap(this.doc, id)
        if (field === null) container = object.id
        else {
          const map = object.get(field)
          if (!isEngineContainer(map) || map.kind() !== 'Map') continue
          container = map.id
        }
      } catch {
        continue
      }
      this.ownRegisters.set(registerKey(container, key), value)
    }
  }
}

type Frontiers = ReturnType<LoroDoc['frontiers']>

/** Register values are JSON values: equal when their canonical texts are. */
const sameValue = (a: unknown, b: unknown): boolean => a === b || (a !== undefined && b !== undefined && canonicalText(a) === canonicalText(b))

/** The undo manager of a replica's document. */
const undoManagerOf = (doc: LoroDoc): UndoManager => new UndoManager(doc, { mergeInterval: 0, excludeOriginPrefixes: [ROLLBACK, SYSTEM, IMPORT] })

const sameFrontiers = (a: Frontiers, b: Frontiers): boolean => {
  const key = (frontiers: Frontiers) => frontiers.map((id) => `${id.counter}@${id.peer}`).sort().join(',')
  return key(a) === key(b)
}
