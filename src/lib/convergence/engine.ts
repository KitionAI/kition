// Copied from kition-sdk packages/convergence/src/engine.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * An adapter base for TypeScript engines made with `@kition/kit-engine` (`kitEngineClass` over a
 * `KitModel`): the replica members go through the contract 2 document class a host drives
 * (`version`, `exportChanges`, `importChanges`, `snapshot`, `undo`, `redo`, `blobs`, `addBlobs`,
 * `execute`), and a replica joins a snapshot as a new `KitSession` on its own actor. A kit adds
 * what only it knows: a new document with content, random edits from its command catalogue, the
 * scripted steps on its probe, its text, and its view check.
 */
import { randomActor, Replica } from '../kdm'
import { KitSession, type KitEngineDocument, type KitModel } from '../kit-engine'
import type { Blobs, KitAdapter, Script } from './adapter'
import type { Rng } from './rng'

/** A document of a `kitEngineClass` class: the contract 2 members and its session. */
export type EngineDocument<View> = KitEngineDocument & { readonly session: KitSession<View> }

/** The class `kitEngineClass(model)` makes, as far as the adapter needs it. */
export type EngineClass<View> = new (session: KitSession<View>) => EngineDocument<View>

/** Blobs as `openWithReplica` and `addBlobs` take them: `(64-character hex SHA-256, u64 LE length, bytes) * N`. */
export function encodeBlobBundle(blobs: Blobs): Uint8Array {
  const parts: Uint8Array[] = []
  for (const hash of [...blobs.keys()].sort()) {
    const bytes = blobs.get(hash) as Uint8Array
    const length = new Uint8Array(8)
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true)
    parts.push(new TextEncoder().encode(hash), length, bytes)
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Reads a blob bundle (`encodeBlobBundle`). */
export function decodeBlobBundle(bundle: Uint8Array): Blobs {
  const blobs: Blobs = new Map()
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength)
  let at = 0
  while (at < bundle.length) {
    if (at + 72 > bundle.length) throw new Error('a truncated blob bundle')
    const hash = new TextDecoder().decode(bundle.subarray(at, at + 64))
    const length = Number(view.getBigUint64(at + 64, true))
    const start = at + 72
    if (start + length > bundle.length) throw new Error('a truncated blob bundle')
    blobs.set(hash, bundle.slice(start, start + length))
    at = start + length
  }
  return blobs
}

/** What every `kitEngineClass` adapter shares. */
export type KitEngineAdapterOptions<View> = {
  /** The kit id (`kit.board`). */
  name: string
  /** `model/schema.json` as text. */
  schema: string
  model: KitModel<View>
  /** `kitEngineClass(model)`: the class the kit's module exports. */
  documentClass: EngineClass<View>
  /** The actor of each new replica; random by default. */
  actor?: () => bigint
  /** The file name `exportFile` saves as; without it the export checks are skipped. */
  fileName?: string
}

export abstract class KitEngineAdapter<View> implements KitAdapter<EngineDocument<View>> {
  readonly name: string
  readonly schema: string
  protected readonly model: KitModel<View>
  protected readonly documentClass: EngineClass<View>
  protected readonly newActor: () => bigint
  protected readonly fileName: string | null

  constructor(options: KitEngineAdapterOptions<View>) {
    this.name = options.name
    this.schema = options.schema
    this.model = options.model
    this.documentClass = options.documentClass
    this.newActor = options.actor ?? randomActor
    this.fileName = options.fileName ?? null
  }

  /** A new document with some content (several objects, and text when the kit has text). */
  abstract create(): EngineDocument<View>
  abstract randomEdit(doc: EngineDocument<View>, rng: Rng): string | null

  /** A document over `replica`, as the kit's class makes one. */
  protected open(replica: Replica): EngineDocument<View> {
    return new this.documentClass(new KitSession(this.model, replica))
  }

  join(snapshot: Uint8Array, blobs: Blobs): EngineDocument<View> {
    const doc = this.open(Replica.load(this.model.schema, snapshot, this.newActor()))
    this.addBlobs(doc, blobs)
    return doc
  }

  version(doc: EngineDocument<View>) {
    return doc.version()
  }

  exportChanges(doc: EngineDocument<View>, since: Uint8Array) {
    return doc.exportChanges(since)
  }

  importChanges(doc: EngineDocument<View>, bytes: Uint8Array) {
    doc.importChanges(bytes)
  }

  snapshot(doc: EngineDocument<View>) {
    return doc.snapshot()
  }

  state(doc: EngineDocument<View>): unknown {
    return doc.session.replica.stateJson()
  }

  undo(doc: EngineDocument<View>): boolean {
    return (JSON.parse(doc.undo()) as { done: boolean }).done
  }

  redo(doc: EngineDocument<View>): boolean {
    return (JSON.parse(doc.redo()) as { done: boolean }).done
  }

  blobs(doc: EngineDocument<View>): Blobs {
    return decodeBlobBundle(doc.blobs())
  }

  addBlobs(doc: EngineDocument<View>, blobs: Blobs): void {
    if (blobs.size > 0) doc.addBlobs(encodeBlobBundle(blobs))
  }

  exportFile(doc: EngineDocument<View>): Uint8Array | null {
    return this.fileName === null ? null : doc.save(this.fileName)
  }

  script(_doc: EngineDocument<View>, _step: Script): boolean {
    return false
  }

  /** Runs one of the kit's commands as the host's person, through the document's `execute`; answers its JSON result. */
  protected run(doc: EngineDocument<View>, command: string, params: Record<string, unknown>): unknown {
    return JSON.parse(doc.execute(command, JSON.stringify(params)))
  }
}

/** The UTF-16 index of code point `at` of `text` (KDM text positions are UTF-16 in TypeScript, code points in the suite). */
export function utf16Index(text: string, at: number): number {
  let index = 0
  for (let count = 0; count < at && index < text.length; count += 1) {
    const code = text.codePointAt(index) as number
    index += code > 0xffff ? 2 : 1
  }
  return index
}
