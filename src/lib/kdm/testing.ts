// Copied from kition-sdk packages/kdm/src/testing.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Multi-replica testing: a network of replicas of one document with seeded delivery order,
 * mirroring the Rust `kition_kdm::testing`. A test helper, not meant for production use; bad input
 * is still an error.
 */
import { errors } from './errors'
import { newDocId } from './ids'
import { Version } from './envelope'
import { Replica } from './replica'
import type { Schema } from './schema'

const MASK = (1n << 64n) - 1n

/** A small deterministic random generator (xorshift64*), the same as the Rust one, so failing seeds reproduce. */
export class Rng {
  private state: bigint

  constructor(seed: number | bigint) {
    this.state = ((BigInt(seed) * 0x9e3779b97f4a7c15n) & MASK) | 1n
  }

  nextU64(): bigint {
    this.state ^= this.state >> 12n
    this.state = (this.state ^ (this.state << 25n)) & MASK
    this.state ^= this.state >> 27n
    return (this.state * 0x2545f4914f6cdd1dn) & MASK
  }

  /** A value in `0..bound`, or 0 when `bound` is 0. */
  below(bound: number): number {
    return bound <= 0 ? 0 : Number(this.nextU64() % BigInt(bound))
  }

  shuffle<T>(items: T[]): void {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = this.below(index + 1)
      ;[items[index], items[other]] = [items[other], items[index]]
    }
  }
}

/** `count` replicas of one new document, each with its own actor (1, 2, 3, ...). */
export class Network {
  readonly replicas: Replica[]
  readonly rng: Rng

  /** Fails with `out-of-range` when `count` is 0: a network has at least one replica. */
  constructor(schema: Schema, count: number, seed: number | bigint = 1) {
    if (!Number.isSafeInteger(count) || count < 1) throw errors.outOfRange(0, 0)
    const first = Replica.create(schema, newDocId(), 1n)
    const snapshot = first.snapshot()
    this.replicas = [first]
    for (let actor = 2; actor <= count; actor += 1) this.replicas.push(Replica.load(schema, snapshot, BigInt(actor)))
    this.rng = new Rng(seed)
  }

  /** Sends what `to` lacks from `from`. */
  deliver(from: number, to: number): void {
    const target = this.replica(to)
    target.importChanges(this.replica(from).exportChanges(target.version()))
  }

  /**
   * Delivers every replica's changes to every other replica in a seeded order, then sends
   * everything again from scratch to prove that duplicates are harmless.
   */
  syncAll(): void {
    const count = this.replicas.length
    const pairs: Array<[number, number]> = []
    for (let from = 0; from < count; from += 1) {
      for (let to = 0; to < count; to += 1) if (from !== to) pairs.push([from, to])
    }
    this.rng.shuffle(pairs)
    for (const [from, to] of pairs) this.deliver(from, to)
    for (const [from, to] of pairs) this.replica(to).importChanges(this.replica(from).exportChanges(Version.empty()))
  }

  /** The common canonical state; throws with both states when two replicas differ, or when there are no replicas. */
  converged(): string {
    const [reference, ...others] = this.replicas
    if (!reference) throw new Error('the network has no replicas')
    const first = reference.stateText()
    others.forEach((replica, index) => {
      const text = replica.stateText()
      if (text !== first) throw new Error(`replica 0 and ${index + 1} differ:\n${first}\n---\n${text}`)
    })
    return first
  }

  private replica(index: number): Replica {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.replicas.length) throw errors.outOfRange(index, this.replicas.length)
    return this.replicas[index]
  }
}
