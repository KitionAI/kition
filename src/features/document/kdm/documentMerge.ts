/**
 * Text differences and the three-way merge of an external file change into a document replica.
 *
 * Positions are UTF-16 code units (the KDM's and CodeMirror's); no edit ever starts or ends inside
 * a surrogate pair.
 */
import type { ObjectId, Tx } from '@/lib/kdm'
import { DOCUMENT_BODY } from './documentSchema'

/** Replaces `from..to` of a text with `insert`. Lists of edits are sorted and separated (each starts after the previous one ends). */
export type TextEdit = { from: number; to: number; insert: string }

/** A differing region of two token sequences: `a[aFrom, aTo)` became `b[bFrom, bTo)`. */
type Hunk = { aFrom: number; aTo: number; bFrom: number; bTo: number }

const LF = 10
/** The diff gives up on detail (not on correctness) past about this many token comparisons. */
const DIFF_WORK = 20_000_000
/** And past this many edits, which bounds its memory (about the square of it). */
const DIFF_MAX_EDITS = 2_000

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/**
 * The length of the common prefix of `a` and `b` up to `limit`, shortened so that it never ends
 * between the two halves of a surrogate pair.
 */
export function commonPrefixLength(a: string, b: string, limit = Math.min(a.length, b.length)): number {
  let length = 0
  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length += 1
  if (length > 0 && isHighSurrogate(a.charCodeAt(length - 1))) length -= 1
  return length
}

/** The length of the common suffix of `a` and `b` up to `limit`, never starting between the halves of a surrogate pair. */
export function commonSuffixLength(a: string, b: string, limit = Math.min(a.length, b.length)): number {
  let length = 0
  while (length < limit && a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)) length += 1
  if (length > 0 && isLowSurrogate(a.charCodeAt(a.length - length))) length -= 1
  return length
}

/**
 * The shortest edit script from `a` to `b` (Myers), as hunks; `null` when it needs more than
 * `maxEdits` insertions and deletions.
 */
function myers(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits: number): Hunk[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  /** `trace[d]`: the furthest x per diagonal before step d, for diagonals -d-1..d+1. */
  const trace: Int32Array[] = []
  const limit = Math.min(max, maxEdits)
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], steps: number, n: number, m: number): Hunk[] {
  const reversed: Hunk[] = []
  let x = n
  let y = m
  for (let d = steps; d > 0; d -= 1) {
    const before = trace[d]
    const at = (k: number) => before[k + d + 1]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    const startX = down ? previousX : previousX + 1
    reversed.push({ aFrom: previousX, aTo: startX, bFrom: previousY, bTo: startX - k })
    x = previousX
    y = previousY
  }
  const hunks: Hunk[] = []
  for (let index = reversed.length - 1; index >= 0; index -= 1) {
    const step = reversed[index]
    const last = hunks[hunks.length - 1]
    if (last && last.aTo === step.aFrom && last.bTo === step.bFrom) {
      last.aTo = step.aTo
      last.bTo = step.bTo
    } else hunks.push({ ...step })
  }
  return hunks
}

/** Hunks of `a` to `b`, or one hunk of everything when the exact script costs too much. */
function diffTokens(a: ArrayLike<number>, b: ArrayLike<number>): Hunk[] {
  const size = a.length + b.length
  const maxEdits = Math.min(DIFF_MAX_EDITS, Math.max(64, Math.floor(DIFF_WORK / Math.max(1, size))))
  return myers(a, b, maxEdits) ?? [{ aFrom: 0, aTo: a.length, bFrom: 0, bTo: b.length }]
}

const hunkSize = (hunk: Hunk) => Math.max(hunk.aTo - hunk.aFrom, hunk.bTo - hunk.bFrom)

/**
 * Joins hunks separated by an equality no longer than the changes on both sides of it, so that
 * replacing a word is one edit rather than a scatter of single characters it happens to share.
 */
function joinNoise(hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = []
  for (const hunk of hunks) {
    let current = hunk
    for (let last = out[out.length - 1]; last; last = out[out.length - 1]) {
      const equal = current.aFrom - last.aTo
      if (equal > hunkSize(last) || equal > hunkSize(current)) break
      out.pop()
      current = { aFrom: last.aFrom, aTo: current.aTo, bFrom: last.bFrom, bTo: current.bTo }
    }
    out.push(current)
  }
  return out
}

/** Code points of `text` and the UTF-16 offset of each (plus the end). */
function codePoints(text: string): { points: Int32Array; offsets: Int32Array } {
  const points: number[] = []
  const offsets: number[] = []
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index)!
    points.push(point)
    offsets.push(index)
    index += point > 0xffff ? 2 : 1
  }
  offsets.push(text.length)
  return { points: Int32Array.from(points), offsets: Int32Array.from(offsets) }
}

/** Character-level edits from `x` to `y`, relative to `x`, offset by `at`. */
function refine(x: string, y: string, at: number, out: TextEdit[]): void {
  if (!x || !y) {
    out.push({ from: at, to: at + x.length, insert: y })
    return
  }
  const prefix = commonPrefixLength(x, y)
  const suffix = commonSuffixLength(x, y, Math.min(x.length, y.length) - prefix)
  const xs = x.slice(prefix, x.length - suffix)
  const ys = y.slice(prefix, y.length - suffix)
  const start = at + prefix
  if (!xs || !ys) {
    out.push({ from: start, to: start + xs.length, insert: ys })
    return
  }
  const a = codePoints(xs)
  const b = codePoints(ys)
  for (const hunk of joinNoise(diffTokens(a.points, b.points))) {
    out.push({ from: start + a.offsets[hunk.aFrom], to: start + a.offsets[hunk.aTo], insert: ys.slice(b.offsets[hunk.bFrom], b.offsets[hunk.bTo]) })
  }
}

/**
 * Character-level edits of a hunk of several lines, unless all they keep is white space (such
 * as the line endings of unrelated lines): then the lines are replaced as a whole, so that text
 * inserted between them elsewhere stays between whole lines.
 */
function refineLines(x: string, y: string, at: number, out: TextEdit[]): void {
  const edits: TextEdit[] = []
  refine(x, y, at, edits)
  let kept = ''
  let from = at
  for (const edit of edits) {
    kept += x.slice(from - at, edit.from - at)
    from = edit.to
  }
  kept += x.slice(from - at)
  if (/^\s*$/.test(kept)) out.push({ from: at, to: at + x.length, insert: y })
  else out.push(...edits)
}

/** Lines of `text` (each with its `\n`, the last possibly without), as ids shared through `ids`, and their start offsets. */
function lineTokens(text: string, ids: Map<string, number>): { tokens: Int32Array; starts: Int32Array } {
  const tokens: number[] = []
  const starts: number[] = []
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline + 1
    const line = text.slice(start, end)
    let id = ids.get(line)
    if (id === undefined) {
      id = ids.size
      ids.set(line, id)
    }
    tokens.push(id)
    starts.push(start)
    start = end
  }
  starts.push(text.length)
  return { tokens: Int32Array.from(tokens), starts: Int32Array.from(starts) }
}

/**
 * The edits from `a` to `b`: a line diff, refined to characters inside changed lines. Edits are
 * sorted, separated, relative to `a`, and never split a surrogate pair. Large, heavily changed
 * texts get coarser edits rather than a slow diff.
 */
export function diffText(a: string, b: string): TextEdit[] {
  if (a === b) return []
  // The common start and end, cut back to whole lines.
  const rawPrefix = commonPrefixLength(a, b)
  const start = rawPrefix === 0 ? 0 : a.lastIndexOf('\n', rawPrefix - 1) + 1
  let suffix = commonSuffixLength(a, b, Math.min(a.length, b.length) - rawPrefix)
  const suffixStart = a.length - suffix
  if (suffix > 0 && suffixStart > start && a.charCodeAt(suffixStart - 1) !== LF) {
    const newline = a.indexOf('\n', suffixStart)
    suffix = newline === -1 ? 0 : a.length - (newline + 1)
  }
  const am = a.slice(start, a.length - suffix)
  const bm = b.slice(start, b.length - suffix)
  const out: TextEdit[] = []
  if (!am || !bm) {
    out.push({ from: start, to: start + am.length, insert: bm })
    return out
  }
  const ids = new Map<string, number>()
  const al = lineTokens(am, ids)
  const bl = lineTokens(bm, ids)
  for (const hunk of diffTokens(al.tokens, bl.tokens)) {
    const aFrom = al.starts[hunk.aFrom]
    const bFrom = bl.starts[hunk.bFrom]
    const x = am.slice(aFrom, al.starts[hunk.aTo])
    const y = bm.slice(bFrom, bl.starts[hunk.bTo])
    if (hunk.aTo - hunk.aFrom === 1 && hunk.bTo - hunk.bFrom === 1) refine(x, y, start + aFrom, out)
    else refineLines(x, y, start + aFrom, out)
  }
  return out
}

/** `text` with `edits` (relative to `text`) applied. */
export function applyEditsToString(text: string, edits: readonly TextEdit[]): string {
  let out = ''
  let at = 0
  for (const edit of edits) {
    out += text.slice(at, edit.from) + edit.insert
    at = edit.to
  }
  return out + text.slice(at)
}

/** Applies `edits` (relative to the field's text when the call starts) to a text field. */
export function applyTextEdits(tx: Tx, id: ObjectId, field: string, edits: readonly TextEdit[]): void {
  let shift = 0
  for (const edit of edits) {
    const at = edit.from + shift
    const removed = edit.to - edit.from
    if (removed > 0) tx.textDelete(id, field, at, removed)
    if (edit.insert) tx.textInsert(id, field, at, edit.insert)
    shift += edit.insert.length - removed
  }
}

/**
 * The edits that bring the external change `base → incoming` into `current` (which holds local
 * edits made since `base`), relative to `current`.
 *
 * Both changes are diffed from `base`; then base text survives when neither side deleted it, and
 * every insertion of both sides is kept, the local one first where both insert at one place. An
 * external edit of a range that was also edited locally inserts its text next to the local edit
 * and deletes only the base text that is still there. A change made identically on both sides is
 * applied once.
 */
export function mergeEdits(base: string, incoming: string, current: string): TextEdit[] {
  if (incoming === base || incoming === current) return []
  const external = diffText(base, incoming)
  const local = base === current ? [] : diffText(base, current)
  const out: TextEdit[] = []
  const push = (from: number, to: number, insert: string) => {
    const last = out[out.length - 1]
    if (last && last.to === from) {
      last.to = to
      last.insert += insert
    } else out.push({ from, to, insert })
  }
  let li = 0
  let ei = 0
  /** The position in `current` reached so far. */
  let position = 0
  /** Ends (in `base`) of the local and external deletions under way. */
  let localEnd = 0
  let externalEnd = 0
  for (let index = 0; ; ) {
    const localHere = li < local.length && local[li].from === index ? local[li] : null
    const externalHere = ei < external.length && external[ei].from === index ? external[ei] : null
    if (localHere) {
      position += localHere.insert.length
      localEnd = localHere.to
      li += 1
    }
    if (externalHere) {
      const same = localHere !== null && localHere.to === externalHere.to && localHere.insert === externalHere.insert
      if (!same) {
        if (externalHere.insert) push(position, position, externalHere.insert)
        externalEnd = externalHere.to
      }
      ei += 1
    }
    if (index >= base.length) break
    let next = base.length
    if (li < local.length) next = Math.min(next, local[li].from)
    if (ei < external.length) next = Math.min(next, external[ei].from)
    if (localEnd > index) next = Math.min(next, localEnd)
    if (externalEnd > index) next = Math.min(next, externalEnd)
    if (localEnd <= index) {
      const length = next - index
      if (externalEnd > index) push(position, position + length, '')
      position += length
    }
    index = next
  }
  if (position !== current.length) throw new Error('mergeEdits: the walk does not cover the current text')
  return out
}

/**
 * Merges the file change `base → incoming` into the `Document` object `id` of the transaction's
 * replica, whose body text is `current`: `base` is the text last exported to or read from the
 * file, `incoming` the file now. Answers `unchanged` when the replica needs no change (the file
 * did not change, or already holds the replica's text).
 */
export function mergeExternalText(tx: Tx, id: ObjectId, base: string, incoming: string, current: string): 'unchanged' | 'merged' {
  if (incoming === base) return 'unchanged'
  if (tx.textLength(id, DOCUMENT_BODY) !== current.length) throw new Error('mergeExternalText: `current` is not the replica text')
  const edits = mergeEdits(base, incoming, current)
  if (edits.length === 0) return 'unchanged'
  applyTextEdits(tx, id, DOCUMENT_BODY, edits)
  return 'merged'
}
