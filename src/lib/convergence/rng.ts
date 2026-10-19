// Copied from kition-sdk packages/convergence/src/rng.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * A small deterministic random generator (xorshift64*), so failing seeds reproduce: the same
 * sequence as the Rust `kition_convergence::Rng` (and `@kition/kdm`'s `Rng`), so one seed drives
 * the same scenario in both runners.
 */
const MASK = (1n << 64n) - 1n

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

  /** `true` with `percent` percent probability. */
  chance(percent: number): boolean {
    return this.nextU64() % 100n < BigInt(percent)
  }

  shuffle<T>(items: T[]): void {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = this.below(index + 1)
      ;[items[index], items[other]] = [items[other], items[index]]
    }
  }

  /** One item, or `undefined` for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    return items[this.below(items.length)]
  }
}
