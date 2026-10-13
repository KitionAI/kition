// Copied from kition-sdk packages/kdm/src/envelope.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** Versions, and the envelope every byte string a replica exports carries. */
import { VersionVector, type PeerID } from 'loro-crdt'
import { compareKeys } from './canonical'
import { errors } from './errors'

/** A replica's version: the set of changes it contains. Exchanged to ask for what is missing. */
export class Version {
  /** Each peer's counter, sorted by peer: compares structurally. */
  private readonly counters: ReadonlyArray<readonly [string, number]>

  private constructor(counters: Array<readonly [string, number]>) {
    this.counters = counters.sort((a, b) => compareKeys(a[0], b[0]))
  }

  static empty(): Version {
    return new Version([])
  }

  static decode(bytes: Uint8Array): Version {
    let vv: VersionVector
    try {
      vv = VersionVector.decode(bytes)
    } catch (error) {
      throw errors.encoding(String(error))
    }
    return Version.fromEngine(vv)
  }

  /** @internal */
  static fromEngine(vv: VersionVector): Version {
    return new Version([...vv.toJSON().entries()])
  }

  /** @internal */
  toEngine(): VersionVector {
    return VersionVector.parseJSON(new Map(this.counters as Array<[PeerID, number]>))
  }

  encode(): Uint8Array {
    return this.toEngine().encode()
  }

  equals(other: Version): boolean {
    return this.counters.length === other.counters.length && this.counters.every(([peer, counter], index) => peer === other.counters[index][0] && counter === other.counters[index][1])
  }
}

/** Every byte string a replica exports: 4-byte magic, the 16-byte document UUID, then the engine's bytes. */
const MAGIC = [0x4b, 0x44, 0x4d, 0x01]

export function wrap(docId: Uint8Array, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(MAGIC.length + docId.length + bytes.length)
  out.set(MAGIC)
  out.set(docId, MAGIC.length)
  out.set(bytes, MAGIC.length + docId.length)
  return out
}

export function open(bytes: Uint8Array): { docId: Uint8Array; engine: Uint8Array } {
  if (!(bytes instanceof Uint8Array)) throw errors.encoding('the bytes are not a Uint8Array')
  if (bytes.length < 20 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw errors.encoding('the bytes are not a KDM export')
  return { docId: bytes.subarray(4, 20), engine: bytes.subarray(20) }
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])
