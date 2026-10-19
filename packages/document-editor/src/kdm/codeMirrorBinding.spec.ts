import { ChangeSet, EditorState, Text, type ChangeSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, Network, person, Replica, Rng, Tx, type Origin, type TextDelta } from '@kition/kdm'
import { buildTableMarkdown, type TableModel } from '../editor/extensions/table-widget'
import { applyChangeSet, deltaToChanges, replicaChange, TextBinding } from './codeMirrorBinding'
import { mergeExternalText } from './documentMerge'
import { DOCUMENT_BODY, DOCUMENT_ROOT, documentSchema } from './documentSchema'
import { createDocumentReplica } from './documentText'

/** CJK text (U+5B63 U+5EA6), as a named constant: the repository keeps non-English text out of source files. */
const QUARTER = String.fromCodePoint(0x5b63, 0x5ea6)
const SEASON = String.fromCodePoint(0x5b63)
/** A hiragana character (U+306E), as an IME would compose it. */
const NO = String.fromCodePoint(0x306e)

const me = person('user:a')

/** Applies `changes` (relative to the replica's text) through `applyChangeSet`; answers the deltas the replica reported. */
function applyAndWatch(replica: Replica, rootId: string, changes: ChangeSpec, withBefore = true) {
  const before = Text.of(replica.text(rootId, DOCUMENT_BODY).split('\n'))
  const set = ChangeSet.of(changes, before.length)
  const deltas: TextDelta[][] = []
  const unsubscribe = replica.subscribeText(rootId, DOCUMENT_BODY, (delta) => deltas.push(delta))
  replica.transact(me, (tx) => applyChangeSet(tx, rootId, DOCUMENT_BODY, set, withBefore ? before : undefined))
  unsubscribe()
  expect(replica.text(rootId, DOCUMENT_BODY)).toBe(set.apply(before).toString())
  return deltas.flat()
}

/** The deletions and insertions of a delta, with their positions in the text before it. */
function edits(delta: TextDelta[]) {
  const out: Array<{ at: number; delete?: number; insert?: string }> = []
  let at = 0
  for (const op of delta) {
    if ('retain' in op) at += op.retain
    else if ('delete' in op) {
      out.push({ at, delete: op.delete })
      at += op.delete
    } else out.push({ at, insert: op.insert })
  }
  return out
}

describe('applyChangeSet', () => {
  it('applies a multi-range change set in one transaction', () => {
    const { replica, rootId } = createDocumentReplica('Hello world', 1n)
    applyAndWatch(replica, rootId, [{ from: 0, to: 1, insert: 'J' }, { from: 5, insert: ` ${QUARTER}😀` }, { from: 11, insert: '!' }])
    expect(replica.text(rootId, DOCUMENT_BODY)).toBe(`Jello ${QUARTER}😀 world!`)
  })

  it('makes a whole-document replace that changes one word one small edit', () => {
    const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} has the quick brown fox in it.`).join('\n')
    const { replica, rootId } = createDocumentReplica(text, 1n)
    const next = text.replace('Paragraph 120 has the quick brown', 'Paragraph 120 has the quick red')
    const delta = applyAndWatch(replica, rootId, { from: 0, to: text.length, insert: next })
    const at = text.indexOf('brown', text.indexOf('Paragraph 120'))
    expect(edits(delta)).toHaveLength(2)
    const removed = edits(delta).filter((op) => op.delete).reduce((sum, op) => sum + op.delete!, 0)
    const inserted = edits(delta).filter((op) => op.insert).map((op) => op.insert).join('')
    expect(removed).toBe(5)
    expect(inserted).toBe('red')
    expect(edits(delta)[0].at).toBe(at)
  })

  it('minimises without being given the text before', () => {
    const { replica, rootId } = createDocumentReplica('one two three', 1n)
    const delta = applyAndWatch(replica, rootId, { from: 0, to: 13, insert: 'one 2 three' }, false)
    expect(edits(delta)).toEqual([
      { at: 4, delete: 3 },
      { at: 7, insert: '2' },
    ])
  })

  it('makes a table re-serialisation that changes one cell touch only that cell', () => {
    const model = (cell: string): TableModel => ({
      tableFrom: 0,
      tableTo: 0,
      headers: [{ text: 'Name' }, { text: 'Owner' }],
      aligns: [null, 'right'],
      rows: [
        [{ text: 'Plan' }, { text: 'Ana' }],
        [{ text: QUARTER }, { text: cell }],
        [{ text: 'Ship 😀' }, { text: 'Bo' }],
      ],
    })
    const table = buildTableMarkdown(model('Kim'))
    const text = `# Doc\n\n${table}\n\nAfter.\n`
    const { replica, rootId } = createDocumentReplica(text, 1n)
    const from = text.indexOf(table)
    const delta = applyAndWatch(replica, rootId, { from, to: from + table.length, insert: buildTableMarkdown(model('Kimberly')) })
    const cellEnd = text.indexOf('Kim') + 3
    expect(edits(delta)).toEqual([{ at: cellEnd, insert: 'berly' }])
  })

  it('keeps the unchanged lines of a table whose formatting is normalised', () => {
    const text = '| a | b |\n|---|---:|\n| 1 | 2 |\n| x | y |\n'
    const { replica, rootId } = createDocumentReplica(text, 1n)
    const next = '| a | b |\n|---|---:|\n| 1 | 2 |\n| x | why |\n'.replace('|---|---:|', '| --- | ---: |')
    const delta = applyAndWatch(replica, rootId, { from: 0, to: text.length, insert: next })
    const ops = edits(delta)
    // ' ' and ' | ' and ' ' in the delimiter row, 'wh' before the 'y' of the last row.
    expect(ops.reduce((sum, op) => sum + (op.delete ?? 0), 0)).toBe(1)
    expect(ops.map((op) => op.insert ?? '').join('')).toBe('  |  wh')
    expect(Math.min(...ops.map((op) => op.at))).toBe(text.indexOf('|---') + 1)
  })

  it('never splits a surrogate pair', () => {
    const { replica, rootId } = createDocumentReplica('a😀b', 1n)
    const delta = applyAndWatch(replica, rootId, { from: 0, to: 4, insert: 'a😁b' })
    expect(edits(delta)).toEqual([
      { at: 1, delete: 2 },
      { at: 3, insert: '😁' },
    ])
  })

  it('leaves the text alone for a replace with the same text', () => {
    const { replica, rootId } = createDocumentReplica('same', 1n)
    const before = replica.version()
    replica.transact(me, (tx) => applyChangeSet(tx, rootId, DOCUMENT_BODY, ChangeSet.of({ from: 0, to: 4, insert: 'same' }, 4)))
    expect(replica.version().equals(before)).toBe(true)
  })

  it('refuses changes of another length', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    expect(() => replica.transact(me, (tx) => applyChangeSet(tx, rootId, DOCUMENT_BODY, ChangeSet.of({ from: 0, insert: 'x' }, 2)))).toThrow(/code units/)
  })

  it('reproduces random change sets exactly (property)', () => {
    const rng = new Rng(31)
    const pieces = ['a', 'b', '\n', SEASON, '😀', '👍', '| x |']
    const piece = () => pieces[rng.below(pieces.length)]
    const { replica, rootId } = createDocumentReplica('start\n', 1n)
    for (let run = 0; run < 300; run += 1) {
      const text = replica.text(rootId, DOCUMENT_BODY)
      const points = Array.from(text)
      const offsets = [0]
      for (const point of points) offsets.push(offsets[offsets.length - 1] + point.length)
      const specs: ChangeSpec[] = []
      let at = 0
      for (let count = rng.below(3) + 1; count > 0 && at <= points.length; count -= 1) {
        at += rng.below(points.length - at + 1)
        const end = Math.min(points.length, at + rng.below(6))
        const insert = Array.from({ length: rng.below(5) }, piece).join('')
        specs.push({ from: offsets[at], to: offsets[end], insert: rng.below(4) === 0 ? text.slice(offsets[at], offsets[end]) + insert : insert })
        at = end + 1
      }
      applyAndWatch(replica, rootId, specs, rng.below(2) === 0)
    }
  })
})

describe('deltaToChanges', () => {
  it('turns a delta into change specs relative to the text before it', () => {
    expect(deltaToChanges([{ retain: 2 }, { delete: 3 }, { insert: 'x' }, { retain: 1 }, { insert: 'y' }])).toEqual([
      { from: 2, to: 5 },
      { from: 5, insert: 'x' },
      { from: 6, insert: 'y' },
    ])
  })
})

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  vi.restoreAllMocks()
})

/** An editor bound to one replica's body, mounted in the document like the app's. */
function editor(replica: Replica, rootId: string, origin: Origin = me, doc = replica.text(rootId, DOCUMENT_BODY)) {
  const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, origin)
  const seen: Array<{ remote: boolean; text: string }> = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [binding.extension, EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (tr.docChanged) seen.push({ remote: tr.annotation(replicaChange) === true, text: tr.newDoc.toString() })
      })],
    }),
    parent: document.body,
  })
  views.push(view)
  const type = (changes: ChangeSpec) => view.dispatch({ changes, userEvent: 'input.type' })
  return { binding, view, seen, type, text: () => view.state.doc.toString() }
}

/** Two replicas of one document, synced, each with an editor. */
function pair(seed: number, text = '') {
  const net = new Network(documentSchema, 2, seed)
  const rootId = net.replicas[0].transact(me, (tx) => {
    const id = tx.create(DOCUMENT_ROOT, {})
    if (text) tx.textInsert(id, DOCUMENT_BODY, 0, text)
    return id
  })
  net.syncAll()
  return { net, rootId, a: editor(net.replicas[0], rootId), b: editor(net.replicas[1], rootId, person('user:b')) }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('TextBinding: local and remote changes', () => {
  it('shows one person’s typing in the other editor', () => {
    const { net, rootId, a, b } = pair(1)
    a.type({ from: 0, insert: '# Plan\n' })
    net.syncAll()
    expect(b.text()).toBe('# Plan\n')
    expect(net.replicas[1].text(rootId, DOCUMENT_BODY)).toBe(b.text())
  })

  it('publishes one local transaction as one KDM transaction with the binding’s origin', () => {
    const { replica, rootId } = createDocumentReplica('ab', 1n)
    const ed = editor(replica, rootId, person('user:me', 'typing'))
    const transact = vi.spyOn(replica, 'transact')
    ed.type([{ from: 0, insert: 'x' }, { from: 2, insert: 'y' }])
    expect(transact).toHaveBeenCalledTimes(1)
    expect(transact.mock.calls[0][0]).toEqual(person('user:me', 'typing'))
    expect(replica.text(rootId, DOCUMENT_BODY)).toBe('xaby')
    expect(replica.canUndo()).toBe(true)
  })

  it('converges concurrent multi-change transactions with CJK and emoji', () => {
    const { net, rootId, a, b } = pair(2, 'Hello world')
    a.type({ from: 5, insert: ` ${QUARTER}😀` })
    b.type([{ from: 0, to: 1, insert: 'J' }, { from: 11, insert: '!' }])
    net.syncAll()
    net.converged()
    expect(a.text()).toBe(`Jello ${QUARTER}😀 world!`)
    expect(b.text()).toBe(a.text())
    expect(net.replicas[0].text(rootId, DOCUMENT_BODY)).toBe(a.text())
  })

  it('applies remote changes annotated, without publishing them again', () => {
    const { net, a, b } = pair(3)
    a.type({ from: 0, insert: 'abc' })
    const before = net.replicas[1].version()
    net.deliver(0, 1)
    const after = net.replicas[1].version()
    expect(b.text()).toBe('abc')
    expect(b.seen).toEqual([{ remote: true, text: 'abc' }])
    expect(a.seen).toEqual([{ remote: false, text: 'abc' }])
    net.syncAll()
    expect(net.replicas[1].version().equals(after)).toBe(true)
    expect(after.equals(before)).toBe(false)
  })

  it('undoes a person’s own typing only, and both editors show it', () => {
    const { net, rootId, a, b } = pair(4)
    a.type({ from: 0, insert: 'mine ' })
    net.syncAll()
    b.type({ from: 5, insert: 'theirs' })
    net.syncAll()
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    expect(net.replicas[1].text(rootId, DOCUMENT_BODY)).toBe('theirs')
    expect(a.text()).toBe('theirs')
    expect(b.text()).toBe('theirs')
    expect(a.seen.at(-1)).toEqual({ remote: true, text: 'theirs' })
  })

  it('shows agent edits and merged file changes made on the same replica', () => {
    const { replica, rootId } = createDocumentReplica('line one\nline two\n', 1n)
    const ed = editor(replica, rootId)
    ed.type({ from: 0, insert: '# ' })
    replica.transact(agent('agent:writer'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, tx.textLength(rootId, DOCUMENT_BODY), 'agent line\n'))
    expect(ed.text()).toBe('# line one\nline two\nagent line\n')
    const current = replica.text(rootId, DOCUMENT_BODY)
    replica.transact({ kind: 'import', principal: 'file' }, (tx) => mergeExternalText(tx, rootId, 'line one\nline two\n', 'line one\nline 2\n', current))
    expect(ed.text()).toBe('# line one\nline 2\nagent line\n')
    expect(ed.seen.map((entry) => entry.remote)).toEqual([false, true, true])
  })

  it('keeps editors and replicas equal under random concurrent edits (property)', () => {
    const rng = new Rng(41)
    const pieces = ['a', ' ', '\n', QUARTER, '😀', '👍']
    const { net, rootId, a, b } = pair(5, 'seed text\n')
    const randomEdit = (text: string): ChangeSpec => {
      const points = Array.from(text)
      const at = rng.below(points.length + 1)
      const end = Math.min(points.length, at + rng.below(3))
      const offset = (index: number) => points.slice(0, index).join('').length
      return { from: offset(at), to: offset(end), insert: Array.from({ length: rng.below(3) }, () => pieces[rng.below(pieces.length)]).join('') }
    }
    for (let round = 0; round < 120; round += 1) {
      const target = rng.below(3)
      if (target === 0) a.type(randomEdit(a.text()))
      else if (target === 1) b.type(randomEdit(b.text()))
      else if (net.replicas[1].canUndo()) net.replicas[1].undo()
      if (rng.below(3) === 0) net.syncAll()
      expect(a.text()).toBe(net.replicas[0].text(rootId, DOCUMENT_BODY))
      expect(b.text()).toBe(net.replicas[1].text(rootId, DOCUMENT_BODY))
    }
    net.syncAll()
    expect(a.text()).toBe(b.text())
  })
})

describe('TextBinding: composition', () => {
  const compositionStart = (view: EditorView) => view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }))
  const compositionEnd = (view: EditorView) => view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }))

  it('applies changes that arrive during composition after it ends, in order', async () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    const ed = editor(replica, rootId)
    compositionStart(ed.view)
    expect(ed.view.compositionStarted).toBe(true)
    replica.transact(agent('agent:x'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, 0, 'X'))
    replica.transact(agent('agent:x'), (tx) => tx.textDelete(rootId, DOCUMENT_BODY, 1, 1))
    expect(ed.text()).toBe('abc')
    // The person's composed text lands where they typed it, in the replica too.
    ed.type({ from: 3, insert: NO })
    expect(replica.text(rootId, DOCUMENT_BODY)).toBe(`Xbc${NO}`)
    expect(ed.text()).toBe(`abc${NO}`)
    compositionEnd(ed.view)
    await nextTask()
    expect(ed.text()).toBe(`Xbc${NO}`)
    expect(ed.seen.map((entry) => entry.remote)).toEqual([false, true])
  })

  it('maps composed text typed inside text a remote change deleted', async () => {
    const { replica, rootId } = createDocumentReplica('hello world', 1n)
    const ed = editor(replica, rootId)
    compositionStart(ed.view)
    replica.transact(agent('agent:x'), (tx) => tx.textDelete(rootId, DOCUMENT_BODY, 0, 6))
    ed.type({ from: 2, insert: SEASON })
    compositionEnd(ed.view)
    await nextTask()
    expect(ed.text()).toBe(replica.text(rootId, DOCUMENT_BODY))
    expect(ed.text()).toBe(`${SEASON}world`)
  })
})

describe('TextBinding: lifecycle', () => {
  it('resets an editor that mounts with other text to the replica text', async () => {
    const { replica, rootId } = createDocumentReplica('replica text', 1n)
    const ed = editor(replica, rootId, me, 'stale draft')
    await nextTask()
    expect(ed.text()).toBe('replica text')
    expect(replica.text(rootId, DOCUMENT_BODY)).toBe('replica text')
  })

  it('re-attaches to a remounted editor and follows the replica again', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, me)
    const mount = () => {
      const view = new EditorView({ state: EditorState.create({ doc: replica.text(rootId, DOCUMENT_BODY), extensions: [binding.extension] }), parent: document.body })
      views.push(view)
      return view
    }
    const first = mount()
    first.dispatch({ changes: { from: 3, insert: 'd' } })
    first.destroy()
    replica.transact(agent('agent:x'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, 0, '>'))
    const second = mount()
    expect(second.state.doc.toString()).toBe('>abcd')
    // The history lives in the replica: undo reaches back past the remount.
    replica.undo()
    expect(second.state.doc.toString()).toBe('abcd')
    replica.undo()
    expect(second.state.doc.toString()).toBe('abc')
  })

  it('refuses a second editor at the same time', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, me)
    views.push(new EditorView({ state: EditorState.create({ doc: 'abc', extensions: [binding.extension] }), parent: document.body }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const second = new EditorView({ state: EditorState.create({ doc: 'abc', extensions: [binding.extension] }), parent: document.body })
    views.push(second)
    // CodeMirror reports a plugin that fails to start and runs without it.
    expect(errors).toHaveBeenCalled()
    replica.transact(agent('agent:x'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, 0, '>'))
    expect(second.state.doc.toString()).toBe('abc')
  })

  it('stops following the replica once disposed', () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    const ed = editor(replica, rootId)
    ed.binding.dispose()
    replica.transact(agent('agent:x'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, 0, '>'))
    expect(ed.text()).toBe('abc')
  })

  it('resets the editor when a local change cannot be published', async () => {
    const { replica, rootId } = createDocumentReplica('abc', 1n)
    const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, me, { onError: vi.fn() })
    const view = new EditorView({ state: EditorState.create({ doc: 'abc', extensions: [binding.extension] }), parent: document.body })
    views.push(view)
    vi.spyOn(Tx.prototype, 'textInsert').mockImplementationOnce(() => {
      throw new Error('refused')
    })
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(view.state.doc.toString()).toBe('xabc')
    await nextTask()
    expect(view.state.doc.toString()).toBe('abc')
  })
})
