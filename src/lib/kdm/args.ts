// Copied from kition-sdk packages/kdm/src/args.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Run-time checks of arguments. Plain JavaScript callers bypass the static types, so every public
 * method checks what it is given before it reads or stages anything: a wrong argument is a
 * `KdmError` and never reaches the engine.
 */
import { errors, KdmError } from './errors'

/** A short, safe description of a value for a message (a symbol cannot be put in a template). */
export function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** Checks that `value` (named `what` in the message) is a string. */
export function checkString(what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new KdmError('invalid-value', `${what} must be a string, not ${describe(value)}`)
}

/** Checks an index or count: a whole number from 0 (`out-of-range` otherwise). */
export function checkIndex(what: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new KdmError('out-of-range', `${what} ${describe(value)} is out of range: it must be a whole number from 0`)
  }
}

/** Checks that `value` is a plain object (prototype `Object.prototype` or `null`) without symbol keys. */
export function checkRecord(what: string, value: unknown): asserts value is Record<string, unknown> {
  const prototype = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value as object).length > 0) {
    throw new KdmError('invalid-value', `${what} must be a plain object, not ${describe(value)}`)
  }
}

/** The form of an object id a host chooses (generated ids are UUID v7, which also match). */
export const OBJECT_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9:_-]{0,127}'
const OBJECT_ID = new RegExp(`^${OBJECT_ID_PATTERN}$`)

/** Checks the syntax of an id a host gives to a new object of type `ty` (`invalid-value` otherwise). */
export function checkObjectIdSyntax(ty: string, id: string): void {
  if (!OBJECT_ID.test(id)) throw errors.invalidValue(ty, '$id', `cannot be \`${id}\`: an object id matches \`${OBJECT_ID_PATTERN}\``)
}
