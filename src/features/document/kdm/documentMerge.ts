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
/** The line Myers gives up on detail (not on correctness) past about this many token comparisons. */
const DIFF_WORK = 20_000_000
/** And past this many edits, which bounds its memory (about the square of it). */
const DIFF_MAX_EDITS = 2_000
/** Character detail is kept for changes of up to this many code points, or an eighth of the changed range if more. */
const REFINE_MIN_EDITS = 64
/**
 * Character refinement stops, leaving line-level edits, after about this many diff steps plus
 * `REFINE_WORK_PER_UNIT` per UTF-16 unit of the changed middles of both texts (scattered edits
 * of a few percent of a text take about a tenth of a step per unit; rewriting most of it, ten).
 */
const REFINE_WORK = 2_000_000
const REFINE_WORK_PER_UNIT = 2
/** A changed line longer than this (in UTF-16 units, on either side) is replaced as a whole, without character detail. */
const REFINE_MAX_LENGTH = 64 * 1024
/**
 * A range of lines without anchors no longer than this (in UTF-16 units, on either side) is left to
 * the character diff whole: the line diff may express its changes in several equally short ways,
 * not all of which keep a changed line within one hunk.
 */
const CHARACTER_GAP_LENGTH = 4 * 1024
/** The line diff stops looking for anchors after scanning this many times the lines of both texts. */
const ANCHOR_WORK_FACTOR = 32

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

/** Counts the steps of the diffs it is given to, so that their total can be bounded. */
type Meter = { work: number }

/**
 * The shortest edit script from `a` to `b` (Myers), as hunks; `null` when it needs more than
 * `maxEdits` insertions and deletions. Adds its steps to `meter`.
 */
function myers(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits: number, meter: Meter = { work: 0 }): Hunk[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  /** `trace[d]`: the furthest x per diagonal before step d, for diagonals -d-1..d+1. */
  const trace: Int32Array[] = []
  const limit = Math.min(max, maxEdits)
  let work = 0
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    work += 2 * d + 3
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      const snakeFrom = x
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      work += x - snakeFrom
      v[offset + k] = x
      if (x >= n && y >= m) {
        meter.work += work
        return backtrack(trace, d, n, m)
      }
    }
  }
  meter.work += work
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

/** Indexes of a longest strictly increasing subsequence of `values`. */
function longestIncreasing(values: readonly number[]): number[] {
  /** `tails[length - 1]`: the index of the smallest value ending an increasing run of that length. */
  const tails: number[] = []
  const previous = new Int32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (values[tails[middle]] < value) low = middle + 1
      else high = middle
    }
    previous[index] = low > 0 ? tails[low - 1] : -1
    tails[low] = index
  }
  const out = new Array<number>(tails.length)
  for (let at = tails.length - 1, index = tails[at]; at >= 0; at -= 1, index = previous[index]) out[at] = index
  return out
}

/**
 * Hunks of the line ids `a` to `b` (ids below `idCount`), at a cost that grows with the number of
 * changes rather than giving up on large texts: lines that occur once in both (within the range
 * being diffed) and keep their order anchor the diff (patience diff); the ranges between anchors
 * are diffed the same way. A range without such lines is one hunk when `gapLength` (its length in
 * text) is at most `CHARACTER_GAP_LENGTH`, and diffed by a bounded Myers otherwise.
 */
function diffLines(a: Int32Array, b: Int32Array, idCount: number, gapLength: (aFrom: number, aTo: number, bFrom: number, bTo: number) => number): Hunk[] {
  const out: Hunk[] = []
  const emit = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    const last = out[out.length - 1]
    if (last && last.aTo === aFrom && last.bTo === bFrom) {
      last.aTo = aTo
      last.bTo = bTo
    } else out.push({ aFrom, aTo, bFrom, bTo })
  }
  const countA = new Int32Array(idCount)
  const countB = new Int32Array(idCount)
  const indexInA = new Int32Array(idCount)
  let work = 0
  const workLimit = ANCHOR_WORK_FACTOR * (a.length + b.length)
  /** Ranges still to diff, as `aFrom, aTo, bFrom, bTo` quadruples, the next one last. */
  const pending: number[] = [0, a.length, 0, b.length]
  while (pending.length > 0) {
    let bTo = pending.pop()!
    let bFrom = pending.pop()!
    let aTo = pending.pop()!
    let aFrom = pending.pop()!
    while (aFrom < aTo && bFrom < bTo && a[aFrom] === b[bFrom]) {
      aFrom += 1
      bFrom += 1
    }
    while (aFrom < aTo && bFrom < bTo && a[aTo - 1] === b[bTo - 1]) {
      aTo -= 1
      bTo -= 1
    }
    if (aFrom === aTo || bFrom === bTo) {
      if (aFrom < aTo || bFrom < bTo) emit(aFrom, aTo, bFrom, bTo)
      continue
    }
    // Lines unique to the range on both sides, in the order of `b`.
    const anchorA: number[] = []
    const anchorB: number[] = []
    work += aTo - aFrom + (bTo - bFrom)
    if (work <= workLimit) {
      for (let i = aFrom; i < aTo; i += 1) {
        countA[a[i]] += 1
        indexInA[a[i]] = i
      }
      for (let j = bFrom; j < bTo; j += 1) countB[b[j]] += 1
      for (let j = bFrom; j < bTo; j += 1) {
        const id = b[j]
        if (countA[id] === 1 && countB[id] === 1) {
          anchorA.push(indexInA[id])
          anchorB.push(j)
        }
      }
      for (let i = aFrom; i < aTo; i += 1) countA[a[i]] = 0
      for (let j = bFrom; j < bTo; j += 1) countB[b[j]] = 0
    }
    if (anchorA.length === 0) {
      if (gapLength(aFrom, aTo, bFrom, bTo) <= CHARACTER_GAP_LENGTH) {
        emit(aFrom, aTo, bFrom, bTo)
        continue
      }
      for (const hunk of diffTokens(a.subarray(aFrom, aTo), b.subarray(bFrom, bTo))) {
        emit(aFrom + hunk.aFrom, aFrom + hunk.aTo, bFrom + hunk.bFrom, bFrom + hunk.bTo)
      }
      continue
    }
    // The anchors that keep their order split the range; the gaps between them are diffed next, in order.
    const kept = longestIncreasing(anchorA)
    pending.push(anchorA[kept[kept.length - 1]] + 1, aTo, anchorB[kept[kept.length - 1]] + 1, bTo)
    for (let k = kept.length - 1; k > 0; k -= 1) {
      pending.push(anchorA[kept[k - 1]] + 1, anchorA[kept[k]], anchorB[kept[k - 1]] + 1, anchorB[kept[k]])
    }
    pending.push(aFrom, anchorA[kept[0]], bFrom, anchorB[kept[0]])
  }
  return out
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

/**
 * Character-level edits from `x` to `y`, relative to `x`, offset by `at`; `null` when they would
 * change more than about an eighth of the characters (then detail is worth less than its cost).
 */
function refine(x: string, y: string, at: number, meter: Meter): TextEdit[] | null {
  const prefix = commonPrefixLength(x, y)
  const suffix = commonSuffixLength(x, y, Math.min(x.length, y.length) - prefix)
  const xs = x.slice(prefix, x.length - suffix)
  const ys = y.slice(prefix, y.length - suffix)
  const start = at + prefix
  if (!xs || !ys) return [{ from: start, to: start + xs.length, insert: ys }]
  const a = codePoints(xs)
  const b = codePoints(ys)
  const size = a.points.length + b.points.length
  const hunks = myers(a.points, b.points, Math.min(DIFF_MAX_EDITS, Math.max(REFINE_MIN_EDITS, Math.floor(size / 8))), meter)
  if (!hunks) return null
  return joinNoise(hunks).map((hunk) => ({
    from: start + a.offsets[hunk.aFrom],
    to: start + a.offsets[hunk.aTo],
    insert: ys.slice(b.offsets[hunk.bFrom], b.offsets[hunk.bTo]),
  }))
}

/** Whether all that `edits` (relative to `x`, offset by `at`) keep of `x` is white space. */
function keepsOnlyWhiteSpace(x: string, at: number, edits: readonly TextEdit[]): boolean {
  let kept = ''
  let from = at
  for (const edit of edits) {
    kept += x.slice(from - at, edit.from - at)
    from = edit.to
  }
  kept += x.slice(from - at)
  return /^\s*$/.test(kept)
}

/** Line ids of a text (from `ids`, shared by the texts diffed against each other) and the offset of each line (plus the end). */
type Lines = { tokens: Int32Array; starts: Int32Array }

/** The lines of `text` in `[from, to)` (each with its `\n`, the last possibly without), with offsets in `text`. */
function lineTokens(text: string, ids: Map<string, number>, from = 0, to = text.length): Lines {
  const tokens: number[] = []
  const starts: number[] = []
  for (let start = from; start < to; ) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 || newline >= to ? to : newline + 1
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
  starts.push(to)
  return { tokens: Int32Array.from(tokens), starts: Int32Array.from(starts) }
}

/** The index of the line of `lines` that starts at `offset`. */
function lineAt(lines: Lines, offset: number): number {
  const { starts } = lines
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (starts[middle] < offset) low = middle + 1
    else high = middle
  }
  if (starts[low] !== offset) throw new Error('diffText: a line boundary is not a line start')
  return low
}

/** The lines of a text being diffed against several others, cut once (on first use). */
type LineCache = { ids: Map<string, number>; lines?: Lines }

/**
 * The edits from `a` to `b`: a line diff, refined to characters inside changed lines. Edits are
 * sorted, separated, relative to `a`, and never split a surrogate pair. The line diff's cost grows
 * with the number of changes, not the size of the texts. Rather than a slow diff, a changed line
 * longer than `REFINE_MAX_LENGTH` is replaced as a whole, and heavily rewritten texts get
 * line-level edits once character refinement has used its budget.
 */
export function diffText(a: string, b: string): TextEdit[] {
  return diffTextWith(a, b, { ids: new Map() })
}

/** `diffText`, with the lines of `a` from (and cut into) `cache`. */
function diffTextWith(a: string, b: string, cache: LineCache): TextEdit[] {
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
  const aEnd = a.length - suffix
  const bEnd = b.length - suffix
  const out: TextEdit[] = []
  if (start === aEnd || start === bEnd) {
    out.push({ from: start, to: aEnd, insert: b.slice(start, bEnd) })
    return out
  }
  cache.lines ??= lineTokens(a, cache.ids)
  const al = cache.lines
  const firstLine = lineAt(al, start)
  const aTokens = al.tokens.subarray(firstLine, lineAt(al, aEnd))
  const bl = lineTokens(b, cache.ids, start, bEnd)
  const gapLength = (aFrom: number, aTo: number, bFrom: number, bTo: number) =>
    Math.max(al.starts[firstLine + aTo] - al.starts[firstLine + aFrom], bl.starts[bTo] - bl.starts[bFrom])
  /** Adds an edit, joined to the previous one when they touch, so that edits stay separated. */
  const push = (edit: TextEdit) => {
    const last = out[out.length - 1]
    if (last && last.to === edit.from) {
      last.to = edit.to
      last.insert += edit.insert
    } else out.push({ ...edit })
  }
  const meter: Meter = { work: 0 }
  const refineBudget = REFINE_WORK + REFINE_WORK_PER_UNIT * (aEnd - start + (bEnd - start))
  /**
   * Refines a hunk of lines to characters. A hunk of several lines whose character edits keep only
   * white space (such as the line endings of unrelated lines) is replaced as a whole, so that text
   * inserted between them elsewhere stays between whole lines. A hunk of several lines longer than
   * `CHARACTER_GAP_LENGTH`, or too changed for character detail, is diffed by lines first when
   * `byLines`; what that leaves changed is refined line by line, pairing lines in order. Other
   * hunks too large or too changed for character detail are replaced as a whole.
   */
  const refineHunk = (hunk: Hunk, byLines: boolean) => {
    const aFrom = al.starts[firstLine + hunk.aFrom]
    const aTo = al.starts[firstLine + hunk.aTo]
    const x = a.slice(aFrom, aTo)
    const y = b.slice(bl.starts[hunk.bFrom], bl.starts[hunk.bTo])
    const whole = { from: aFrom, to: aTo, insert: y }
    const severalLines = hunk.aTo - hunk.aFrom > 1 || hunk.bTo - hunk.bFrom > 1
    const limit = severalLines ? CHARACTER_GAP_LENGTH : REFINE_MAX_LENGTH
    const edits = x.length <= limit && y.length <= limit && meter.work <= refineBudget ? refine(x, y, aFrom, meter) : null
    if (edits) {
      if (severalLines && keepsOnlyWhiteSpace(x, aFrom, edits)) push(whole)
      else for (const edit of edits) push(edit)
      return
    }
    if (!severalLines) {
      push(whole)
      return
    }
    const parts = byLines ? diffTokens(aTokens.subarray(hunk.aFrom, hunk.aTo), bl.tokens.subarray(hunk.bFrom, hunk.bTo)) : []
    if (parts.length > 1) {
      for (const part of parts) refineHunk({ aFrom: hunk.aFrom + part.aFrom, aTo: hunk.aFrom + part.aTo, bFrom: hunk.bFrom + part.bFrom, bTo: hunk.bFrom + part.bTo }, false)
      return
    }
    // No line in common (or too many changes to tell): pair the lines in order; the lines left over on one side are inserted or deleted.
    const pairs = Math.min(hunk.aTo - hunk.aFrom, hunk.bTo - hunk.bFrom)
    for (let k = 0; k < pairs; k += 1) refineHunk({ aFrom: hunk.aFrom + k, aTo: hunk.aFrom + k + 1, bFrom: hunk.bFrom + k, bTo: hunk.bFrom + k + 1 }, false)
    const rest = { from: al.starts[firstLine + hunk.aFrom + pairs], to: aTo, insert: b.slice(bl.starts[hunk.bFrom + pairs], bl.starts[hunk.bTo]) }
    if (rest.from < rest.to || rest.insert) push(rest)
  }
  for (const hunk of diffLines(aTokens, bl.tokens, cache.ids.size, gapLength)) refineHunk(hunk, true)
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
  const baseLines: LineCache = { ids: new Map() }
  const external = diffTextWith(base, incoming, baseLines)
  const local = base === current ? [] : diffTextWith(base, current, baseLines)
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
