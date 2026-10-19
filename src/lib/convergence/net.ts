// Copied from kition-sdk packages/convergence/src/net.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** Replicas of one document and the exchange between them: the Rust `kition_convergence::Net`. */
import { canonicalText } from '../kdm'
import { describeStep, type Blobs, type KitAdapter, type Script } from './adapter'
import { Rng } from './rng'
import { checkReferences, firstDifference, SchemaInfo } from './state'

/** Thrown by `Net.step` when the kit has no such step: the scenario is skipped. */
export class Skip extends Error {}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

const EMPTY = new Uint8Array(0)

/** The text of `error` for a message. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs `f`; prefixes the message of what it throws. */
export function context<T>(prefix: string, f: () => T): T {
  try {
    return f()
  } catch (error) {
    if (error instanceof Skip) throw error
    throw new Error(`${prefix}${message(error)}`)
  }
}

/**
 * `count` replicas of one new document: the first made by `KitAdapter.create`, the others joined
 * from its snapshot. Exported so a kit can write scenarios of its own on the same harness.
 */
export class Net<Doc> {
  readonly docs: Doc[]
  readonly schema: SchemaInfo
  rng: Rng
  /** The snapshot and blobs every replica started from. */
  readonly initial: { snapshot: Uint8Array; blobs: Blobs }

  constructor(
    readonly kit: KitAdapter<Doc>,
    count: number,
    seed: number | bigint,
  ) {
    this.schema = SchemaInfo.parse(kit.schema)
    const first = context('create: ', () => kit.create())
    const snapshot = kit.snapshot(first)
    const blobs = blobsOf(kit, first)
    this.docs = [first]
    for (let index = 1; index < Math.max(count, 1); index += 1) this.docs.push(context('join: ', () => kit.join(snapshot, blobs)))
    this.rng = new Rng(seed)
    this.initial = { snapshot, blobs }
  }

  doc(index: number): Doc {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.docs.length) throw new Error(`no replica ${index} of ${this.docs.length}`)
    return this.docs[index]
  }

  state(index: number): unknown {
    return this.kit.state(this.doc(index))
  }

  /** Runs a scripted step on one replica; `false` when the kit has no such step. */
  script(index: number, step: Script): boolean {
    const doc = this.doc(index)
    return context(`replica ${index}: ${describeStep(step)}: `, () => this.kit.script?.(doc, step) ?? false)
  }

  /** Like `script`, and skips the scenario (throws `Skip`) when the kit has no such step. */
  step(index: number, step: Script): void {
    if (!this.script(index, step)) throw new Skip(`the adapter has no ${step.kind}`)
  }

  /** Like `script`, and fails when the kit has no such step. */
  must(index: number, step: Script): void {
    if (!this.script(index, step)) throw new Error(`the adapter does not support ${describeStep(step)}`)
  }

  text(index: number): string {
    const text = this.kit.text?.(this.doc(index)) ?? null
    if (text === null) throw new Error('the adapter has no text')
    return text
  }

  /** Sends `to` what it lacks from `from`, blobs first. */
  deliver(from: number, to: number): void {
    const since = this.kit.version(this.doc(to))
    const bytes = this.kit.exportChanges(this.doc(from), since)
    const blobs = blobsOf(this.kit, this.doc(from))
    const target = this.doc(to)
    this.kit.addBlobs?.(target, blobs)
    context(`replica ${to} importing from ${from}: `, () => this.kit.importChanges(target, bytes))
  }

  /**
   * Delivers every replica's changes to every other in seeded orders until no state changes
   * (repairs made on import travel too), then sends everything again from scratch to prove
   * duplicates harmless.
   */
  sync(): void {
    const count = this.docs.length
    const pairs: Array<[number, number]> = []
    for (let from = 0; from < count; from += 1) {
      for (let to = 0; to < count; to += 1) if (to !== from) pairs.push([from, to])
    }
    let previous: string[] | null = null
    for (let round = 0; round < 12; round += 1) {
      this.rng.shuffle(pairs)
      for (const [from, to] of pairs) this.deliver(from, to)
      const states = this.docs.map((_, index) => canonicalText(this.state(index) ?? null))
      if (previous !== null && previous.length === states.length && previous.every((state, index) => state === states[index])) break
      previous = states
    }
    for (const [from, to] of pairs) {
      const bytes = this.kit.exportChanges(this.doc(from), EMPTY)
      context(`replica ${to} importing a duplicate of everything from ${from}: `, () => this.kit.importChanges(this.doc(to), bytes))
    }
  }

  /** The common state; throws with the first difference. */
  converged(): unknown {
    const first = this.state(0)
    const text = canonicalText(first ?? null)
    for (let index = 1; index < this.docs.length; index += 1) {
      const other = this.state(index)
      if (canonicalText(other ?? null) !== text) throw new Error(`replicas 0 and ${index} differ at ${firstDifference(first, other) ?? ''}`)
    }
    return first
  }

  /** `converged`, the schema's references, and every replica's view. */
  check(): unknown {
    const state = this.converged()
    checkReferences(this.schema, state, (ty, field) => this.kit.allowsDangling?.(ty, field) ?? false)
    this.docs.forEach((doc, index) => context(`replica ${index}'s view: `, () => this.kit.checkView?.(doc)))
    return state
  }

  /** `sync` then `check`. */
  settle(): unknown {
    this.sync()
    return this.check()
  }
}

/** The blobs a replica holds (a copy). */
export function blobsOf<Doc>(kit: KitAdapter<Doc>, doc: Doc): Blobs {
  return new Map(kit.blobs?.(doc) ?? [])
}
