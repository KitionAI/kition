// Copied from kition-sdk packages/sdk/src/port.ts by scripts/sync-kit-host.mjs; change it there, not here.
import type { BatchRequest, BatchResult, Origin } from '../kdm'

/** One kit command as a kit's catalogue lists it. */
export type KitCommandInfo = {
  id: string
  title?: string
  menu?: string[] | null
  shortcut?: string | null
  params?: string | null
  description?: string
  schema?: unknown
  mutates?: boolean
  enabled?: boolean
}

/** The document was written to its file or storage: the storage's new version, or the file it went to. */
export type SavedEvent = { version: string | null; uri?: string }
/** The people in the document's collaboration room, this person included, as the host knows them. */
export type PresenceEvent = { peers: ReadonlyArray<Record<string, unknown>> }
/** A save was refused because the file changed elsewhere since it was read: nothing was overwritten. */
export type ConflictEvent = { message: string }
/** The objects the person selected in the kit's editor, as KDM object ids. */
export type SelectionEvent = { ids: string[] }

/** The document events a source reports besides `changed`, and what each carries. */
export type DocumentEvents = { saved: SavedEvent; presence: PresenceEvent; conflict: ConflictEvent; selection: SelectionEvent }
export type DocumentEventName = keyof DocumentEvents

/** The events a source reports: which (`events`), and how to hear one (`on`). */
export interface DocumentEventSource {
  /** The events of `DocumentEvents` this source reports; any other is never heard. */
  readonly events?: readonly DocumentEventName[]
  /** Hears one of `events`; answers an unsubscribe. */
  on?<E extends DocumentEventName>(event: E, listener: (value: DocumentEvents[E]) => void): () => void
}

/**
 * A contract 2 document as the object model reaches it: the engine's change exchange and its
 * commands. Every kit editor (`KitConnection` with the `replica` capability), every kit engine
 * (`exportChanges`, `importChanges`, `executeAs`), and an `@kition/embed` editor give one.
 */
export interface ModelPort extends DocumentEventSource {
  readonly kitId: string
  /** The engine's changes since the encoded version `since`; empty bytes ask for every change. */
  exportChanges(since: Uint8Array): Promise<Uint8Array>
  /** Hands the engine changes made elsewhere; it takes them as a collaborator's. */
  importChanges(changes: Uint8Array): Promise<void>
  /** Runs a command; answers its result. */
  command(id: string, params: unknown, origin: Origin): Promise<unknown>
  commands(): Promise<KitCommandInfo[]>
  /** Whether the document refuses edits. */
  readOnly?(): boolean
  /** Hears the engine's replica move (its version when known). */
  onChanged?(listener: (version: Uint8Array | null) => void): () => void
  /**
   * The object model answered by the kit itself (the Kit UI capability `model`), when it does: a
   * batch is then one undo step of the person's history. `openDocument` prefers it to running
   * the batch on its own replica.
   */
  model?: KitModel
}

/**
 * A kit's own `model/describe` and `model/batch`. `schema` is the kit's KDM schema, for a kit
 * whose engine does not describe its own. A refused batch rejects with a `BatchError`.
 */
export interface KitModel {
  describe(schema: object): Promise<Record<string, unknown>>
  /** `version` is the kit's replica version after the batch, when it has one. */
  batch(request: BatchRequest, schema: object): Promise<BatchResult & { version?: Uint8Array | null }>
}
