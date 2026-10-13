import { describe, expect, it } from 'vitest'
import { Rng, type Origin } from '@/lib/kdm'
import { DOCUMENT_BODY } from './documentSchema'
import { createDocumentReplica, documentBody } from './documentText'
import { applyEditsToString, diffText, mergeEdits, mergeExternalText, type TextEdit } from './documentMerge'

/** CJK text (U+5B63 U+5EA6), as a named constant: the repository keeps non-English text out of source files. */
const QUARTER = String.fromCodePoint(0x5b63, 0x5ea6)
const SEASON = String.fromCodePoint(0x5b63)
const DEGREE = String.fromCodePoint(0x5ea6)

const fromFile: Origin = { kind: 'import', principal: 'file:test' }

/** Merges through a real replica holding `current`; answers the outcome and the replica's text. */
function mergeOnReplica(base: string, incoming: string, current: string) {
  const { replica, rootId } = createDocumentReplica(current, 1n)
  const before = replica.version()
  const outcome = replica.transact(fromFile, (tx) => mergeExternalText(tx, rootId, base, incoming, current))
  return { outcome, text: documentBody(replica), versionChanged: !replica.version().equals(before), replica }
}

const merged = (base: string, incoming: string, current: string) => applyEditsToString(current, mergeEdits(base, incoming, current))

const hasLoneSurrogate = (text: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

/** Edits are sorted, separated, and inside the text. */
function expectWellFormedEdits(edits: TextEdit[], length: number) {
  let last = -1
  for (const edit of edits) {
    expect(edit.from).toBeGreaterThan(last)
    expect(edit.to).toBeGreaterThanOrEqual(edit.from)
    expect(edit.from !== edit.to || edit.insert !== '').toBe(true)
    last = edit.to
  }
  expect(last).toBeLessThanOrEqual(length)
}

describe('diffText', () => {
  it('finds nothing between equal texts', () => {
    expect(diffText('', '')).toEqual([])
    expect(diffText('a\nb', 'a\nb')).toEqual([])
  })

  it('handles empty sides', () => {
    expect(diffText('', 'abc')).toEqual([{ from: 0, to: 0, insert: 'abc' }])
    expect(diffText('abc', '')).toEqual([{ from: 0, to: 3, insert: '' }])
  })

  it('refines a changed line to the changed characters', () => {
    const base = 'one\nthe quick brown fox\nthree\n'
    expect(diffText(base, 'one\nthe quick red fox\nthree\n')).toEqual([{ from: 14, to: 19, insert: 'red' }])
  })

  it('keeps separate changes in distant lines separate', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`)
    const changed = [...lines]
    changed[3] = 'line three'
    changed[40] = 'line 40!'
    const edits = diffText(lines.join('\n'), changed.join('\n'))
    expect(edits).toHaveLength(2)
    expect(applyEditsToString(lines.join('\n'), edits)).toBe(changed.join('\n'))
  })

  it('finds inserted and deleted lines', () => {
    expect(diffText('a\nb\nc\n', 'a\nx\nb\nc\n')).toEqual([{ from: 2, to: 2, insert: 'x\n' }])
    expect(diffText('a\nb\nc\n', 'a\nc\n')).toEqual([{ from: 2, to: 4, insert: '' }])
  })

  it('never splits a surrogate pair', () => {
    expect(diffText('a😀b', 'a😁b')).toEqual([{ from: 1, to: 3, insert: '😁' }])
    expect(diffText('😀', '😀😀')).toEqual([{ from: 2, to: 2, insert: '😀' }])
    expect(diffText(`${QUARTER}😀\n`, `${QUARTER}👍\n`)).toEqual([{ from: 2, to: 4, insert: '👍' }])
  })

  it('merges character noise into one replacement', () => {
    expect(diffText('the brown fox', 'the red fox')).toEqual([{ from: 4, to: 9, insert: 'red' }])
  })

  it('reproduces the target for random texts (property)', () => {
    const rng = new Rng(11)
    const alphabet = ['a', 'b', '\n', ' ', SEASON, '😀', '👍', '\n\n']
    const randomText = () => Array.from({ length: rng.below(40) }, () => alphabet[rng.below(alphabet.length)]).join('')
    for (let run = 0; run < 3000; run += 1) {
      const a = randomText()
      const b = rng.below(4) === 0 ? randomText() : mutate(rng, a, alphabet)
      const edits = diffText(a, b)
      expectWellFormedEdits(edits, a.length)
      for (const edit of edits) {
        expect(hasLoneSurrogate(a.slice(edit.from, edit.to))).toBe(false)
        expect(hasLoneSurrogate(edit.insert)).toBe(false)
      }
      expect(applyEditsToString(a, edits)).toBe(b)
    }
  })

  it('gives up on character detail, not correctness, for large unrelated texts', () => {
    const rng = new Rng(12)
    const big = (letters: string) => Array.from({ length: 20_000 }, () => letters[rng.below(letters.length)]).join('')
    const a = big('ab\n')
    const b = big('ab\n')
    expect(applyEditsToString(a, diffText(a, b))).toBe(b)
  })
})

/** `text` with a few random replacements at code point boundaries. */
function mutate(rng: Rng, text: string, alphabet: string[]): string {
  const points = Array.from(text)
  for (let count = rng.below(4); count > 0; count -= 1) {
    const at = rng.below(points.length + 1)
    const removed = rng.below(4)
    const inserted = Array.from({ length: rng.below(3) }, () => alphabet[rng.below(alphabet.length)])
    points.splice(at, removed, ...inserted)
  }
  return points.join('')
}

describe('mergeExternalText: simple outcomes', () => {
  it('leaves the replica alone when the file did not change', () => {
    const result = mergeOnReplica('a\nb\n', 'a\nb\n', 'a\nB\nlocal\n')
    expect(result.outcome).toBe('unchanged')
    expect(result.text).toBe('a\nB\nlocal\n')
    expect(result.versionChanged).toBe(false)
  })

  it('leaves the replica alone when the file already has the replica text', () => {
    const result = mergeOnReplica('a\n', 'a\nb\n', 'a\nb\n')
    expect(result.outcome).toBe('unchanged')
    expect(result.versionChanged).toBe(false)
  })

  it('takes the file as it is when there are no local edits', () => {
    const result = mergeOnReplica('a\nb\n', 'a\nchanged\nb\nc\n', 'a\nb\n')
    expect(result).toMatchObject({ outcome: 'merged', text: 'a\nchanged\nb\nc\n', versionChanged: true })
  })

  it('keeps disjoint local and external edits', () => {
    const base = '# Plan\n\nFirst point.\nSecond point.\nThird point.\n'
    const current = '# Plan\n\nFirst point, edited here.\nSecond point.\nThird point.\n'
    const incoming = '# Plan\n\nFirst point.\nSecond point.\nThird point, edited outside.\n'
    expect(mergeOnReplica(base, incoming, current)).toMatchObject({
      outcome: 'merged',
      text: '# Plan\n\nFirst point, edited here.\nSecond point.\nThird point, edited outside.\n',
    })
  })

  it('keeps disjoint edits inside one line', () => {
    expect(merged('the quick brown fox', 'the quick brown cat', 'the slow brown fox')).toBe('the slow brown cat')
  })

  it('applies a change made on both sides once', () => {
    expect(merged('a\nb\nc\n', 'a\nB\nc\nd\n', 'a\nB\nc\n')).toBe('a\nB\nc\nd\n')
  })

  it('handles empty documents', () => {
    expect(merged('', 'from file', '')).toBe('from file')
    expect(merged('', 'file\n', 'local\n')).toBe('local\nfile\n')
    expect(merged('gone', '', '')).toBe('')
    expect(merged('text', '', 'text, edited')).toBe(', edited')
  })

  it('refuses a current text that is not the replica text', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    expect(() => replica.transact(fromFile, (tx) => mergeExternalText(tx, rootId, 'abc', 'abcd', 'ab'))).toThrow(/current/)
  })
})

describe('mergeExternalText: overlapping edits', () => {
  it('keeps both insertions at one place, local first', () => {
    expect(merged('a\n', 'a\nfile\n', 'a\nlocal\n')).toBe('a\nlocal\nfile\n')
  })

  it('inserts the external text next to a local edit of the same range', () => {
    expect(merged('the brown fox', 'the red fox', 'the grey fox')).toBe('the greyred fox')
    // Base text the local edit kept ("n" of "green") is still deleted by the file.
    expect(merged('the brown fox', 'the red fox', 'the green fox')).toBe('the greered fox')
  })

  it('deletes only base text that still exists', () => {
    // The file deletes "two three"; locally "three" was already replaced by "3".
    expect(merged('one two three four', 'one four', 'one two 3 four')).toBe('one 3four')
  })

  it('keeps local text typed inside a range the file deletes', () => {
    expect(merged('keep: abcdef :keep', 'keep:  :keep', 'keep: abcXYZdef :keep')).toBe('keep: XYZ :keep')
  })

  it('merges an entirely replaced file with local insertions', () => {
    expect(merged('old line one\nold line two\n', 'brand new\n', 'old line one\nmine\nold line two\n')).toBe('brand new\nmine\n')
  })

  it('never splits a surrogate pair when both sides edit emoji', () => {
    expect(merged('😀😀', '😀🎉', '👍😀')).toBe('👍🎉')
    expect(merged(`${SEASON}😀${DEGREE}`, `${SEASON}🎉${DEGREE}`, `${SEASON}😀😀${DEGREE}`)).toMatch(new RegExp(`^${SEASON}.*${DEGREE}$`))
    expect(hasLoneSurrogate(merged('😀😀😀', '😁😀😂', '😀👍😀'))).toBe(false)
  })
})

/** Code points used once each, so a diff of an edited text is unambiguous. */
function uniqueBase(rng: Rng): string[] {
  const points: string[] = []
  const length = rng.below(30)
  let next = 0x4e00
  for (let index = 0; index < length; index += 1) {
    const roll = rng.below(10)
    if (roll === 0 && index > 0 && points[index - 1] !== '\n') points.push('\n')
    else if (roll === 1) points.push(String.fromCodePoint(0x1f600 + index))
    else points.push(String.fromCodePoint(next++))
  }
  return points
}

const LOCAL = ['A', 'B', 'C', '👍', '\n']
const EXTERNAL = ['1', '2', '3', '🎉', '\n']

type Edit = { at: number; removed: number; inserted: string[] }

const randomInsert = (rng: Rng, alphabet: string[]) => Array.from({ length: rng.below(4) }, () => alphabet[rng.below(alphabet.length)])

function applyPointEdits(points: string[], edits: Edit[]): string {
  const out = [...points]
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) out.splice(edit.at, edit.removed, ...edit.inserted)
  return out.join('')
}

describe('mergeExternalText: properties', () => {
  it('keeps disjoint local and external edits (property)', () => {
    const rng = new Rng(21)
    for (let run = 0; run < 1500; run += 1) {
      const points = uniqueBase(rng)
      const n = points.length
      if (n < 3) continue
      // Two ranges with at least one untouched code point between them.
      const firstAt = rng.below(n - 2)
      const firstEnd = firstAt + rng.below(Math.min(3, n - 2 - firstAt) + 1)
      const secondAt = firstEnd + 1 + rng.below(n - firstEnd - 1)
      const secondEnd = secondAt + rng.below(n - secondAt + 1)
      const first: Edit = { at: firstAt, removed: firstEnd - firstAt, inserted: [] }
      const second: Edit = { at: secondAt, removed: secondEnd - secondAt, inserted: [] }
      const [local, external] = rng.below(2) === 0 ? [first, second] : [second, first]
      local.inserted = randomInsert(rng, LOCAL)
      external.inserted = randomInsert(rng, EXTERNAL)
      const base = points.join('')
      const current = applyPointEdits(points, [local])
      const incoming = applyPointEdits(points, [external])
      const expected = applyPointEdits(points, [local, external])
      const label = JSON.stringify({ base, current, incoming })
      expect(merged(base, incoming, current), label).toBe(expected)
      if (run % 25 === 0) expect(mergeOnReplica(base, incoming, current).text, label).toBe(expected)
    }
  })

  it('answers unchanged for an unchanged file and the file for no local edits (property)', () => {
    const rng = new Rng(22)
    const alphabet = ['a', 'b', '\n', SEASON, '😀', '👍']
    for (let run = 0; run < 1000; run += 1) {
      const base = Array.from({ length: rng.below(30) }, () => alphabet[rng.below(alphabet.length)]).join('')
      const edited = mutate(rng, base, alphabet)
      expect(mergeEdits(base, base, edited)).toEqual([])
      expect(merged(base, edited, base)).toBe(edited)
      if (run % 50 === 0) {
        expect(mergeOnReplica(base, base, edited)).toMatchObject({ outcome: 'unchanged', text: edited })
        expect(mergeOnReplica(base, edited, base).text).toBe(edited)
      }
    }
  })

  it('never throws on random edit pairs and keeps every insertion (property)', () => {
    const rng = new Rng(23)
    const baseAlphabet = ['a', 'b', ' ', '\n', SEASON, '😀']
    const only = (text: string, alphabet: string[]) => Array.from(text).filter((point) => alphabet.includes(point) && point !== '\n').join('')
    for (let run = 0; run < 1500; run += 1) {
      const points = Array.from({ length: rng.below(25) }, () => baseAlphabet[rng.below(baseAlphabet.length)])
      const randomEdits = (alphabet: string[]): Edit[] => {
        const edits: Edit[] = []
        let at = 0
        for (let count = rng.below(4); count > 0 && at <= points.length; count -= 1) {
          at += rng.below(points.length - at + 1)
          const removed = rng.below(Math.min(4, points.length - at) + 1)
          edits.push({ at, removed, inserted: randomInsert(rng, alphabet) })
          at += removed + 1
        }
        return edits
      }
      const base = points.join('')
      const current = applyPointEdits(points, randomEdits(LOCAL))
      const incoming = applyPointEdits(points, randomEdits(EXTERNAL))
      const label = JSON.stringify({ base, current, incoming })
      const edits = mergeEdits(base, incoming, current)
      expectWellFormedEdits(edits, current.length)
      const result = applyEditsToString(current, edits)
      expect(hasLoneSurrogate(result), label).toBe(false)
      expect(only(result, LOCAL), label).toBe(only(current, LOCAL))
      expect(only(result, EXTERNAL), label).toBe(only(incoming, EXTERNAL))
      if (run % 25 === 0) expect(mergeOnReplica(base, incoming, current).text, label).toBe(result)
    }
  })
})

describe('mergeExternalText: a 1 MB document', () => {
  it('merges scattered edits on both sides (timing printed)', () => {
    const lines: string[] = []
    for (let size = 0, index = 0; size < 1_000_000; index += 1) {
      const line = `Line ${index}: ${QUARTER} report 😀 with some ordinary words to fill the paragraph.`
      lines.push(line)
      size += line.length + 1
    }
    const base = `${lines.join('\n')}\n`
    const local = [...lines]
    const external = [...lines]
    for (let index = 100; index < lines.length; index += 997) local[index] = `${lines[index]} (local)`
    for (let index = 600; index < lines.length; index += 1009) external[index] = lines[index].replace('report', 'summary')
    const current = `${local.join('\n')}\n`
    const incoming = `${external.join('\n')}\n`
    const { replica, rootId } = createDocumentReplica(current, 1n)
    const diffStarted = performance.now()
    mergeEdits(base, incoming, current)
    const diffElapsed = performance.now() - diffStarted
    const started = performance.now()
    const outcome = replica.transact(fromFile, (tx) => mergeExternalText(tx, rootId, base, incoming, current))
    const elapsed = performance.now() - started
    console.info(
      `mergeExternalText on ${(base.length / 1e6).toFixed(2)} MB (${lines.length} lines): ${elapsed.toFixed(1)} ms with a fresh replica; the diff and merge alone: ${diffElapsed.toFixed(1)} ms`,
    )
    expect(outcome).toBe('merged')
    const expected = lines
      .map((line, index) => {
        const withExternal = external[index] !== line ? line.replace('report', 'summary') : line
        return local[index] !== line ? `${withExternal} (local)` : withExternal
      })
      .join('\n') + '\n'
    expect(replica.text(rootId, DOCUMENT_BODY)).toBe(expected)
  }, 60_000)
})
