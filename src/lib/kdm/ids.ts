// Copied from kition-sdk packages/kdm/src/ids.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { errors } from './errors'

/** The stable identity of one object in a document, unique across all replicas. */
export type ObjectId = string

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The hyphenated lowercase form of 16 UUID bytes. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

const UUID_FORMS = [
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i,
  /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^([0-9a-f]{32})$/i,
]

/** The 16 bytes of a UUID in any form the Rust `uuid` crate parses; anything else is an `encoding` error. */
export function uuidToBytes(text: string): Uint8Array {
  if (typeof text !== 'string') throw errors.encoding('a UUID is a string')
  for (const form of UUID_FORMS) {
    const match = form.exec(text)
    if (!match) continue
    const digits = match.slice(1).join('')
    const bytes = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) bytes[index] = parseInt(digits.slice(index * 2, index * 2 + 2), 16)
    return bytes
  }
  throw errors.encoding(`\`${text}\` is not a UUID`)
}

/** A UUID v7: 48-bit Unix milliseconds, version and variant bits, the rest random. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let time = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return uuidFromBytes(bytes)
}

/** A new object id. UUID v7: unique without coordination and roughly creation-ordered. */
export const newObjectId = (): ObjectId => uuidV7()

/** A new document id: a document's durable identity, never changed by renaming or moving its file. */
export const newDocId = (): string => uuidV7()

/** The engine reserves 2^64 - 1. */
const RESERVED_ACTOR = (1n << 64n) - 1n

/** Checks an actor id: an unsigned 64-bit integer other than the reserved 2^64 - 1. */
export function checkActor(actor: bigint): bigint {
  if (typeof actor !== 'bigint') throw errors.encoding('an actor id is a bigint')
  if (actor === RESERVED_ACTOR) throw errors.encoding('actor id u64::MAX is reserved')
  if (actor < 0n || actor > RESERVED_ACTOR) throw errors.encoding(`actor id ${actor} is not an unsigned 64-bit integer`)
  return actor
}

/** A fresh actor for one writable replica session; the top bit is clear because the engine reserves 2^64 - 1. */
export function randomActor(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return BigInt(`0x${hex(bytes)}`) >> 1n
}

/** What a handle names: an engine node, or the `index`-th node created by transaction `tx`, resolved once that commits. */
interface NodeState {
  id: string | null
  readonly pending?: { readonly tx: number; readonly index: number }
}

/** The state of every genuine handle. A handle not in it was not made by the KDM, and names no node. */
const NODES = new WeakMap<NodeRef, NodeState>()

/** Only this module constructs handles. */
const CONSTRUCT = Symbol('NodeRef')

/**
 * A node of a tree field. Valid in the replica that returned it and in every replica that has
 * the change that created it.
 *
 * A node created inside a transaction has no engine id until the transaction commits; its handle
 * resolves then. Handles compare (`equals`) by resolved node; two unresolved handles are equal only
 * if they are the same handle. A handle from a failed transaction never resolves, and using it is
 * a `not-found` error. Handles cannot be constructed or changed outside the KDM.
 */
export class NodeRef {
  /** The engine's id of the node once it exists in the document; `null` before. Read-only. */
  declare readonly id: string | null

  /** @internal */
  constructor(token: symbol, state: NodeState) {
    if (token !== CONSTRUCT) throw new TypeError('NodeRef handles come from Tx.treeCreate and Replica.tree')
    NODES.set(this, state)
    Object.defineProperty(this, 'id', { value: state.id, enumerable: true, writable: false, configurable: state.id === null })
  }

  equals(other: NodeRef): boolean {
    if (this.id !== null || other.id !== null) return this.id === other.id
    return this === other
  }
}

/** @internal A handle of a node in the document. */
export const committedNode = (id: string): NodeRef => new NodeRef(CONSTRUCT, { id })

/** @internal A handle of the `index`-th node transaction `tx` creates. */
export const pendingNode = (tx: number, index: number): NodeRef => new NodeRef(CONSTRUCT, { id: null, pending: { tx, index } })

/** @internal What a handle names, or `undefined` for an object the KDM did not make. */
export const nodeState = (node: NodeRef): Readonly<NodeState> | undefined => NODES.get(node)

/** @internal Resolves a pending handle once, when its transaction applies. */
export function resolveNode(node: NodeRef, id: string): void {
  const state = NODES.get(node)
  if (!state || state.id !== null) return
  state.id = id
  Object.defineProperty(node, 'id', { value: id, enumerable: true, writable: false, configurable: false })
}
