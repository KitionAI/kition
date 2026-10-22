// Copied from kition-sdk packages/kit-engine/src/session.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `KitSession`: the TypeScript twin of `kition_sdk::session` (architecture 7.1 and 7.2). A kit
 * supplies a `KitModel`, its materialised view over a KDM replica and its commands, and
 * `kitEngineClass` makes the contract 2 document class from it: the replica, the exchange of
 * changes, undo and redo, the saved state, and the JSON of the contract.
 */
import { decodeOrigin, person, randomActor, system, Version, type ObjectId, type Origin, type Replica, type Schema, type Tx } from '../kdm'
import type { KitDamage, KitEngineClass, KitEngineCommand, KitEngineDiagnostic, KitEngineDocument } from './contract'

/** The person a contract 1 `execute` acts for; hosts that know who it is use `executeAs`. */
const HOST_PERSON = person('host:person')

export type KitSize = { width: number; height: number }

/**
 * A kit's engine on the KDM: its view of a replica and how commands change the replica.
 *
 * - E11: `load` builds the view, `apply` patches it from the objects an import, undo, or redo
 *   changed (throw to have it loaded again).
 * - E12: `command` turns a command into transactions on the replica (`replica.transact`); a view
 *   that changes itself first records the difference as the command's transaction, as long as
 *   `apply` still brings it up to date.
 * - E13: `import` makes a new replica from file bytes (`Replica.createWith`), `export` writes the
 *   file from the replica.
 * - E14: `validate` repairs what a merge left invalid; its changes commit with origin `system`.
 */
export interface KitModel<View> {
  readonly schema: Schema
  load(replica: Replica): View
  apply(view: View, replica: Replica, changed: ReadonlySet<ObjectId>): KitDamage
  /** Runs `id`; answers its JSON result. Throw to refuse it. */
  command(view: View, replica: Replica, id: string, params: Record<string, unknown>, origin: Origin): unknown
  commands(view: View, replica: Replica): KitEngineCommand[]
  /** Repairs, as one transaction; answers whether it wrote anything. */
  validate?(tx: Tx, replica: Replica, changed: ReadonlySet<ObjectId>): boolean
  import(name: string, bytes: Uint8Array, actor: bigint): Replica
  /**
   * Opens file bytes with the replica a host stored for them (`openWithReplica`), for a format that
   * does not hold its replica (Markdown): the replica from `snapshot` (a KDM snapshot or a full
   * change export, `blobs` its media), and what the file says that it lacks as a `system` import
   * change; empty `bytes` open the replica alone. Without it, a stored replica adds nothing to a
   * file that holds its own, which opens as `import` makes it.
   */
  openReplica?(name: string, bytes: Uint8Array, snapshot: Uint8Array, blobs: Uint8Array, actor: bigint): Replica
  export(view: View, replica: Replica, name: string): Uint8Array
  /** A new document; without it, `create` refuses. */
  create?(name: string, size: KitSize, actor: bigint): Replica
  /**
   * Media: the blob bundle the replica's changes refer to, and taking one in. Without them the
   * document has no media: `blobs()` is empty and a bundle someone sends is refused.
   */
  blobs?(view: View, replica: Replica): Uint8Array
  addBlobs?(view: View, replica: Replica, blobs: Uint8Array): void
  /** What `inspect()` adds to `canUndo` and `canRedo`. */
  inspect?(view: View, replica: Replica): Record<string, unknown>
  /** What is wrong with the document (Kit Harness Protocol (KHP) 2.0 A21); without it, `check()` answers none. It must not change the document. */
  check?(view: View, replica: Replica): KitEngineDiagnostic[]
  /** The document's size in pixels (0 × 0 when the editor draws itself). */
  size?(view: View, replica: Replica): KitSize
}

const NO_DAMAGE: KitDamage = { kind: 'none' }
const FULL_DAMAGE: KitDamage = { kind: 'full' }

/** Both damages: full absorbs everything, rects add up. */
export function mergeDamage(a: KitDamage, b: KitDamage): KitDamage {
  if (a.kind === 'full' || b.kind === 'full') return FULL_DAMAGE
  if (a.kind === 'none') return b
  if (b.kind === 'none') return a
  return { kind: 'rects', rects: [...a.rects, ...b.rects] }
}

/** One document: a replica, the model's view of it, and its saved state. */
export class KitSession<View> {
  private viewState: View
  private savedVersion: Version
  /** The version the bytes of the last `save()` hold, until `markSaved`. */
  private pendingSave: Version | null = null
  private revisionCount = 0n

  constructor(
    readonly model: KitModel<View>,
    readonly replica: Replica,
  ) {
    replica.takeChanged()
    this.viewState = model.load(replica)
    // Whatever loading repaired is not an edit of the person's.
    replica.takeChanged()
    this.savedVersion = replica.version()
  }

  get view() {
    return this.viewState
  }

  get revision() {
    return this.revisionCount
  }

  get dirty() {
    return !this.replica.version().equals(this.savedVersion)
  }

  /** Runs a command as `origin`; the view follows what it committed. */
  execute(id: string, params: Record<string, unknown>, origin: Origin): unknown {
    const before = this.replica.version()
    const result = this.model.command(this.viewState, this.replica, id, params, origin)
    // A view that changed itself first is current already; one that did not follows the replica.
    const changed = this.replica.takeChanged()
    if (changed.size > 0) this.refresh(changed)
    if (!this.replica.version().equals(before)) this.revisionCount += 1n
    return result
  }

  /** Imports another replica's changes; repairs what they left invalid. */
  importChanges(bytes: Uint8Array): KitDamage {
    const before = this.replica.version()
    this.replica.importChanges(bytes)
    const damage = this.settle()
    if (!this.replica.version().equals(before)) this.revisionCount += 1n
    return damage
  }

  undo(): { done: boolean; damage: KitDamage } {
    const done = this.replica.undo()
    const damage = done ? this.settle() : NO_DAMAGE
    if (done) this.revisionCount += 1n
    return { done, damage }
  }

  redo(): { done: boolean; damage: KitDamage } {
    const done = this.replica.redo()
    const damage = done ? this.settle() : NO_DAMAGE
    if (done) this.revisionCount += 1n
    return { done, damage }
  }

  /** The file bytes; the document stays unsaved until `markSaved`. */
  save(name: string): Uint8Array {
    const bytes = this.model.export(this.viewState, this.replica, name)
    this.pendingSave = this.replica.version()
    return bytes
  }

  markSaved() {
    if (this.pendingSave) this.savedVersion = this.pendingSave
    this.pendingSave = null
  }

  /** After an import, undo, or redo: validate over what changed (a `system` repair), then apply both. */
  private settle(): KitDamage {
    const changed = this.replica.takeChanged()
    if (changed.size === 0) return NO_DAMAGE
    const validate = this.model.validate
    let repairError: unknown = null
    if (validate) {
      try {
        this.replica.transact(system('repair'), (tx) => validate.call(this.model, tx, this.replica, changed))
      } catch (error) {
        repairError = error
      }
      for (const id of this.replica.takeChanged()) changed.add(id)
    }
    const damage = this.refresh(changed)
    if (repairError) throw repairError
    return damage
  }

  /** Applies `changed` to the view; if that fails, loads the view again so it still matches. */
  private refresh(changed: ReadonlySet<ObjectId>): KitDamage {
    try {
      const damage = this.model.apply(this.viewState, this.replica, changed)
      // What applying repaired is part of the same step.
      this.replica.takeChanged()
      return damage
    } catch {
      this.viewState = this.model.load(this.replica)
      this.replica.takeChanged()
      return FULL_DAMAGE
    }
  }
}

function parseParams(params: string): Record<string, unknown> {
  if (params.trim() === '') return {}
  const value = JSON.parse(params) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`the parameters are not a JSON object: ${params}`)
  return value as Record<string, unknown>
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value)
}

/** Transparent RGBA8 pixels of `width` × `height`. */
function transparent(width: number, height: number) {
  return new Uint8Array(Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * 4)
}

/** Options of `kitEngineClass`. */
export type KitEngineClassOptions = {
  /** The actor of each new replica; a random one by default (each open document is its own replica). */
  actor?: () => bigint
}

/**
 * The contract 2 document class for `model`, to export under the manifest's `engine.class`:
 *
 * ```ts
 * export const BoardDocument = kitEngineClass(boardModel)
 * ```
 */
export function kitEngineClass<View>(model: KitModel<View>, options: KitEngineClassOptions = {}): KitEngineClass & (new (session: KitSession<View>) => KitEngineDocument & { readonly session: KitSession<View> }) {
  const actor = options.actor ?? randomActor

  class Document implements KitEngineDocument {
    constructor(readonly session: KitSession<View>) {}

    static contractVersion() {
      return 1
    }

    static open(name: string, bytes: Uint8Array) {
      return new Document(new KitSession(model, model.import(name, bytes, actor())))
    }

    /**
     * The file with the replica stored for it: the model's `openReplica`, or, for a format whose
     * files hold their replica, the file alone (the stored replica adds nothing it lacks).
     */
    static openWithReplica(name: string, bytes: Uint8Array, snapshot: Uint8Array, blobs: Uint8Array) {
      if (model.openReplica) return new Document(new KitSession(model, model.openReplica(name, bytes, snapshot, blobs, actor())))
      return Document.open(name, bytes)
    }

    static create(name: string, width: number, height: number) {
      if (!model.create) throw new Error('this kit cannot create documents')
      return new Document(new KitSession(model, model.create(name, { width, height }, actor())))
    }

    private size() {
      return model.size?.(this.session.view, this.session.replica) ?? { width: 0, height: 0 }
    }

    get width() {
      return this.size().width
    }

    get height() {
      return this.size().height
    }

    get revision() {
      return this.session.revision
    }

    get dirty() {
      return this.session.dirty
    }

    get docId() {
      return this.session.replica.docId
    }

    render(_x: number, _y: number, _scale: number, width: number, height: number) {
      return transparent(width, height)
    }

    renderArea(_x0: number, _y0: number, _x1: number, _y1: number, width: number, height: number) {
      return transparent(width, height)
    }

    execute(command: string, params: string) {
      return this.executeAs(command, params, JSON.stringify([HOST_PERSON.kind, HOST_PERSON.principal, null]))
    }

    executeAs(command: string, params: string, origin: string) {
      const decoded = decodeOrigin(origin)
      if (!decoded) throw new Error(`origin is not [kind, principal, label]: ${origin}`)
      const parsed = parseParams(params)
      if (command === 'edit.undo' || command === 'undo') return json(this.session.undo())
      if (command === 'edit.redo' || command === 'redo') return json(this.session.redo())
      return json(this.session.execute(command, parsed, decoded))
    }

    inspect() {
      const extra = model.inspect?.(this.session.view, this.session.replica) ?? {}
      return json({ ...extra, canUndo: this.canUndo(), canRedo: this.canRedo() })
    }

    check() {
      const order = { error: 0, warning: 1, info: 2 } as const
      const found = [...(model.check?.(this.session.view, this.session.replica) ?? [])].sort((a, b) => order[a.severity] - order[b.severity])
      return json({ diagnostics: found })
    }

    commands() {
      return json(this.catalog())
    }

    disabledCommands() {
      return json(this.catalog().filter((command) => !command.enabled).map((command) => command.id))
    }

    private catalog(): KitEngineCommand[] {
      const history: KitEngineCommand[] = [
        { id: 'edit.undo', title: 'Undo', menu: ['Edit'], shortcut: 'Cmd+Z', mutates: true, enabled: this.canUndo() },
        { id: 'edit.redo', title: 'Redo', menu: ['Edit'], shortcut: 'Cmd+Shift+Z', mutates: true, enabled: this.canRedo() },
      ]
      const own = model.commands(this.session.view, this.session.replica)
      return [...history.filter((entry) => !own.some((command) => command.id === entry.id)), ...own]
    }

    save(name = 'document') {
      return this.session.save(name)
    }

    markSaved() {
      this.session.markSaved()
    }

    free() {
      // Nothing outside the garbage collector's reach.
    }

    version() {
      return this.session.replica.version().encode()
    }

    exportChanges(since: Uint8Array) {
      return this.session.replica.exportChanges(since.length === 0 ? Version.empty() : Version.decode(since))
    }

    importChanges(changes: Uint8Array) {
      return json(this.session.importChanges(changes))
    }

    snapshot() {
      return this.session.replica.snapshot()
    }

    undo() {
      return json(this.session.undo())
    }

    redo() {
      return json(this.session.redo())
    }

    canUndo() {
      return this.session.replica.canUndo()
    }

    canRedo() {
      return this.session.replica.canRedo()
    }

    schemaVersion() {
      return this.session.replica.schema.schemaVersion
    }

    authorSchemaVersion() {
      return this.session.replica.authorSchemaVersion()
    }

    blobs() {
      return model.blobs?.(this.session.view, this.session.replica) ?? new Uint8Array(0)
    }

    addBlobs(blobs: Uint8Array) {
      if (model.addBlobs) model.addBlobs(this.session.view, this.session.replica, blobs)
      else if (blobs.length > 0) throw new Error('this kit\'s documents hold no media')
    }
  }

  return Document
}
