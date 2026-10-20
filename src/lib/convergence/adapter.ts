// Copied from kition-sdk packages/convergence/src/adapter.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * What a kit supplies to the suite: the TypeScript twin of the Rust `KitAdapter` and `Script`.
 * Errors are thrown; the suite reports them with the scenario.
 */
import type { Rng } from './rng'

/** Blob bytes by SHA-256 (lowercase hex), as a replica hands them to a peer. */
export type Blobs = Map<string, Uint8Array>

/**
 * A scripted step the suite asks a kit for. Each acts on the kit's **probe**: an object (or text)
 * the adapter picks deterministically from the document's state (the first slide's first shape,
 * the first paragraph), so every replica that has the same state picks the same one. An adapter
 * answers `false` for a step its kit has no equivalent of; the scenarios that need it are then
 * reported as skipped. Text positions count Unicode scalar values (code points), not UTF-16 units.
 */
export type Script =
  /** Sets one register field of the probe object to a value derived from `value`. Slots 0 and 1 MUST be different fields of the same object. */
  | { kind: 'SetField'; slot: number; value: number }
  /** Creates one object of the kit's main kind (a shape, a paragraph, a layer). */
  | { kind: 'Create' }
  /** Deletes the probe object. */
  | { kind: 'Delete' }
  /** Duplicates the probe object. */
  | { kind: 'Duplicate' }
  /** Moves an item of an ordered collection; `which` 0 and 1 SHOULD move different items. */
  | { kind: 'Reorder'; which: number }
  /** Moves an object under another parent; `which` 0 and 1 SHOULD make conflicting moves (each into the other) when the kit allows it. */
  | { kind: 'Reparent'; which: number }
  /** Inserts `text` at code point `at` of `KitAdapter.text`. */
  | { kind: 'InsertText'; at: number; text: string }
  /** Deletes `len` code points at `at` of `KitAdapter.text`. */
  | { kind: 'DeleteText'; at: number; len: number }
  /** Splits the paragraph at code point `at`: a `\n` appears there. */
  | { kind: 'SplitParagraph'; at: number }
  /** Merges the paragraphs on both sides of the `\n` at code point `at`. */
  | { kind: 'MergeParagraph'; at: number }
  /** Adds content backed by a new blob whose bytes derive from `seed`. */
  | { kind: 'InsertBlob'; seed: number }

/** A step as the Rust suite's `{:?}` writes it, for messages: `InsertText { at: 1, text: "zh" }`. */
export function describeStep(step: Script): string {
  const { kind, ...fields } = step
  const parts = Object.entries(fields).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
  return parts.length === 0 ? kind : `${kind} { ${parts.join(', ')} }`
}

/** A contract 2 kit as the suite drives it; `Doc` is one replica (an open document). */
export interface KitAdapter<Doc> {
  /** The kit id, for reports (`kit.board`). */
  readonly name: string
  /** The kit's KDM schema (`model/schema.json`) as text, which the reference checks read. */
  readonly schema: string
  /** A new document with some content (several objects, and text when the kit has text). */
  create(): Doc
  /** Another replica of a document: opens `snapshot` with its blobs, as a new actor. */
  join(snapshot: Uint8Array, blobs: Blobs): Doc
  /** The encoded version vector. */
  version(doc: Doc): Uint8Array
  /** The changes a replica at `since` lacks; empty `since` asks for every change. */
  exportChanges(doc: Doc, since: Uint8Array): Uint8Array
  /** Takes changes from a peer or from storage, in any order, any number of times. */
  importChanges(doc: Doc, bytes: Uint8Array): void
  snapshot(doc: Doc): Uint8Array
  /** The canonical state (`Replica.stateJson`). */
  state(doc: Doc): unknown
  /** Undoes this replica's last step; answers whether there was one. */
  undo(doc: Doc): boolean
  redo(doc: Doc): boolean
  /**
   * One random edit through the kit's commands; answers a label for the step log, or `null` when
   * the picked command did not apply. A command the kit refuses for the document's state is `null`,
   * not an error.
   */
  randomEdit(doc: Doc, rng: Rng): string | null
  /** Runs a scripted step; `false` when the kit has no such step (the default). */
  script?(doc: Doc, step: Script): boolean
  /** The document's text in reading order, paragraphs joined by `\n`, or `null` (the default) when the kit has no text the suite can type into. */
  text?(doc: Doc): string | null
  /** Throws when the view (what the engine renders and saves) does not match the replica. */
  checkView?(doc: Doc): void
  /** The blobs the replica holds, for a peer (none by default). */
  blobs?(doc: Doc): Blobs
  /** Adds a peer's blobs. */
  addBlobs?(doc: Doc, blobs: Blobs): void
  /** The document as file bytes, when the kit can save; `null` (the default) skips the export checks. */
  exportFile?(doc: Doc): Uint8Array | null
  /** Whether `ty.field` may name an object that no longer exists (Kit Standard `spec/sets/model.md`). */
  allowsDangling?(ty: string, field: string): boolean
}

/** What the suite runs. */
export type Options = {
  /** Seeds of the fuzzed runs; each runs on every replica count of `replicas`. */
  seeds: number[]
  /** Replica counts of the fuzzed runs (2 to 5). */
  replicas: number[]
  /** Steps of each fuzzed run. */
  steps: number
}

export const DEFAULT_OPTIONS: Readonly<Options> = Object.freeze({ seeds: [1, 2, 3], replicas: [2, 3, 5], steps: 120 })

/**
 * The default options, heavier when the environment asks (nightly jobs):
 * `KITION_CONVERGENCE_SEEDS=<n>` runs seeds 1 to n, `KITION_CONVERGENCE_STEPS=<n>` n steps.
 */
export function optionsFromEnv(env: Record<string, string | undefined>): Options {
  const options: Options = { ...DEFAULT_OPTIONS, seeds: [...DEFAULT_OPTIONS.seeds], replicas: [...DEFAULT_OPTIONS.replicas] }
  const count = Number.parseInt(env.KITION_CONVERGENCE_SEEDS ?? '', 10)
  if (Number.isSafeInteger(count) && count >= 0) options.seeds = Array.from({ length: Math.max(count, 1) }, (_, index) => index + 1)
  const steps = Number.parseInt(env.KITION_CONVERGENCE_STEPS ?? '', 10)
  if (Number.isSafeInteger(steps) && steps >= 0) options.steps = Math.max(steps, 1)
  return options
}
