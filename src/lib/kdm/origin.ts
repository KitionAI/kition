// Copied from kition-sdk packages/kdm/src/origin.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { KdmError } from './errors'

/** Who caused a transaction. */
export type OriginKind = 'person' | 'agent' | 'extension' | 'import' | 'system'

/**
 * The origin of a transaction: its kind, the principal it acts for, and a label for history.
 * Authorization never trusts it; a server checks the authenticated principal instead.
 */
export interface Origin {
  kind: OriginKind
  principal: string
  label?: string
}

/**
 * The undo history a transaction joins (rule M12a): a person's undo and an agent's undo on one
 * replica each take back only their own steps, and keep the other's like another replica's.
 */
export type UndoScope = 'person' | 'agent'

/** The scope of a transaction of `kind`; `null` for `import` and `system`, which are no undo step. */
export function undoScopeOf(kind: OriginKind): UndoScope | null {
  if (kind === 'person' || kind === 'extension') return 'person'
  if (kind === 'agent') return 'agent'
  return null
}

export const person = (principal: string, label?: string): Origin => ({ kind: 'person', principal, label })
export const agent = (principal: string, label?: string): Origin => ({ kind: 'agent', principal, label })
export const system = (label: string): Origin => ({ kind: 'system', principal: 'kdm', label })

/** The commit message form, identical to the Rust encoding: a JSON array `[kind, principal, label]`. */
export function encodeOrigin(origin: Origin): string {
  return JSON.stringify([origin.kind, origin.principal, origin.label ?? null])
}

const KINDS: readonly string[] = ['person', 'agent', 'extension', 'import', 'system']

/** Checks an origin given at run time: one of the five kinds, a string principal, and an optional string label. */
export function checkOrigin(origin: unknown): asserts origin is Origin {
  const value = origin !== null && typeof origin === 'object' ? (origin as Record<string, unknown>) : null
  const ok =
    value !== null &&
    typeof value.kind === 'string' &&
    KINDS.includes(value.kind) &&
    typeof value.principal === 'string' &&
    (value.label === undefined || typeof value.label === 'string')
  if (!ok) throw new KdmError('invalid-value', `an origin needs a kind (${KINDS.join(', ')}), a string principal, and an optional string label`)
}

/**
 * The commit message of every transaction (standard 2.0 rule M5a): its origin and the schema version
 * of the replica that made it, a JSON array `[kind, principal, label, schemaVersion]`, identical to
 * the Rust encoding. `decodeOrigin` reads it too (it reads the first three elements); a message
 * written before rule M5a has no fourth element.
 */
export function encodeCommit(origin: Origin, schemaVersion: number): string {
  return JSON.stringify([origin.kind, origin.principal, origin.label ?? null, schemaVersion])
}

/**
 * A commit message's origin and author schema version (`null` when the message predates rule
 * M5a or names none), or `null` when the message is not a KDM commit message.
 */
export function decodeCommit(text: string): { origin: Origin; schemaVersion: number | null } | null {
  const origin = decodeOrigin(text)
  if (origin === null) return null
  const version = (JSON.parse(text) as unknown[])[3]
  return { origin, schemaVersion: typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : null }
}

export function decodeOrigin(text: string): Origin | null {
  let parts: unknown
  try {
    parts = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parts) || typeof parts[0] !== 'string' || !KINDS.includes(parts[0]) || typeof parts[1] !== 'string') return null
  return { kind: parts[0] as OriginKind, principal: parts[1], label: typeof parts[2] === 'string' ? parts[2] : undefined }
}
