// Copied from kition-sdk packages/convergence/src/scenarios.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The scenarios of architecture section 16, scripted and fuzzed: a line-by-line port of the Rust
 * `kition_convergence::scenarios`, with the same seeds, the same order of random draws, and the
 * same pass and skip rules, so a TypeScript kit and a Rust kit are held to one suite. The table of
 * scenarios is checked against the Rust source by this package's tests, and both runners reach the
 * same states on the same toy kit (`test/cross-check.test.ts`).
 */
import type { Blobs, KitAdapter, Options, Script } from './adapter'
import { blobsOf, bytesEqual, context, message, Net, Skip } from './net'
import { Report, type Outcome } from './report'
import { compareStrings, created, deleted, firstDifference, listSets, objects, register, registerChanges, Registers, sameValue, SchemaInfo, treeNodes } from './state'
import { canonicalText } from '../kdm'

/** Every scenario: `[id, title]`, in the order `run` runs them. The same table as the Rust suite's `SCENARIOS`. */
export const SCENARIOS: ReadonlyArray<readonly [string, string]> = [
  ['fields', 'concurrent edits to different fields of one object keep both'],
  ['same-field', 'concurrent edits to one field resolve to one of the written values everywhere'],
  ['create', 'concurrent creation from one snapshot makes distinct ids, all kept'],
  ['text-position', 'concurrent text at one position (IME composition, CJK, emoji) keeps both without loss'],
  ['text-delete-insert', 'text typed inside a range deleted concurrently survives'],
  ['text-split', 'a paragraph split concurrent with typing keeps the typing'],
  ['text-merge', 'a paragraph merge concurrent with typing in the merged paragraph keeps the typing'],
  ['reorder', 'reorder versus reorder keeps every item once'],
  ['reparent', 'reparent versus reparent keeps every node once, with no cycle'],
  ['delete-edit', 'delete versus edit: the delete wins and references stay valid'],
  ['duplicate-delete', 'duplicate versus delete leaves valid references'],
  ['undo', "undo by one actor keeps another actor's later changes"],
  ['undo-reconnect', "undo and redo while offline keep another actor's changes after reconnecting"],
  ['delivery', 'delivery in any order, with duplicates and retries, gives identical state'],
  ['crash', 'a crash after a local commit and before the push recovers the change'],
  ['blobs-late', 'blobs that arrive after their changes do not corrupt the document'],
  ['fuzz', 'seeded random commands, undo, redo, partial delivery, and crashes on 2 to 5 replicas converge'],
]

/**
 * Two IME results and emoji, by code point (CJK ideographs "middle" and "text", a grinning face,
 * and a thumbs-up with a skin tone modifier: two scalar values in one grapheme).
 */
const CJK_MIDDLE = String.fromCodePoint(0x4e2d)
const CJK_TEXT = String.fromCodePoint(0x6587)
const EMOJI_GRIN = String.fromCodePoint(0x1f600)
const EMOJI_THUMBS_UP = String.fromCodePoint(0x1f44d)
const SKIN_TONE = String.fromCodePoint(0x1f3fd)

/** Whether L6 needs a scenario, from what the kit has. */
type Needs = { text: boolean; lists: boolean; trees: boolean; blobs: boolean }

function needsOf<Doc>(kit: KitAdapter<Doc>): Needs {
  const schema = SchemaInfo.parse(kit.schema)
  const doc = kit.create()
  return { text: (kit.text?.(doc) ?? null) !== null, lists: schema.hasKind('list'), trees: schema.hasKind('tree'), blobs: schema.hasKind('blob') }
}

function required(id: string, needs: Needs): boolean {
  switch (id) {
    case 'text-position':
    case 'text-delete-insert':
      return needs.text
    case 'reorder':
      return needs.lists
    case 'reparent':
      return needs.trees
    case 'blobs-late':
      return needs.blobs
    case 'text-split':
    case 'text-merge':
    case 'duplicate-delete':
      return false
    default:
      return true
  }
}

/** Runs the whole suite against `kit`. */
export function run<Doc>(kit: KitAdapter<Doc>, options: Options): Report {
  const report = new Report(kit.name)
  let needs: Needs
  try {
    needs = needsOf(kit)
  } catch (error) {
    report.push('setup', 'the kit makes a document and its schema parses', true, { kind: 'failed', reason: message(error) })
    return report
  }
  for (const [id, title] of SCENARIOS) report.push(id, title, required(id, needs), one(kit, id, options))
  return report
}

/** Runs one scenario by id (from `SCENARIOS`); `null` for an unknown id. */
export function runOne<Doc>(kit: KitAdapter<Doc>, id: string, options: Options): Report | null {
  const entry = SCENARIOS.find(([known]) => known === id)
  if (!entry) return null
  const report = new Report(kit.name)
  let isRequired = true
  try {
    isRequired = required(id, needsOf(kit))
  } catch {
    // As the Rust suite: a kit that cannot say what it has needs everything.
  }
  report.push(entry[0], entry[1], isRequired, one(kit, id, options))
  return report
}

/** A scenario's body: `null` passed, a string skipped (why); throwing fails it. */
type Body = string | null

const BODIES: Record<string, <Doc>(kit: KitAdapter<Doc>, options: Options) => Body> = {
  fields: (kit) => fields(kit),
  'same-field': (kit) => sameField(kit),
  create: (kit) => create(kit),
  'text-position': (kit) => textPosition(kit),
  'text-delete-insert': (kit) => textDeleteInsert(kit),
  'text-split': (kit) => textSplit(kit),
  'text-merge': (kit) => textMerge(kit),
  reorder: (kit) => reorder(kit),
  reparent: (kit) => reparent(kit),
  'delete-edit': (kit) => deleteEdit(kit),
  'duplicate-delete': (kit) => duplicateDelete(kit),
  undo: (kit) => undo(kit),
  'undo-reconnect': (kit) => undoReconnect(kit),
  delivery: (kit) => delivery(kit),
  crash: (kit) => crash(kit),
  'blobs-late': (kit) => blobsLate(kit),
  fuzz: (kit, options) => fuzz(kit, options),
}

function one<Doc>(kit: KitAdapter<Doc>, id: string, options: Options): Outcome {
  const body = BODIES[id]
  if (!body) return { kind: 'failed', reason: `no scenario ${id}` }
  try {
    const skipped = body(kit, options)
    return skipped === null ? { kind: 'passed' } : { kind: 'skipped', reason: skipped }
  } catch (error) {
    // A kit that throws fails this scenario, not the whole suite.
    if (error instanceof Skip) return { kind: 'skipped', reason: error.message }
    return { kind: 'failed', reason: message(error) }
  }
}

function changes<Doc>(net: Net<Doc>, index: number, before: unknown): { after: unknown; changed: Registers } {
  const after = net.state(index)
  return { after, changed: registerChanges(net.schema, before, after) }
}

/** A JSON value as the Rust suite writes it (`serde_json`'s `Display`). */
const show = (value: unknown) => canonicalText(value ?? null)

/** Every register in `expected` has its value in `merged`. */
function expectRegisters(schema: SchemaInfo, merged: unknown, expected: Registers, whose: string): void {
  for (const { slot, value } of expected.list()) {
    const found = register(schema, merged, slot)
    if (!sameValue(found, value)) throw new Error(`${whose} change to ${slot[0]}.${slot[1]} was lost: expected ${show(value)}, found ${show(found)}`)
  }
}

/** A list of strings as Rust's `{:?}` writes it: `["a", "b"]`. */
const debugList = (items: Iterable<string>) => `[${[...items].map((item) => JSON.stringify(item)).join(', ')}]`
/** A string as Rust's `{:?}` writes it. */
const debug = (text: string) => JSON.stringify(text)
/** The number of code points (Rust `chars().count()`). */
const chars = (text: string) => Array.from(text).length

function fields<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 11)
  const base = net.settle()
  net.step(0, { kind: 'SetField', slot: 0, value: 101 })
  net.step(1, { kind: 'SetField', slot: 1, value: 202 })
  const a = changes(net, 0, base).changed
  const b = changes(net, 1, base).changed
  if (a.size === 0 || b.size === 0) throw new Error(`SetField changed no register (slot 0: ${a.size} changes, slot 1: ${b.size})`)
  const onlyA = a.filter((slot) => !b.has(slot))
  const onlyB = b.filter((slot) => !a.has(slot))
  if (onlyA.size === 0 || onlyB.size === 0) {
    throw new Error(`SetField slots 0 and 1 changed the same registers: [${a.list().map(({ slot }) => `(${debug(slot[0])}, ${debug(slot[1])})`).join(', ')}]`)
  }
  const objectsA = new Set(onlyA.list().map(({ slot }) => slot[0]))
  if (!onlyB.list().some(({ slot }) => objectsA.has(slot[0]))) throw new Error('SetField slots 0 and 1 changed different objects; they must be two fields of one object')
  const merged = net.settle()
  expectRegisters(net.schema, merged, onlyA, "replica 0's")
  expectRegisters(net.schema, merged, onlyB, "replica 1's")
  return null
}

function sameField<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 3, 12)
  const base = net.settle()
  const written: Registers[] = []
  for (let index = 0; index < 3; index += 1) {
    net.step(index, { kind: 'SetField', slot: 0, value: 300 + index })
    written.push(changes(net, index, base).changed)
  }
  const merged = net.settle()
  const slots = new Registers()
  for (const registers of written) for (const { slot } of registers.list()) slots.set(slot, null)
  for (const { slot } of slots.list()) {
    const found = register(net.schema, merged, slot)
    if (!written.some((registers) => registers.has(slot) && sameValue(registers.get(slot), found))) {
      throw new Error(`${slot[0]}.${slot[1]} resolved to ${show(found)}, which no replica wrote`)
    }
  }
  return null
}

function create<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 3, 13)
  const base = net.settle()
  const made: string[][] = []
  for (let index = 0; index < 3; index += 1) {
    net.step(index, { kind: 'Create' })
    const ids = created(base, net.state(index))
    if (ids.length === 0) throw new Error(`Create on replica ${index} created no object`)
    made.push(ids)
  }
  made.forEach((ids, index) => {
    for (let other = index + 1; other < made.length; other += 1) {
      const theirs = new Set(made[other])
      const both = ids.find((id) => theirs.has(id))
      if (both !== undefined) throw new Error(`replicas ${index} and ${other} both created ${both}`)
    }
  })
  const merged = objects(net.settle())
  made.forEach((ids, index) => {
    const lost = ids.find((id) => !Object.hasOwn(merged, id))
    if (lost !== undefined) throw new Error(`replica ${index}'s new object ${lost} is gone after the merge`)
  })
  return null
}

/** A text the suite types into: at least `min` code points in the first paragraph; `null` when the kit has no text. */
function textBase<Doc>(net: Net<Doc>, min: number): string | null {
  const text = net.kit.text?.(net.doc(0)) ?? null
  if (text === null) return null
  const first = chars(text.split('\n')[0] ?? '')
  if (first < min) {
    const filler = Array.from('abcdefgh').slice(0, min - first).join('')
    if (!net.script(0, { kind: 'InsertText', at: first, text: filler })) return null
    net.settle()
  }
  return net.text(0)
}

/** `text` without one occurrence of each of `parts`, or `null` when one is missing. */
function without(text: string, parts: readonly string[]): string | null {
  let rest = text
  for (const part of parts) {
    const at = rest.indexOf(part)
    if (at < 0) return null
    rest = rest.slice(0, at) + rest.slice(at + part.length)
  }
  return rest
}

function textPosition<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 14)
  const base = textBase(net, 2)
  if (base === null) return 'the kit has no text'
  const composed = CJK_MIDDLE + CJK_TEXT + EMOJI_GRIN
  const theirs = `XY${EMOJI_THUMBS_UP}${SKIN_TONE}`
  // Replica 0 composes with an IME: the romanisation appears, is replaced, then each result.
  net.step(0, { kind: 'InsertText', at: 1, text: 'zh' })
  net.step(0, { kind: 'DeleteText', at: 1, len: 2 })
  net.step(0, { kind: 'InsertText', at: 1, text: CJK_MIDDLE })
  net.step(0, { kind: 'InsertText', at: 2, text: CJK_TEXT })
  net.step(0, { kind: 'InsertText', at: 3, text: EMOJI_GRIN })
  net.step(1, { kind: 'InsertText', at: 1, text: 'XY' })
  net.step(1, { kind: 'InsertText', at: 3, text: EMOJI_THUMBS_UP + SKIN_TONE })
  net.settle()
  const text = net.text(0)
  const rest = without(text, [composed, theirs])
  if (rest === null) throw new Error(`an insertion was lost or interleaved: ${debug(text)}`)
  if (rest !== base) throw new Error(`the text around the insertions changed: ${debug(rest)}, was ${debug(base)}`)
  return null
}

function textDeleteInsert<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 15)
  const base = textBase(net, 4)
  if (base === null) return 'the kit has no text'
  net.step(0, { kind: 'DeleteText', at: 1, len: 2 })
  net.step(1, { kind: 'InsertText', at: 2, text: 'ZZ' })
  net.settle()
  const text = net.text(0)
  const expected = Array.from(base).filter((_, index) => index < 1 || index >= 3).join('')
  const rest = without(text, ['ZZ'])
  if (rest === null) throw new Error(`the typing inside the deleted range was lost: ${debug(text)}`)
  if (rest !== expected) throw new Error(`after deleting 2 characters at 1 the text is ${debug(rest)}, expected ${debug(expected)}`)
  return null
}

const newlines = (text: string) => text.split('\n').length - 1

function textSplit<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 16)
  const base = textBase(net, 4)
  if (base === null) return 'the kit has no text'
  net.step(0, { kind: 'SplitParagraph', at: 2 })
  net.step(1, { kind: 'InsertText', at: 2, text: 'QQ' })
  net.step(1, { kind: 'InsertText', at: 5, text: 'WW' })
  net.settle()
  const text = net.text(0)
  if (newlines(text) !== newlines(base) + 1) throw new Error(`the split made ${newlines(text)} paragraph breaks out of ${newlines(base)}: ${debug(text)}`)
  const rest = without(text, ['QQ', 'WW'])
  if (rest === null) throw new Error(`typing concurrent with the split was lost: ${debug(text)}`)
  if (rest.replaceAll('\n', '') !== base.replaceAll('\n', '')) throw new Error(`the split changed the text: ${debug(rest)}, was ${debug(base)}`)
  return null
}

function textMerge<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 17)
  let base = textBase(net, 2)
  if (base === null) return 'the kit has no text'
  if (!base.includes('\n')) {
    const end = chars(base)
    net.step(0, { kind: 'SplitParagraph', at: Math.min(end, 1) })
    net.settle()
    base = net.text(0)
  }
  const at = Array.from(base).indexOf('\n')
  if (at < 0) throw new Error('SplitParagraph made no paragraph break')
  net.step(0, { kind: 'MergeParagraph', at })
  // Replica 1 types at the start of the paragraph replica 0 merges away, and at its end.
  net.step(1, { kind: 'InsertText', at: at + 1, text: 'RR' })
  net.settle()
  const text = net.text(0)
  if (newlines(text) + 1 !== newlines(base)) throw new Error(`the merge left ${newlines(text)} paragraph breaks out of ${newlines(base)}: ${debug(text)}`)
  const rest = without(text, ['RR'])
  if (rest === null) throw new Error(`typing in the merged paragraph was lost: ${debug(text)}`)
  if (rest.replaceAll('\n', '') !== base.replaceAll('\n', '')) throw new Error(`the merge changed the text: ${debug(rest)}, was ${debug(base)}`)
  return null
}

function sameSets(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  if (a.size !== b.size) return false
  for (const [key, items] of a) {
    const other = b.get(key)
    if (!other || other.size !== items.size || [...items].some((item) => !other.has(item))) return false
  }
  return true
}

const sortedItems = (items: Iterable<string>) => [...items].sort(compareStrings)

function reorder<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 18)
  const base = net.settle()
  net.step(0, { kind: 'Reorder', which: 0 })
  net.step(1, { kind: 'Reorder', which: 1 })
  const moved = net.state(0)
  if (sameSets(listSets(net.schema, moved), listSets(net.schema, base)) && sameValue(moved, base)) throw new Error('Reorder changed nothing')
  const merged = net.settle()
  const after = listSets(net.schema, merged)
  for (const [list, items] of listSets(net.schema, base)) {
    const now = after.get(list)
    if (now === undefined) continue
    const lost = sortedItems([...items].filter((item) => !now.has(item)))
    const added = sortedItems([...now].filter((item) => !items.has(item)))
    if (lost.length > 0 || added.length > 0) {
      throw new Error(`${list} changed its items under concurrent reorders: lost ${debugList(lost)}, gained ${debugList(added)}`)
    }
  }
  return null
}

const debugCounts = (counts: Map<string, number>) => `{${[...counts].map(([key, count]) => `${JSON.stringify(key)}: ${count}`).join(', ')}}`

function reparent<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 19)
  const base = net.settle()
  net.step(0, { kind: 'Reparent', which: 0 })
  net.step(1, { kind: 'Reparent', which: 1 })
  const merged = net.settle()
  const before = treeNodes(net.schema, base)
  const after = treeNodes(net.schema, merged)
  if (debugCounts(before) !== debugCounts(after)) throw new Error(`concurrent reparents changed the trees' node counts: ${debugCounts(before)} to ${debugCounts(after)}`)
  return null
}

function deleteEdit<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 20)
  const base = net.settle()
  net.step(0, { kind: 'Delete' })
  net.step(1, { kind: 'SetField', slot: 0, value: 707 })
  const gone = new Set(deleted(base, net.state(0)))
  if (gone.size === 0) throw new Error('Delete deleted no object')
  const edited = changes(net, 1, base).changed
  const merged = net.settle()
  const all = objects(merged)
  const back = [...gone].find((id) => Object.hasOwn(all, id))
  if (back !== undefined) throw new Error(`${back} was deleted on replica 0 but exists after the merge (delete must win over edit)`)
  expectRegisters(net.schema, merged, edited.filter((slot) => !gone.has(slot[0])), "replica 1's")
  return null
}

function duplicateDelete<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 21)
  const base = net.settle()
  net.step(0, { kind: 'Duplicate' })
  net.step(1, { kind: 'Delete' })
  if (created(base, net.state(0)).length === 0) throw new Error('Duplicate created no object')
  net.settle()
  return null
}

function undo<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 22)
  net.settle()
  net.step(0, { kind: 'SetField', slot: 0, value: 11 })
  const base = net.settle()
  net.step(1, { kind: 'SetField', slot: 0, value: 22 })
  net.step(1, { kind: 'SetField', slot: 1, value: 23 })
  const later = changes(net, 1, base).changed
  net.settle()
  if (!kit.undo(net.doc(0))) throw new Error('replica 0 had no step to undo after its edit')
  const merged = net.settle()
  expectRegisters(net.schema, merged, later, "replica 1's later")
  return null
}

function undoReconnect<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 23)
  net.settle()
  const start = net.state(0)
  net.step(0, { kind: 'SetField', slot: 1, value: 31 })
  const mine = changes(net, 0, start).changed
  const base = net.settle()
  // Offline: replica 1 edits, replica 0 undoes and redoes; nothing travels.
  net.step(1, { kind: 'SetField', slot: 0, value: 41 })
  const theirs = changes(net, 1, base).changed
  if (!kit.undo(net.doc(0))) throw new Error('replica 0 had no step to undo')
  if (!kit.redo(net.doc(0))) throw new Error('replica 0 had no step to redo after its undo')
  const merged = net.settle()
  expectRegisters(net.schema, merged, theirs, "replica 1's offline")
  expectRegisters(net.schema, merged, mine.filter((slot) => !theirs.has(slot)), "replica 0's redone")
  return null
}

/** One edit on a replica: a random command, falling back to a scripted one when the random pick did not apply. */
function edit<Doc>(net: Net<Doc>, index: number, salt: number): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const label = net.kit.randomEdit(net.doc(index), net.rng)
    if (label !== null) return label
  }
  if (net.script(index, { kind: 'SetField', slot: salt % 2, value: 9000 + salt })) return 'SetField'
  throw new Error('random_edit applied nothing in 8 tries and the adapter has no SetField')
}

/** The changes `index` made since `since`, and its new version. */
function increment<Doc>(net: Net<Doc>, index: number, since: Uint8Array): { bytes: Uint8Array; version: Uint8Array } {
  const doc = net.doc(index)
  const bytes = net.kit.exportChanges(doc, since)
  return { bytes, version: net.kit.version(doc) }
}

function delivery<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 3, 24)
  const count = net.docs.length
  const sent = net.docs.map((doc) => kit.version(doc))
  const pool: Uint8Array[] = []
  const blobs: Blobs = new Map()
  for (let round = 0; round < 4; round += 1) {
    for (let index = 0; index < count; index += 1) {
      edit(net, index, round * 10 + index)
      const { bytes, version } = increment(net, index, sent[index])
      pool.push(bytes)
      sent[index] = version
    }
    // Some causal chains: everything so far reaches everyone before the next edits.
    if (round === 1) net.sync()
  }
  net.sync()
  sent.forEach((since, index) => {
    pool.push(increment(net, index, since).bytes)
    for (const [hash, bytes] of blobsOf(kit, net.doc(index))) blobs.set(hash, bytes)
  })
  const referenceState = net.check()
  const reference = canonicalText(referenceState ?? null)
  // Two late replicas from the first snapshot: one takes the changes shuffled with duplicates, the
  // other in reverse, each twice in a row (a retry).
  const late: string[] = []
  for (let order = 0; order < 2; order += 1) {
    const doc = kit.join(net.initial.snapshot, net.initial.blobs)
    kit.addBlobs?.(doc, blobs)
    let messages = [...pool]
    if (order === 0) {
      net.rng.shuffle(messages)
      for (let copy = 0; copy < Math.floor(pool.length / 2); copy += 1) {
        const again = net.rng.below(messages.length)
        const bytes = messages[again] ?? new Uint8Array(0)
        messages.splice(net.rng.below(messages.length + 1), 0, bytes)
      }
    } else {
      messages.reverse()
      messages = messages.flatMap((bytes) => [bytes, bytes])
    }
    messages.forEach((bytes, step) => context(`late replica ${order} at message ${step}: `, () => kit.importChanges(doc, bytes)))
    const state = kit.state(doc)
    if (canonicalText(state ?? null) !== reference) {
      // Its own repairs of states the others never had are changes too: they must converge once exchanged.
      late.push(`late replica ${order} differs at ${firstDifference(referenceState, state) ?? ''} before exchanging its own changes`)
    }
    net.docs.push(doc)
  }
  try {
    net.settle()
  } catch (error) {
    throw new Error(late.length === 0 ? message(error) : `${message(error)} (${late.join('; ')})`)
  }
  return null
}

/** What a replica keeps on disk: the last saved snapshot, its blobs, and the changes committed since, appended at each commit (standard 2.0 P5). */
type Disk = { snapshot: Uint8Array; blobs: Blobs; log: Uint8Array[] }

function save<Doc>(kit: KitAdapter<Doc>, doc: Doc): Disk {
  return { snapshot: kit.snapshot(doc), blobs: blobsOf(kit, doc), log: [] }
}

/** The replica as reopened after a crash. */
function recover<Doc>(kit: KitAdapter<Doc>, disk: Disk): Doc {
  const doc = context('reopening the saved snapshot: ', () => kit.join(disk.snapshot, disk.blobs))
  disk.log.forEach((bytes, index) => context(`replaying logged commit ${index}: `, () => kit.importChanges(doc, bytes)))
  return doc
}

function crash<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 25)
  let disk: Disk = { snapshot: net.initial.snapshot, blobs: new Map(net.initial.blobs), log: [] }
  let since = kit.version(net.doc(0))
  for (let step = 0; step < 6; step += 1) {
    if (step === 2) {
      disk = save(kit, net.doc(0))
      since = kit.version(net.doc(0))
    }
    edit(net, 0, step)
    const { bytes, version } = increment(net, 0, since)
    disk.log.push(bytes)
    for (const [hash, blob] of blobsOf(kit, net.doc(0))) disk.blobs.set(hash, blob)
    since = version
  }
  const before = net.state(0)
  // The crash: replica 0 is gone before it pushed anything; it reopens from its disk.
  net.docs[0] = recover(kit, disk)
  const after = net.state(0)
  if (!sameValue(after, before)) throw new Error(`the recovered replica differs at ${firstDifference(before, after) ?? ''}`)
  const merged = net.settle()
  if (!sameValue(merged, before)) throw new Error(`the recovered changes did not reach the peer: ${firstDifference(before, merged) ?? ''}`)
  return null
}

function blobHashes(schema: SchemaInfo, state: unknown): string[] {
  const out = new Set<string>()
  for (const object of Object.values(objects(state))) {
    const record = object as Record<string, unknown>
    for (const [name, field] of schema.fieldsOf(typeof record.$type === 'string' ? record.$type : '')) {
      const value = record[name] as Record<string, unknown> | null | undefined
      if (field.kind === 'blob' && value && typeof value === 'object' && typeof value.hash === 'string') out.add(value.hash)
    }
  }
  return [...out].sort(compareStrings)
}

function blobsLate<Doc>(kit: KitAdapter<Doc>): Body {
  const net = new Net(kit, 2, 26)
  net.settle()
  const beforeB = net.state(1)
  net.step(0, { kind: 'InsertBlob', seed: 7 })
  const aState = net.state(0)
  const since = kit.version(net.doc(1))
  const bytes = kit.exportChanges(net.doc(0), since)
  // The changes arrive, the blobs do not (yet).
  let early: unknown = null
  try {
    kit.importChanges(net.doc(1), bytes)
  } catch (error) {
    early = error
  }
  const bState = net.state(1)
  if (early === null && !sameValue(bState, aState)) {
    throw new Error(`changes imported without their blobs differ at ${firstDifference(aState, bState) ?? ''}`)
  }
  if (early !== null && !sameValue(bState, beforeB)) throw new Error('a refused import without blobs changed the replica')
  // An edit meanwhile must not corrupt anything either.
  edit(net, 1, 1)
  kit.addBlobs?.(net.doc(1), blobsOf(kit, net.doc(0)))
  context('importing again once the blobs arrived: ', () => kit.importChanges(net.doc(1), bytes))
  const merged = net.settle()
  const held = blobsOf(kit, net.doc(1))
  if (held.size > 0) {
    const missing = blobHashes(net.schema, merged).find((hash) => !held.has(hash))
    if (missing !== undefined) throw new Error(`replica 1 references blob ${missing} it does not hold once the blobs arrived`)
  }
  for (let index = 0; index < 2; index += 1) context(`replica ${index} cannot save after the late blobs: `, () => kit.exportFile?.(net.doc(index)))
  return null
}

/** One message in flight: changes and the blobs they may need. */
type Message = { bytes: Uint8Array; blobs: Blobs }

function fuzz<Doc>(kit: KitAdapter<Doc>, options: Options): Body {
  for (const count of options.replicas) {
    for (const seed of options.seeds) context(`${count} replicas, seed ${seed}: `, () => fuzzOnce(kit, count, seed, options.steps))
  }
  return null
}

function fuzzOnce<Doc>(kit: KitAdapter<Doc>, count: number, seed: number, steps: number): void {
  const net = new Net(kit, count, seed)
  const sent = net.docs.map((doc) => kit.version(doc))
  const disks: Disk[] = net.docs.map(() => ({ snapshot: net.initial.snapshot, blobs: new Map(net.initial.blobs), log: [] }))
  const inbox: Message[][] = net.docs.map(() => [])
  const log: string[] = []
  const trail = () => log.slice(-12).join(', ')
  for (let step = 0; step < steps; step += 1) {
    const index = net.rng.below(count)
    const roll = net.rng.below(100)
    const label = context(`step ${step} on replica ${index}: `, () => {
      try {
        return fuzzStep(net, index, roll, step, sent, disks, inbox)
      } catch (error) {
        throw new Error(`${message(error)}; after ${trail()}`)
      }
    })
    log.push(`${index}:${label}`)
    // Commit: what the replica has that it has not sent goes to its disk log and to everyone.
    const since = sent[index]
    const { bytes, version } = increment(net, index, since)
    if (!bytesEqual(version, since)) {
      const blobs = blobsOf(kit, net.doc(index))
      disks[index].log.push(bytes)
      for (const [hash, blob] of blobs) disks[index].blobs.set(hash, blob)
      inbox.forEach((queue, to) => {
        if (to !== index) queue.push({ bytes, blobs })
      })
      sent[index] = version
    }
  }
  // Everything still in flight arrives, in a shuffled order, then the replicas reconnect.
  inbox.forEach((queue, index) => {
    net.rng.shuffle(queue)
    for (const delivered of queue.splice(0)) {
      const doc = net.doc(index)
      kit.addBlobs?.(doc, delivered.blobs)
      context(`final delivery to replica ${index}: `, () => {
        try {
          kit.importChanges(doc, delivered.bytes)
        } catch (error) {
          throw new Error(`${message(error)}; after ${trail()}`)
        }
      })
    }
  })
  try {
    net.settle()
  } catch (error) {
    throw new Error(`${message(error)}; after ${trail()}`)
  }
}

function fuzzStep<Doc>(net: Net<Doc>, index: number, roll: number, step: number, sent: Uint8Array[], disks: Disk[], inbox: Message[][]): string {
  const { kit } = net
  if (roll < 55) return edit(net, index, step)
  if (roll < 62) return `undo=${kit.undo(net.doc(index))}`
  if (roll < 67) return `redo=${kit.redo(net.doc(index))}`
  if (roll < 90) {
    const queue = inbox[index]
    if (queue.length === 0) return 'idle'
    const at = net.rng.below(queue.length)
    // Sometimes the message stays queued: it arrives again later (a duplicate).
    const delivered = net.rng.chance(20) ? queue[at] : queue.splice(at, 1)[0]
    const doc = net.doc(index)
    kit.addBlobs?.(doc, delivered.blobs)
    kit.importChanges(doc, delivered.bytes)
    return 'deliver'
  }
  if (roll < 95) {
    // Every commit was sent already, so the disk's log restarts from here.
    disks[index] = save(kit, net.doc(index))
    return 'save'
  }
  const before = net.state(index)
  net.docs[index] = recover(kit, disks[index])
  const after = net.state(index)
  if (!sameValue(after, before)) throw new Error(`the recovered replica differs at ${firstDifference(before, after) ?? ''}`)
  sent[index] = kit.version(net.doc(index))
  return 'crash'
}
