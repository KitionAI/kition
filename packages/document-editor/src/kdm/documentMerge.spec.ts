import { loadavg } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Rng, Tx, type Origin } from '@kition/kdm'
import { DOCUMENT_BODY } from './documentSchema'
import { createDocumentReplica, documentBody } from './documentText'
import { applyEditsToString, coalesceEdits, commonPrefixLength, diffText, mergeEdits, mergeExternalText, type TextEdit } from './documentMerge'

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

/** Markdown of about `size` UTF-16 units: headings, prose with CJK and emoji, lists, tables, code blocks, blank lines. */
function generatedMarkdown(size: number): string {
  const blocks: string[] = []
  for (let index = 0, length = 0; length < size; index += 1) {
    const kind = index % 5
    let block: string
    if (kind === 0) block = `${'#'.repeat((index % 3) + 1)} Section ${index} 😀`
    else if (kind === 1) block = `Paragraph ${index} covers the ${QUARTER} plan 🎉 in ordinary sentences, long enough to look like real prose, and a few more words.`
    else if (kind === 2) block = Array.from({ length: 4 }, (_, item) => `- Item ${index}.${item}: a task 👍`).join('\n')
    else if (kind === 3) block = ['| Name | Status |', '| --- | --- |', ...Array.from({ length: 3 }, (_, row) => `| Row ${index}.${row} | ${SEASON} |`)].join('\n')
    else block = ['```ts', `function step${index}() {`, '  return 1', '}', '```'].join('\n')
    blocks.push(block)
    length += block.length + 2
  }
  return `${blocks.join('\n\n')}\n`
}

/** Text the generated Markdown never contains, so where an edit's insertion lands is unambiguous. */
const LOCAL_INSERTS = ['@', '~', '🐱']
const EXTERNAL_INSERTS = ['%', '=', '🦊']

/**
 * Scattered changes of `text` at random places at least `gap` units apart (one per `1 / density`
 * units on average), each replacing up to two code points with up to two from its side's alphabet;
 * about `localShare` of them are local, the rest external.
 */
function scatteredChanges(rng: Rng, text: string, density: number, localShare: number, gap = 24) {
  const local: TextEdit[] = []
  const external: TextEdit[] = []
  const spacing = Math.max(gap + 1, Math.round(1 / density))
  for (let at = rng.below(spacing); at < text.length; at += gap + rng.below(2 * (spacing - gap) + 1)) {
    let from = at
    if (from > 0 && /[\udc00-\udfff]/.test(text[from])) from += 1
    let to = from
    for (let count = rng.below(3); count > 0 && to < text.length; count -= 1) to += text.codePointAt(to)! > 0xffff ? 2 : 1
    const isLocal = rng.below(1000) < localShare * 1000
    const alphabet = isLocal ? LOCAL_INSERTS : EXTERNAL_INSERTS
    let insert = Array.from({ length: rng.below(3) }, () => alphabet[rng.below(alphabet.length)]).join('')
    if (from === to && !insert) insert = alphabet[0]
    ;(isLocal ? local : external).push({ from, to, insert })
  }
  return { local, external, both: [...local, ...external].sort((a, b) => a.from - b.from) }
}

/** `actual` against `expected`: equal, or where they first differ, with some context. */
function firstDifference(actual: string, expected: string): string {
  if (actual === expected) return 'equal'
  const at = commonPrefixLength(actual, expected)
  return JSON.stringify({ at, actual: actual.slice(at - 40, at + 40), expected: expected.slice(at - 40, at + 40) })
}

const largestEdit = (edits: readonly TextEdit[]) => edits.reduce((most, edit) => Math.max(most, edit.to - edit.from, edit.insert.length), 0)
const load = () => loadavg().map((value) => value.toFixed(2)).join(', ')

describe('mergeExternalText: large documents', () => {
  it('keeps every scattered local and external edit of a 2 MB document exactly, in small edits (property)', () => {
    const base = generatedMarkdown(2_000_000)
    for (const seed of [31, 32, 33]) {
      const rng = new Rng(seed)
      // 1% external and 0.5% local edits: one change every ~67 units, a third of them local.
      const changes = scatteredChanges(rng, base, 1 / 67, 1 / 3)
      const current = applyEditsToString(base, changes.local)
      const incoming = applyEditsToString(base, changes.external)
      const expected = applyEditsToString(base, changes.both)
      const started = performance.now()
      const edits = mergeEdits(base, incoming, current)
      const elapsed = performance.now() - started
      console.info(
        `mergeEdits on ${(base.length / 1e6).toFixed(2)} MB, ${changes.external.length} external and ${changes.local.length} local changes: ${edits.length} edits in ${elapsed.toFixed(1)} ms (load average ${load()})`,
      )
      expectWellFormedEdits(edits, current.length)
      expect(firstDifference(applyEditsToString(current, edits), expected), `seed ${seed}`).toBe('equal')
      expect(largestEdit(edits)).toBeLessThanOrEqual(64 * 1024)
      for (const [side, text] of [['external', incoming], ['local', current]]) {
        const sideEdits = diffText(base, text)
        expect(firstDifference(applyEditsToString(base, sideEdits), text), `seed ${seed}, ${side}`).toBe('equal')
        expect(largestEdit(sideEdits)).toBeLessThanOrEqual(64 * 1024)
      }
    }
  }, 120_000)

  it('diffs a 5 MB document with scattered changes into many small edits (timing printed)', () => {
    const base = generatedMarkdown(5_000_000)
    const rng = new Rng(34)
    const changes = scatteredChanges(rng, base, 1 / 67, 1 / 3)
    const current = applyEditsToString(base, changes.local)
    const incoming = applyEditsToString(base, changes.external)
    let started = performance.now()
    const external = diffText(base, incoming)
    const diffElapsed = performance.now() - started
    started = performance.now()
    const edits = mergeEdits(base, incoming, current)
    const mergeElapsed = performance.now() - started
    console.info(
      `on ${(base.length / 1e6).toFixed(2)} MB: diffText ${external.length} edits (of ${changes.external.length} changes) in ${diffElapsed.toFixed(1)} ms; mergeEdits ${edits.length} edits in ${mergeElapsed.toFixed(1)} ms (load average ${load()})`,
    )
    expect(external.length).toBeGreaterThan(changes.external.length / 2)
    expect(largestEdit(external)).toBeLessThan(1_000)
    expect(edits.length).toBeGreaterThan(changes.external.length / 2)
    expect(largestEdit(edits)).toBeLessThan(1_000)
    expect(firstDifference(applyEditsToString(current, edits), applyEditsToString(base, changes.both))).toBe('equal')
  }, 120_000)

  it('diffs a heavily rewritten 2 MB document quickly, into line-sized edits (timing printed)', () => {
    const base = generatedMarkdown(2_000_000)
    // Every paragraph and list item rewritten (its words reversed); headings, tables, and code kept.
    const rewrite = (line: string) => (line.startsWith('Paragraph') || line.startsWith('- ') ? line.split(' ').reverse().join(' ') : line)
    const incoming = base.split('\n').map(rewrite).join('\n')
    const started = performance.now()
    const edits = diffText(base, incoming)
    console.info(`diffText of a rewritten ${(base.length / 1e6).toFixed(2)} MB: ${edits.length} edits in ${(performance.now() - started).toFixed(1)} ms (load average ${load()})`)
    expectWellFormedEdits(edits, base.length)
    expect(firstDifference(applyEditsToString(base, edits), incoming)).toBe('equal')
    expect(largestEdit(edits)).toBeLessThan(1_000)
  }, 120_000)

  it('refines a block whose every line changed line by line, however large (property)', () => {
    for (const count of [100, 2_000]) {
      // No line in common, ~14% of the characters changed: a 5 KB and a 100 KB block.
      const base = Array.from({ length: count }, (_, index) => `Line ${index}, some ordinary text for the document.\n`).join('')
      const incoming = base.replaceAll('ordinary', 'plain')
      const edits = diffText(base, incoming)
      expect(edits).toHaveLength(count)
      expect(largestEdit(edits)).toBe('ordinary'.length)
      const current = base.replace('Line 7, some', 'Line 7, one')
      expect(merged(base, incoming, current)).toBe(incoming.replace('Line 7, some', 'Line 7, one'))
    }
  })

  it('replaces a huge changed line as a whole, without character detail', () => {
    const rng = new Rng(35)
    const block = (letters: string) => Array.from({ length: 100_000 }, () => letters[rng.below(letters.length)]).join('')
    const base = `start\n${block('ab')}\nend\n`
    const incoming = `start\n${block('ab')}\nend\n`
    expect(diffText(base, incoming)).toEqual([{ from: 6, to: base.length - 4, insert: incoming.slice(6, incoming.length - 4) }])
  })
})

describe('mergeExternalText: coalescing a large merge (opt-in)', () => {
  it('joins edits separated by a short unchanged run, keeping the text and every surrogate pair', () => {
    const text = 'ab😀cd😀efghij'
    // Replace "b" and "c", delete the second emoji, replace "j"; the runs between are 2, 1 and 5 code units.
    const edits: TextEdit[] = [
      { from: 1, to: 2, insert: 'B' },
      { from: 4, to: 5, insert: 'C' },
      { from: 6, to: 8, insert: '' },
      { from: 13, to: 14, insert: 'J' },
    ]
    const joined = coalesceEdits(edits, text, 2)
    expect(joined).toEqual([
      { from: 1, to: 8, insert: 'B😀Cd' },
      { from: 13, to: 14, insert: 'J' },
    ])
    expect(applyEditsToString(text, joined)).toBe(applyEditsToString(text, edits))
    expect(coalesceEdits(edits, text, 0)).toEqual(edits)
  })

  it('leaves merges at or below the threshold alone, and gives the same text above it', () => {
    const base = generatedMarkdown(200_000)
    const changes = scatteredChanges(new Rng(36), base, 1 / 67, 1 / 3)
    const current = applyEditsToString(base, changes.local)
    const incoming = applyEditsToString(base, changes.external)
    const expected = applyEditsToString(base, changes.both)
    const edits = mergeEdits(base, incoming, current)
    const operations = edits.reduce((count, edit) => count + Number(edit.to > edit.from) + Number(edit.insert !== ''), 0)
    const inserts = vi.spyOn(Tx.prototype, 'textInsert')
    const deletes = vi.spyOn(Tx.prototype, 'textDelete')
    for (const [above, joins] of [
      [edits.length, false],
      [edits.length - 1, true],
    ] as const) {
      const { replica, rootId } = createDocumentReplica(current, 1n)
      inserts.mockClear()
      deletes.mockClear()
      replica.transact(fromFile, (tx) => mergeExternalText(tx, rootId, base, incoming, current, { coalesce: { above, gap: 64 } }))
      expect(firstDifference(documentBody(replica), expected)).toBe('equal')
      const performed = inserts.mock.calls.length + deletes.mock.calls.length
      if (joins) expect(performed).toBeLessThan(operations * 0.8)
      else expect(performed).toBe(operations)
    }
    inserts.mockRestore()
    deletes.mockRestore()
  })
})
