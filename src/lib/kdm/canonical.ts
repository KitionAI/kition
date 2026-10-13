// Copied from kition-sdk packages/kdm/src/canonical.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The canonical JSON form shared by every KDM implementation: object keys sorted, compact, and
 * numbers written as the Rust crate writes them (`serde_json`), so the same state is the same text.
 */

/** The largest integer magnitude written as an integer: JavaScript holds integers up to ±2^53 exactly. */
const SAFE = 2 ** 53

/**
 * Sets `key` of `target` as an own enumerable property, also when the key is `__proto__` (which
 * plain assignment would turn into a prototype change, losing the key).
 */
export function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  else target[key] = value
}

/**
 * A deep copy with object keys sorted, for values handed to callers. Not itself the canonical
 * form: only `canonicalText` is (JavaScript cannot express the Rust number forms as values).
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort(compareKeys)) {
      if (source[key] !== undefined) setKey(out, key, canonical(source[key]))
    }
    return out
  }
  return value
}

/** Rust sorts keys by their UTF-8 bytes; for UTF-16 strings that is code point order, not code unit order. */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.codePointAt(index) as number
    const y = b.codePointAt(index) as number
    if (x !== y) return x < y ? -1 : 1
    if (x > 0xffff) index += 1
  }
  return a.length - b.length
}

/**
 * A number as `serde_json` writes it after the Rust `canonical`: whole numbers within ±2^53 as
 * integers, other numbers in the shortest form that round-trips, in decimal notation when the
 * decimal point falls within 16 digits of the start (`9100000000000000.0`, `0.00001`) and in
 * exponent notation otherwise (`1e+16`, `1e-6`, `1.5e+300`).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null'
  if (Number.isInteger(value) && Math.abs(value) <= SAFE) return String(value)
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const point = Number(exponentText) + 1
  const sign = value < 0 ? '-' : ''
  let text: string
  if (point >= digits.length && point <= 16) text = `${digits}${'0'.repeat(point - digits.length)}.0`
  else if (point > 0 && point <= 16) text = `${digits.slice(0, point)}.${digits.slice(point)}`
  else if (point > -5 && point <= 0) text = `0.${'0'.repeat(-point)}${digits}`
  else {
    const exponent = point - 1
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : ''
    text = `${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`
  }
  return sign + text
}

/** The canonical text of a value: equal to the Rust `canonical(value).to_string()`. */
export function canonicalText(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(source).sort(compareKeys)) {
      if (source[key] !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalText(source[key])}`)
    }
    return `{${parts.join(',')}}`
  }
  return 'null'
}
