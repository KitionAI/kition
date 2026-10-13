// Copied from kition-sdk packages/kdm/src/value.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Values as the KDM stores them: JSON only, checked and copied when an operation is staged, so a
 * value that is not JSON never reaches the engine and later mutation of the caller's object
 * changes nothing.
 */

import { setKey } from './canonical'

/** A JSON value: what register fields, `json` fields, blobs, and map entries hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/**
 * The string the engine stores for `text`: a lone surrogate becomes U+FFFD (strings cross into the
 * engine as UTF-8), so pending reads and positions match committed ones.
 */
export function wellFormed(text: string): string {
  let out = ''
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0xd800 || unit > 0xdfff) continue
    if (unit <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      index += 1
      continue
    }
    out += `${text.slice(start, index)}\ufffd`
    start = index + 1
  }
  return start === 0 ? text : out + text.slice(start)
}

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * A checked deep copy of `value` as JSON: `null`, booleans, strings (lone surrogates normalised),
 * finite numbers, arrays, and plain objects (prototype `Object.prototype` or `null`, no `__proto__`
 * key, no symbol keys). Anything else (`undefined` inside a value, bigints, functions, symbols,
 * typed arrays, dates, maps, class instances, `NaN`, infinities, cycles) is refused through `fail`,
 * which answers the error to throw. A top-level `undefined` is `null`.
 */
export function toJson(value: unknown, fail: (reason: string) => Error): JsonValue {
  const ancestors = new Set<object>()
  const copy = (item: unknown, where: string): JsonValue => {
    const refuse = (what: string): never => {
      throw fail(`holds ${what}${where ? ` at ${where}` : ''}, which is not JSON`)
    }
    switch (typeof item) {
      case 'string':
        return wellFormed(item)
      case 'boolean':
        return item
      case 'number':
        return Number.isFinite(item) ? item : refuse(String(item))
      case 'object':
        break
      default:
        return refuse(typeof item === 'undefined' ? 'undefined' : `a ${typeof item}`)
    }
    if (item === null) return null
    if (ancestors.has(item)) refuse('a cycle')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) refuse('an array subclass')
        const out: JsonValue[] = []
        for (let index = 0; index < item.length; index += 1) {
          if (!(index in item)) refuse('a hole')
          out.push(copy(item[index], `${where}[${index}]`))
        }
        return out
      }
      if (!isPlainObject(item)) refuse(`a ${item.constructor?.name ?? 'non-plain object'}`)
      if (Object.getOwnPropertySymbols(item).length > 0) refuse('a symbol key')
      const out: { [key: string]: JsonValue } = {}
      for (const key of Object.keys(item)) {
        if (key === '__proto__') refuse('a `__proto__` key')
        setKey(out, wellFormed(key), copy((item as Record<string, unknown>)[key], `${where}.${key}`))
      }
      return out
    } finally {
      ancestors.delete(item)
    }
  }
  return value === undefined ? null : copy(value, '')
}
